import { describe, expect, it, vi } from "vitest";
import worker, { type Env, type ExecutionContext } from "../worker/index";

const env: Env = { ASSETS: { fetch: async () => new Response("asset") } };
const ctx: ExecutionContext = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
const connection = { baseUrl: "https://worker-provider.example/v1", apiKey: "browser-worker-key" };
const request = (path: string, body: unknown) => new Request(`https://app.example${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example" }, body: JSON.stringify(body),
});

describe("Worker web-configured AI", () => {
  it("does not expose or rely on legacy environment credentials", async () => {
    const legacyEnv = { ...env, OPENAI_API_KEY: "ignored-secret", OPENAI_BASE_URL: "https://ignored.example", OPENAI_MODEL: "ignored" };
    const config = await worker.fetch(new Request("https://app.example/api/config"), legacyEnv, ctx);
    expect(await config.json()).toEqual({ configured: false, model: "gpt-4.1", share: false });
    const missing = await worker.fetch(request("/api/agent", { messages: [{ role: "user", content: "hello" }], project: {} }), legacyEnv, ctx);
    expect(missing.status).toBe(400);
    expect(await missing.text()).not.toContain("ignored-secret");
  });
  it("authenticates model-list requests using the web settings", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"data":[{"id":"worker-model"}]}'));
    const response = await worker.fetch(request("/api/models", connection), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: ["worker-model"] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher.mock.calls[0][0]).toBe(`${connection.baseUrl}/models`);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer browser-worker-key" });
  });
  it("forwards chat URL, key, model and reasoning independently of env", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })));
    const response = await worker.fetch(request("/api/agent", { ...connection, model: "worker-model", reasoningEffort: "low", messages: [{ role: "user", content: "hello" }], project: {} }), env, ctx);
    expect(response.status).toBe(200);
    expect((await response.json() as { content: string }).content).toBe("OK");
    expect(fetcher.mock.calls[0][0]).toBe(`${connection.baseUrl}/chat/completions`);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: "worker-model", reasoning_effort: "low" });
  });
  it("rejects malformed JSON, unsafe URLs and cross-site requests before contacting a provider", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const malformed = new Request("https://app.example/api/models", { method: "POST", body: "{", headers: { Origin: "https://app.example" } });
    expect((await worker.fetch(malformed, env, ctx)).status).toBe(400);
    expect((await worker.fetch(request("/api/models", { ...connection, baseUrl: "http://remote.example/v1" }), env, ctx)).status).toBe(400);
    const crossSite = request("/api/models", connection);
    crossSite.headers.set("Origin", "https://evil.example");
    expect((await worker.fetch(crossSite, env, ctx)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Worker SSE completion", () => {
  it.each([true, false])("handles streamed provider completion=%s without unfinished tool execution", async complete => {
    const delta = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: "get_project", arguments: "{}" } }] } }] })}\n\n`;
    const ending = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(delta + (complete ? ending : ""), { headers: { "content-type": "text/event-stream" } }));
    const req = request("/api/agent", { ...connection, model: "test", messages: [{ role: "user", content: "test" }], project: {} });
    req.headers.set("Accept", "text/event-stream");
    const promises: Promise<unknown>[] = [];
    const response = await worker.fetch(req, env, { ...ctx, waitUntil(promise) { promises.push(promise); } });
    const body = await response.text();
    await Promise.all(promises);
    expect(body).toContain(complete ? '"type":"done"' : '"type":"error"');
    if (!complete) expect(body).not.toContain('"tool_calls"');
  });
});

describe("Worker abuse protection", () => {
  it("refuses scripted POSTs without the app's Origin before contacting anyone", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    for (const path of ["/api/models", "/api/agent", "/api/media/images/generations", "/api/share"]) {
      const response = await worker.fetch(new Request(`https://app.example${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, ctx);
      expect(response.status).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rate-limits per client IP before calling the provider", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const limit = vi.fn().mockResolvedValue({ success: false });
    const req = request("/api/agent", { ...connection, messages: [{ role: "user", content: "hi" }], project: {} });
    req.headers.set("CF-Connecting-IP", "203.0.113.9");
    const response = await worker.fetch(req, { ...env, API_LIMITER: { limit } }, ctx);
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "agent:203.0.113.9" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects oversized JSON bodies", async () => {
    const req = request("/api/agent", { ...connection, messages: [{ role: "user", content: "x" }], project: { blob: "x".repeat(1024 * 1024) } });
    expect((await worker.fetch(req, env, ctx)).status).toBe(413);
  });
});

describe("Worker media proxy", () => {
  // Browsers always send Content-Length for these bodies; Node's Request does not add it.
  const media = (path: string, body: string, type: string, headers: Record<string, string> = {}) => new Request(`https://app.example/api/media/${path}`, {
    method: "POST", body, headers: { "Content-Type": type, "Content-Length": String(new TextEncoder().encode(body).byteLength), Origin: "https://app.example", "X-Provider-Url": connection.baseUrl, "X-Provider-Key": connection.apiKey, ...headers },
  });
  it("forwards the browser-built body unchanged with the key as Authorization", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"data":[{"b64_json":"AAA"}]}', { headers: { "content-type": "application/json" } }));
    const body = JSON.stringify({ model: "gpt-image-2", prompt: "cat" });
    const response = await worker.fetch(media("images/generations", body, "application/json"), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ b64_json: "AAA" }] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${connection.baseUrl}/images/generations`);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer browser-worker-key", "Content-Type": "application/json" });
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
    expect(init?.redirect).toBe("manual");
  });
  it("rejects unknown paths, wrong content types and missing credentials without fetching", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect((await worker.fetch(media("files", "{}", "application/json"), env, ctx)).status).toBe(404);
    expect((await worker.fetch(media("images/edits", "{}", "application/json"), env, ctx)).status).toBe(415);
    expect((await worker.fetch(media("images/generations", "{}", "application/json", { "X-Provider-Key": "" }), env, ctx)).status).toBe(400);
    expect((await worker.fetch(media("images/generations", "{}", "application/json", { "X-Provider-Url": "http://remote.example/v1" }), env, ctx)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never echoes provider error bodies, only a safe error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"error":{"message":"secret browser-worker-key","code":"model_not_found"}}', { status: 400 }));
    const response = await worker.fetch(media("audio/speech", "{}", "application/json"), env, ctx);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("browser-worker-key");
    expect(text).toContain("model");
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

describe("Worker JSON complexity limit", () => {
  it("rejects huge arrays before schema validation", async () => {
    const req = request("/api/agent", { ...connection, messages: Array.from({ length: 60000 }, () => 0), project: {} });
    expect((await worker.fetch(req, env, ctx)).status).toBe(413);
  });
});
