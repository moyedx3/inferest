export type OrKey = { hash: string; usage: number; limit: number | null; disabled: boolean };
export type OpenRouter = {
  createKey(name: string, limit: number): Promise<{ key: string; hash: string }>;
  getKey(hash: string): Promise<OrKey>;
  setLimit(hash: string, limit: number): Promise<void>;
};

export function openRouter(managementKey: string, fetchFn: typeof fetch = fetch, base = "https://openrouter.ai/api/v1"): OpenRouter {
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenRouter ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  const toKey = (d: any): OrKey => ({
    hash: String(d.hash), usage: Number(d.usage ?? 0), limit: d.limit ?? null, disabled: Boolean(d.disabled),
  });
  return {
    async createKey(name, limit) {
      const r = await call("POST", "/keys", { name, limit, include_byok_in_limit: true });
      return { key: String(r.key), hash: String(r.data.hash) };
    },
    async getKey(hash) {
      return toKey((await call("GET", `/keys/${hash}`)).data);
    },
    async setLimit(hash, limit) {
      await call("PATCH", `/keys/${hash}`, { limit });
    },
  };
}
