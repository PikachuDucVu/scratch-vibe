import { describe, expect, it, vi } from "vitest";
import worker, { type Env, type ExecutionContext } from "../worker/index";

const env: Env = { ASSETS: { fetch: async () => new Response("asset") } };
const ctx: ExecutionContext = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
const connection = { baseUrl: "https://worker-provider.example/v1", apiKey: "browser-worker-key" };
const request = (path: string, body: unknown) => new Request(`https://app.example${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example" }, body: JSON.stringify(body),
});

describe("Worker config", () => {
  it("does not expose or rely on legacy environment credentials", async () => {
    const legacyEnv = { ...env, OPENAI_API_KEY: "ignored-secret", OPENAI_BASE_URL: "https://ignored.example", OPENAI_MODEL: "ignored" };
    const config = await worker.fetch(new Request("https://app.example/api/config"), legacyEnv, ctx);
    expect(await config.json()).toEqual({ configured: false, model: "gpt-4.1", share: false });
  });
  it("does not relay provider traffic: the browser calls the provider directly", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const path of ["/api/agent", "/api/models", "/api/media/images/generations"]) {
      const response = await worker.fetch(request(path, connection), env, ctx);
      expect(response.status).toBe(404);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Worker abuse protection", () => {
  it("refuses scripted POSTs without the app's Origin and cross-site requests", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const scripted = await worker.fetch(new Request("https://app.example/api/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, ctx);
    expect(scripted.status).toBe(403);
    const crossSite = request("/api/share", {});
    crossSite.headers.set("Origin", "https://evil.example");
    expect((await worker.fetch(crossSite, env, ctx)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rate-limits share downloads per client IP", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const req = new Request("https://app.example/api/share/AAAAAAAAAAAAAAAAAAAAAA", { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    const response = await worker.fetch(req, { ...env, SHARES: { get: vi.fn(), put: vi.fn() }, API_LIMITER: { limit } }, ctx);
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "share-get:203.0.113.9" });
  });
});

describe("Worker share links", () => {
  const store = new Map<string, { value: ArrayBuffer; ttl?: number }>();
  const SHARES = {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: ArrayBuffer, options?: { expirationTtl?: number }) => { store.set(key, { value, ttl: options?.expirationTtl }); }),
  };
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const post = (body: Uint8Array | string) => new Request("https://app.example/api/share", { method: "POST", body: body as BodyInit, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(typeof body === "string" ? body.length : body.byteLength), Origin: "https://app.example" } });
  it("stores .sb3 archives with an unguessable expiring id and serves them back", async () => {
    const response = await worker.fetch(post(zip), { ...env, SHARES }, ctx);
    expect(response.status).toBe(200);
    const { id, url } = await response.json() as { id: string; url: string };
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url).toBe(`https://app.example/?share=${id}`);
    expect(store.get(id)?.ttl).toBe(30 * 24 * 60 * 60);
    const fetched = await worker.fetch(new Request(`https://app.example/api/share/${id}`), { ...env, SHARES }, ctx);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(zip);
    expect((await worker.fetch(new Request("https://app.example/api/share/AAAAAAAAAAAAAAAAAAAAAA"), { ...env, SHARES }, ctx)).status).toBe(404);
  });
  it("refuses non-archives and reports when sharing is not configured", async () => {
    expect((await worker.fetch(post("not a zip"), { ...env, SHARES }, ctx)).status).toBe(400);
    expect((await worker.fetch(post(zip), env, ctx)).status).toBe(501);
  });
});
