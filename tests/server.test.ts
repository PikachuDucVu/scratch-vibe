import { TOOL_DEFINITIONS } from "../shared/tools";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { request, type Server } from "node:http";
import { createApp } from "../server/app";
import { requestAgent } from "../server/agent";
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
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Cài đặt AI");
  });
  it("handles malformed JSON safely", async () => {
    const res = await fetch(`${base}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
  });
  it("prevents arbitrary URLs in the asset proxy", async () => {
    const res = await fetch(`${base}/api/scratch-assets/https://evil.example/get`);
    expect(res.status).toBe(400);
  });
  const connection = { baseUrl: "https://custom-api.example/v1", apiKey: "browser-only-key" };
  const post = (path: string, data: unknown) => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  it("validates browser credentials and model URLs", async () => {
    for (const baseUrl of ["ftp://example.com", "not-a-url", "http://example.com/v1", "https://user:pass@example.com/v1", "https://example.com/v1?key=secret"]) {
      expect((await post("/api/models", { ...connection, baseUrl })).status).toBe(400);
    }
    expect((await post("/api/models", { ...connection, customModelsUrl: "ftp://example.com/models" })).status).toBe(400);
    expect((await post("/api/models", { ...connection, apiKey: "" })).status).toBe(400);
    expect((await post("/api/models", { ...connection, apiKey: "bad\nkey" })).status).toBe(400);
  });
  it("fetches models using the browser's URL and key without query-string secrets", async () => {
    const realFetch = globalThis.fetch;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith(connection.baseUrl)) {
        return new Response(JSON.stringify({ data: [{ id: "custom-a" }, { id: "custom-b" }] }));
      }
      return realFetch(input, init);
    });
    const res = await post("/api/models", connection);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["custom-a", "custom-b"] });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const call = fetcher.mock.calls.find(([input]) => String(input) === `${connection.baseUrl}/models`)!;
    expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer browser-only-key" });
    expect(call[1]?.redirect).toBe("manual");
    fetcher.mockRestore();
  });
  it("forwards the per-request connection, model and thinking to chat", async () => {
    const realFetch = globalThis.fetch;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith(connection.baseUrl)) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
      }
      return realFetch(input, init);
    });
    const res = await post("/api/agent", { ...connection, model: "chosen-model", reasoningEffort: "high", messages: [{ role: "user", content: "hello" }], project: {} });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("OK");
    expect(body).not.toContain(connection.apiKey);
    const call = fetcher.mock.calls.find(([input]) => String(input) === `${connection.baseUrl}/chat/completions`)!;
    expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer browser-only-key" });
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ model: "chosen-model", reasoning_effort: "high" });
    fetcher.mockRestore();
    // Credentials never become a server-wide default for later requests/users.
    const config = await fetch(`${base}/api/config`);
    expect(await config.json()).toEqual({ configured: false, model: "gpt-4.1", share: false });
    expect((await post("/api/agent", { messages: [{ role: "user", content: "hello" }], project: {} })).status).toBe(400);
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
    expect(JSON.parse(String(init?.body)).tools).toHaveLength(TOOL_DEFINITIONS.length);
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
