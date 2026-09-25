import { wrapFetchWithPayment } from "x402-fetch";
import { selectPaymentRequirements } from "x402/client";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export type PayingFetchFactory = (maxMicro: bigint, onAmount: (micro: bigint) => void) => typeof fetch;
export type ToolHit = { api: string; path: string; method: string; description: string; priceUsd: number };
export type ToolCall = { api: string; path: string; method?: string; body?: unknown; query?: Record<string, string> };

export class BudgetExhausted extends Error {}

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
      let charged = 0n;
      const pay = d.makePayingFetch(BigInt(Math.floor(budget * 1e6)), (m) => { charged = m; });
      const method = (call.method ?? (call.body === undefined ? "GET" : "POST")).toUpperCase();
      const qs = call.query ? `?${new URLSearchParams(call.query)}` : "";
      const res = await pay(`${X402_BASE}/${call.api}${call.path}${qs}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: call.body === undefined || method === "GET" ? undefined : JSON.stringify(call.body),
      });
      if (!res.ok) throw new Error(`tool ${call.api}${call.path} failed: ${res.status} ${await res.text()}`);
      if (charged > 0n) d.record(keyHash, call.api, call.path, Number(charged) / 1e6);
      return res.json();
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
      onAmount(BigInt(chosen.maxAmountRequired));
      return chosen;
    }) as unknown as typeof fetch;
}
