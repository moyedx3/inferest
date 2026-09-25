import { wrapFetchWithPayment } from "x402-fetch";
import { selectPaymentRequirements } from "x402/client";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
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

/** Real x402 payments in USDC on Base from our tool wallet, capped per call. */
export function x402PayingFetch(privateKey: `0x${string}`): PayingFetchFactory {
  const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: base, transport: http() });
  return (maxMicro, onAmount) =>
    wrapFetchWithPayment(fetch, wallet as any, maxMicro, (reqs: any, network: any, scheme: any) => {
      const chosen = selectPaymentRequirements(reqs, network, scheme);
      const amount = BigInt(chosen.maxAmountRequired);
      // x402-fetch checks the cap after this selector and throws unsigned; report only amounts it will sign
      if (amount <= maxMicro) onAmount(amount);
      return chosen;
    }) as unknown as typeof fetch;
}
