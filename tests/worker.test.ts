import { describe, expect, it, vi } from "vitest";
import worker, { type Env, type ExecutionContext } from "../worker/index";

const env: Env = { ASSETS: { fetch: async () => new Response("asset") } };
const ctx: ExecutionContext = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
const connection = { baseUrl: "https://worker-provider.example/v1", apiKey: "browser-worker-key" };
const request = (path: string, body: unknown) => new Request(`https://app.example${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

describe("Worker web-configured AI", () => {
  it("does not expose or rely on legacy environment credentials", async () => {
    const legacyEnv = { ...env, OPENAI_API_KEY: "ignored-secret", OPENAI_BASE_URL: "https://ignored.example", OPENAI_MODEL: "ignored" };
    const config = await worker.fetch(new Request("https://app.example/api/config"), legacyEnv, ctx);
    expect(await config.json()).toEqual({ configured: false, model: "gpt-4.1" });
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
    const malformed = new Request("https://app.example/api/models", { method: "POST", body: "{" });
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
