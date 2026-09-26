import type { SettleResult } from "./keeper.ts";

/** The server's answer to POST /api/admin/settle, as the CLI shows it. */
export type RemoteSettle = { usageMicro: string | null; tx: string | null; pending: boolean };

/**
 * Asks a running Inferest server to settle the vault, so the drain and the snapshot run in the process that
 * holds the in-flight requests. Resolves undefined when no server answers at the base URL (connection refused
 * or a network error), so the caller can settle in-process instead. Any HTTP answer other than 200 is an error.
 */
export async function settleThroughServer(base: string, adminToken: string, vault: string, fetchFn: typeof fetch = fetch): Promise<RemoteSettle | undefined> {
  let res: Response;
  try {
    res = await fetchFn(`${base.replace(/\/+$/, "")}/api/admin/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ vault }),
    });
  } catch {
    return undefined;
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`server refused the settlement: ${res.status} ${body.error ?? ""}`.trim());
  return { usageMicro: body.usageMicro ?? null, tx: body.tx ?? null, pending: body.pending === true };
}

export function describeSettle(r: RemoteSettle | SettleResult | null): string {
  if (!r) return "nothing settled";
  const usage = "usage" in r ? r.usage.toString() : r.usageMicro;
  return `${r.pending ? "pending" : "settled"} ${usage ?? "?"} micro-USD in ${r.tx ?? "?"}`;
}
