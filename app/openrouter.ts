export type OrKey = { hash: string; usage: number; limit: number | null; disabled: boolean };
/** One completed request as OpenRouter accounts for it. */
export type Generation = { id: string; model: string; totalCost: number };
export type OpenRouter = {
  createKey(name: string, limit: number): Promise<{ key: string; hash: string }>;
  getKey(hash: string): Promise<OrKey>;
  setLimit(hash: string, limit: number): Promise<void>;
  deleteKey(hash: string): Promise<void>;
  /** Cost of one generation, read with the API key that made it. Undefined while OpenRouter has not indexed it. */
  getGeneration(id: string, apiKey: string): Promise<Generation | undefined>;
};

export function openRouter(managementKey: string, fetchFn: typeof fetch = fetch, base = "https://openrouter.ai/api/v1"): OpenRouter {
  async function request(method: string, path: string, bearer: string, body?: unknown): Promise<Response> {
    return fetchFn(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await request(method, path, managementKey, body);
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
    async deleteKey(hash) {
      await call("DELETE", `/keys/${hash}`);
    },
    async getGeneration(id, apiKey) {
      const res = await request("GET", `/generation?id=${encodeURIComponent(id)}`, apiKey);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`OpenRouter GET /generation failed: ${res.status} ${await res.text()}`);
      const d = (await res.json()).data ?? {};
      // no numeric cost yet: not ready, so the keeper keeps looking rather than recording $0 for good
      if (typeof d.total_cost !== "number") return undefined;
      return { id: String(d.id ?? id), model: String(d.model ?? ""), totalCost: d.total_cost };
    },
  };
}
