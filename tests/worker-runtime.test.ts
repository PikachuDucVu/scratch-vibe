// Runs the real worker bundle inside workerd (Cloudflare's runtime) via Miniflare.
// Node-only tests missed `redirect: "error"`, which workerd rejects; this suite would not.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const ORIGIN = "https://app.example";
const PROVIDER = "https://provider.example/v1";
let mf: Miniflare;
const providerCalls: { url: string; auth: string | null; redirect?: string; body: string }[] = [];

async function provider(request: Request): Promise<Response> {
  const url = new URL(request.url);
  providerCalls.push({ url: request.url, auth: request.headers.get("authorization"), body: await request.text() });
  if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "runtime-model" }] });
  if (url.pathname === "/redirect/models") return new Response(null, { status: 302, headers: { Location: "https://evil.example/models" } });
  if (url.pathname === "/v1/images/generations") return Response.json({ data: [{ b64_json: "iVBORw0KGgo=" }] });
  if (url.pathname === "/v1/chat/completions") {
    const events = [
      { choices: [{ delta: { content: "Xin chào" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }
  return new Response("not found", { status: 404 });
}

beforeAll(async () => {
  const bundle = await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false, mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"] });
  // The documented (v4-style) options are converted for the current Miniflare major version.
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2024-11-01",
    serviceBindings: { ASSETS: () => new Response("asset") },
    kvNamespaces: ["SHARES"],
    ratelimits: { API_LIMITER: { namespace_id: "1001", simple: { limit: 3, period: 60 } } },
    // Every outbound fetch hits this fake provider; nothing reaches the network.
    outboundService: provider,
  } as Parameters<typeof convertV4MiniflareOptions>[0]));
  await mf.ready;
}, 60000);
afterAll(async () => { await mf?.dispose(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return mf.dispatchFetch(`${ORIGIN}${path}`, { method: "POST", body: text, headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers } });
};

describe("worker in workerd", () => {
  it("lists models (fetch options must be valid in workerd) and refuses provider redirects", async () => {
    const ok = await post("/api/models", { baseUrl: PROVIDER, apiKey: "k1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ models: ["runtime-model"] });
    const redirected = await post("/api/models", { baseUrl: "https://provider.example/redirect", apiKey: "k1" });
    expect(redirected.status).toBe(502);
    expect(providerCalls.some(c => c.url.startsWith("https://evil.example"))).toBe(false);
  });
  it("streams chat and forwards token usage", async () => {
    const response = await post("/api/agent", { baseUrl: PROVIDER, apiKey: "k2", model: "m", messages: [{ role: "user", content: "hi" }], project: {} }, { Accept: "text/event-stream" });
    const body = await response.text();
    expect(body).toContain('"text":"Xin chào"');
    expect(body).toContain('"usage":{"promptTokens":10,"completionTokens":2,"totalTokens":12}');
    expect(body).toContain('"type":"done"');
  });
  it("proxies media bodies untouched", async () => {
    const payload = JSON.stringify({ model: "gpt-image-2", prompt: "cat" });
    const response = await mf.dispatchFetch(`${ORIGIN}/api/media/images/generations`, { method: "POST", body: payload, headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Provider-Url": PROVIDER, "X-Provider-Key": "k3" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ b64_json: "iVBORw0KGgo=" }] });
    const call = providerCalls.find(c => c.url.endsWith("/images/generations"))!;
    expect(call.auth).toBe("Bearer k3");
    expect(call.body).toBe(payload);
  });
  it("stores and serves share links in KV", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9]);
    const response = await mf.dispatchFetch(`${ORIGIN}/api/share`, { method: "POST", body: zip, headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN } });
    expect(response.status).toBe(200);
    const { id } = await response.json() as { id: string };
    const fetched = await mf.dispatchFetch(`${ORIGIN}/api/share/${id}`);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(zip);
  });
  it("enforces the rate-limit binding", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post("/api/models", { baseUrl: PROVIDER, apiKey: "k4" }, { "CF-Connecting-IP": "198.51.100.7" })).status);
    expect(statuses).toContain(429);
  });
});
