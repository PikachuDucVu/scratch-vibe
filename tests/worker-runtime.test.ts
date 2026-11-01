// Runs the real worker bundle inside workerd (Cloudflare's runtime) via Miniflare.
// Node-only tests cannot catch options or bindings that only workerd rejects; this suite can.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const ORIGIN = "https://app.example";
let mf: Miniflare;

beforeAll(async () => {
  const bundle = await build({ entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false, mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"] });
  // The documented (v4-style) options are converted for the current Miniflare major version.
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2024-11-01",
    serviceBindings: { ASSETS: () => new Response("asset") },
    kvNamespaces: ["SHARES"],
    ratelimits: { API_LIMITER: { namespace_id: "1001", simple: { limit: 3, period: 60 } } },
    // Nothing should reach the network from these tests.
    outboundService: () => new Response("not found", { status: 404 }),
  } as Parameters<typeof convertV4MiniflareOptions>[0]));
  await mf.ready;
}, 60000);
afterAll(async () => { await mf?.dispose(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return mf.dispatchFetch(`${ORIGIN}${path}`, { method: "POST", body: text, headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers } });
};

describe("worker in workerd", () => {
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
    for (let i = 0; i < 5; i++) statuses.push((await mf.dispatchFetch(`${ORIGIN}/api/share/AAAAAAAAAAAAAAAAAAAAAA`, { headers: { "CF-Connecting-IP": "198.51.100.7" } })).status);
    expect(statuses).toContain(429);
  });
  it("does not relay provider traffic", async () => {
    const response = await post("/api/agent", { baseUrl: "https://provider.example/v1", apiKey: "k" });
    expect(response.status).toBe(404);
  });
});
