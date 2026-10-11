import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { createApp } from "../server/app";
import { requestAgent } from "../server/agent";
import { validateConversation } from "../shared/chat";

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp({ config: { apiKey: "", model: "test-model", baseUrl: "https://api.openai.com/v1" }, port: 3001, appOrigin: "http://127.0.0.1:5173" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe("local API boundaries", () => {
  it("reports setup without exposing API credentials", async () => {
    const res = await fetch(`${base}/api/config`);
    expect(await res.json()).toEqual({ configured: false, model: "test-model" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects cross-origin requests", async () => {
    const res = await fetch(`${base}/api/agent`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
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
  it("has a useful missing-key error", async () => {
    const res = await fetch(`${base}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("OPENAI_API_KEY");
  });
  it("handles malformed JSON safely", async () => {
    const res = await fetch(`${base}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
  });
  it("prevents arbitrary URLs in the asset proxy", async () => {
    const res = await fetch(`${base}/api/scratch-assets/https://evil.example/get`);
    expect(res.status).toBe(400);
  });
  it("validates url parameter on /api/models", async () => {
    const badProtocol = await fetch(`${base}/api/models?url=ftp://example.com/models`);
    expect(badProtocol.status).toBe(400);
    const malformed = await fetch(`${base}/api/models?url=not-a-url`);
    expect(malformed.status).toBe(400);
  });
  it("fetches and parses models from a valid custom URL", async () => {
    const realFetch = globalThis.fetch;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith("https://custom-api.example")) {
        return new Response(JSON.stringify({ data: [{ id: "custom-a" }, { id: "custom-b" }] }), { status: 200 });
      }
      return realFetch(input, init);
    });
    const res = await fetch(`${base}/api/models?url=https://custom-api.example/v1/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["custom-a", "custom-b"] });
    fetcher.mockRestore();
  });
});

describe("provider protocol", () => {
  const config = { apiKey: "server-only-secret", model: "test", baseUrl: "https://api.example/v1" };
  it("keeps the key in the server Authorization header and uses real function tools", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Xin chào" }, finish_reason: "stop" }] }), { status: 200 }));
    const reply = await requestAgent(config, [{ role: "user", content: "hello" }], { targets: [] });
    expect(reply.content).toBe("Xin chào");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.example/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer server-only-secret" });
    expect(String(init?.body)).not.toContain("server-only-secret");
    expect(JSON.parse(String(init?.body)).tools).toHaveLength(9);
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("reasoning_effort");
  });
  it("sends high reasoning effort when configured without changing the model ID", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] })));
    await requestAgent({ ...config, model: "gpt-6.1-sol", reasoningEffort: "high" }, [{ role: "user", content: "hello" }], {});
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: "high" });
  });
  it("never leaks upstream error bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret upstream debug server-only-secret", { status: 401 }));
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
