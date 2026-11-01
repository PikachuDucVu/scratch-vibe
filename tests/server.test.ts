import { TOOL_DEFINITIONS } from "../shared/tools";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { createApp } from "../server/app";
import { requestAgent } from "../shared/agent";
import { validateConversation } from "../shared/chat";

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp({ port: 3001, appOrigin: "http://127.0.0.1:5173" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe("local API boundaries", () => {
  it("reports setup without exposing API credentials", async () => {
    const res = await fetch(`${base}/api/config`);
    expect(await res.json()).toEqual({ configured: false, model: "gpt-4.1", share: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects cross-origin requests", async () => {
    const res = await fetch(`${base}/api/config`, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
  it("rejects DNS rebinding hosts", async () => {
    // Node fetch rewrites Host; use raw HTTP to exercise the actual header.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/config`, { headers: { Host: "evil.example" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(403);
  });
  it("prevents arbitrary URLs in the asset proxy", async () => {
    const res = await fetch(`${base}/api/scratch-assets/https://evil.example/get`);
    expect(res.status).toBe(400);
  });
  it("does not relay provider traffic: the browser calls the provider directly", async () => {
    for (const path of ["/api/agent", "/api/models", "/api/media/images/generations"]) {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(res.status).toBe(404);
    }
  });
});

describe("provider protocol", () => {
  const config = { apiKey: "provider-secret", model: "test", baseUrl: "https://api.example/v1" };
  it("sends the key only in the Authorization header and uses real function tools", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Xin chào" }, finish_reason: "stop" }] }), { status: 200 }));
    const reply = await requestAgent(config, [{ role: "user", content: "hello" }], { targets: [] });
    expect(reply.content).toBe("Xin chào");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.example/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer provider-secret" });
    expect(String(init?.body)).not.toContain("provider-secret");
    expect(JSON.parse(String(init?.body)).tools).toHaveLength(TOOL_DEFINITIONS.length);
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("reasoning_effort");
  });
  it("sends high reasoning effort when configured without changing the model ID", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] })));
    await requestAgent({ ...config, model: "gpt-6.1-sol", reasoningEffort: "high" }, [{ role: "user", content: "hello" }], {});
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: "high" });
  });
  it("never leaks upstream error bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret upstream debug provider-secret", { status: 401 }));
    await expect(requestAgent(config, [{ role: "user", content: "hello" }], {})).rejects.toThrow(/API key/);
  });
  it("rejects truncated tool responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] })));
    await expect(requestAgent(config, [{ role: "user", content: "hello" }], {})).rejects.toThrow(/giới hạn output/);
  });
  it("rejects missing and duplicate tool results", () => {
    expect(() => validateConversation([{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "get_project", arguments: "{}" } }] }])).toThrow(/Thiếu kết quả/);
    expect(() => validateConversation([{ role: "user", content: "x" }, { role: "tool", tool_call_id: "fake", content: "{}" }])).toThrow(/không khớp/);
  });
});
