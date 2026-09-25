import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

export type PayingFetchFactory = (maxMicro: bigint, onAmount: (micro: bigint) => void) => typeof fetch;
export type ToolHit = { api: string; path: string; method: string; description: string; priceUsd: number };
export type ToolCall = { api: string; path: string; method?: string; body?: unknown; query?: Record<string, string> };

export class BudgetExhausted extends Error {}

/** A paid call that failed after its payment was signed. `charged` is in USD and has been recorded. */
export class ToolCallFailed extends Error {
  charged: number;
  constructor(message: string, charged: number) {
    super(message);
    this.name = "ToolCallFailed";
    this.charged = charged;
  }
}

const SEARCH_URL = "https://api.orthogonal.com/v1/search";
const DETAILS_URL = "https://api.orthogonal.com/v1/details";
const X402_BASE = "https://x402.orthogonal.com";
const API_SLUG = /^[a-z0-9-]+$/i;
const PATH = /^\/[A-Za-z0-9\-._~/]*$/;

export function toolGateway(d: {
  orthogonalKey: string;
  fetchFn: typeof fetch;
  makePayingFetch: PayingFetchFactory;
  budgetUsd: (keyHash: string) => number;
  record: (keyHash: string, api: string, path: string, priceUsd: number) => void;
}) {
  // micro USDC held by in-flight runs, per key, so parallel runs share one budget
  const reserved = new Map<string, bigint>();
  const reservedFor = (h: string) => reserved.get(h) ?? 0n;
  const hold = (h: string, delta: bigint) => {
    const next = reservedFor(h) + delta;
    if (next > 0n) reserved.set(h, next);
    else reserved.delete(h);
  };

  return {
    async search(prompt: string, limit = 10): Promise<ToolHit[]> {
      const res = await d.fetchFn(SEARCH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${d.orthogonalKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, limit }),
      });
      if (!res.ok) throw new Error(`Orthogonal search failed: ${res.status}`);
      const j: any = await res.json();
      return (j.results ?? []).flatMap((api: any) =>
        (api.endpoints ?? [])
          .filter((e: any) => e.isPayable !== false)
          .map((e: any) => ({
            api: String(api.slug), path: String(e.path), method: String(e.method ?? "POST"),
            description: String(e.description ?? ""), priceUsd: Number(e.price ?? 0),
          })),
      );
    },

    async details(api: string, path: string): Promise<unknown> {
      if (!API_SLUG.test(api) || !PATH.test(path) || path.includes("..")) throw new Error(`invalid tool ${api}${path}`);
      const res = await d.fetchFn(DETAILS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${d.orthogonalKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ api, path }),
      });
      if (!res.ok) throw new Error(`Orthogonal details failed: ${res.status}`);
      return res.json();
    },

    /** One attempt only. A failed or ambiguous paid call is never retried here: the caller checks usage first. */
    async run(keyHash: string, call: ToolCall): Promise<unknown> {
      if (!API_SLUG.test(call.api) || !PATH.test(call.path) || call.path.includes("..")) {
        throw new Error(`invalid tool ${call.api}${call.path}`);
      }
      const budget = d.budgetUsd(keyHash);
      if (!(budget > 0)) throw new BudgetExhausted("no yield left for tools on this key");
      const available = BigInt(Math.floor(budget * 1e6)) - reservedFor(keyHash);
      if (available <= 0n) throw new BudgetExhausted("this key's tool budget is held by calls in flight");
      let held = available;
      hold(keyHash, held);
      try {
        let charged = 0n;
        const pay = d.makePayingFetch(available, (m) => {
          charged = m;
          hold(keyHash, m - held);
          held = m;
        });
        const method = (call.method ?? (call.body === undefined ? "GET" : "POST")).toUpperCase();
        const qs = call.query ? `?${new URLSearchParams(call.query)}` : "";
        const tool = `${call.api}${call.path}`;
        const failedAfterPayment = (reason: string) => {
          const usd = Number(charged) / 1e6;
          d.record(keyHash, call.api, call.path, usd);
          return new ToolCallFailed(`tool ${tool} failed after a payment of $${usd} was signed (${reason}); check usage before retrying`, usd);
        };
        let res: Response;
        try {
          res = await pay(`${X402_BASE}/${call.api}${call.path}${qs}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: call.body === undefined || method === "GET" ? undefined : JSON.stringify(call.body),
          });
        } catch (e) {
          if (charged > 0n) throw failedAfterPayment((e as Error).message);
          throw e;
        }
        if (!res.ok) {
          const text = await res.text();
          // a 402 to the paid replay means the processor rejected the payment and nothing settled
          if (charged > 0n && res.status === 402) {
            throw new Error(`tool ${tool}: payment rejected, nothing charged (${rejectionReason(res, text)})`);
          }
          if (charged > 0n) throw failedAfterPayment(`${res.status} ${text}`);
          throw new Error(`tool ${tool} failed: ${res.status} ${text}`);
        }
        if (charged > 0n) d.record(keyHash, call.api, call.path, Number(charged) / 1e6);
        return await res.json();
      } finally {
        hold(keyHash, -held);
      }
    },
  };
}

export type ToolGateway = ReturnType<typeof toolGateway>;

/** The reason an x402 server gives for refusing a payment: the decoded `payment-required` header, else the body. */
function rejectionReason(res: Response, body: string): string {
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      const j: any = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      const parts: string[] = [];
      for (const k of ["error", "reason", "invalidReason", "errorReason"]) {
        if (typeof j?.[k] === "string" && j[k]) parts.push(j[k]);
      }
      // processors often embed their own JSON error inside the message
      const nested = parts.join(" ").match(/\{.*\}/s)?.[0];
      if (nested) {
        try {
          const n = JSON.parse(nested);
          const m = n?.errorMessage ?? n?.message ?? n?.reason;
          if (typeof m === "string" && !parts.some((p) => p.includes(m))) parts.push(m);
        } catch {}
      }
      if (parts.length) return parts.join(": ");
    } catch {}
  }
  return body || "no reason given";
}

const BASE_NETWORK = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Real x402 (protocol version 2) payments in USDC on Base from our tool wallet, capped per call. */
/** Coinbase's facilitator rejects a payment whose echoed resource description is longer than about 255 characters
 *  (serper and joinmassive publish 550-character descriptions). The description is informational and outside
 *  the signature, so the client shortens it before the payload is built. Mutates in place. */
export function capResourceDescription(paymentRequired: { resource?: { description?: string } }, max = 255): void {
  const r = paymentRequired.resource;
  if (r && typeof r.description === "string" && r.description.length > max) r.description = r.description.slice(0, max);
}

export function x402PayingFetch(privateKey: `0x${string}`): PayingFetchFactory {
  const scheme = new ExactEvmScheme(privateKeyToAccount(privateKey));
  return (maxMicro, onAmount) => {
    const client = new x402Client()
      .register(BASE_NETWORK, scheme)
      .setSpendControls(false) // the cap below is the key's remaining budget, not the library's default $1
      .registerPolicy((_version, reqs) =>
        reqs.filter((r) => r.scheme === "exact" && r.network === BASE_NETWORK && r.asset.toLowerCase() === BASE_USDC.toLowerCase()),
      )
      .onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
        capResourceDescription(paymentRequired);
        const amount = BigInt(selectedRequirements.amount);
        // this hook runs before signing; abort here so a rejected cap never reaches the scheme client
        if (amount > maxMicro) return { abort: true, reason: `price ${amount} exceeds the cap of ${maxMicro} micro USDC` };
      })
      .onAfterPaymentCreation(async ({ selectedRequirements }) => {
        // this hook runs only once the scheme has signed the payload, so a reported amount was actually signed;
        // reporting it here (rather than in onBeforePaymentCreation) means a signing failure never records a spend
        onAmount(BigInt(selectedRequirements.amount));
      });
    return wrapFetchWithPayment(fetch, client) as typeof fetch;
  };
}
