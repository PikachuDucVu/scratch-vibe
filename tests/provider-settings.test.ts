import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, loadSettings, saveSettings } from "../src/agent/settings";
import { fetchModelList, fetchReply } from "../src/agent/loop";
import { providerConnectionSchema } from "../shared/provider";
import { requestModels } from "../shared/provider-api";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
  };
}
const connection = { baseUrl: "https://custom.example/v1", apiKey: "user-secret" };

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("browser AI settings", () => {
  it("starts without credentials and validates safe base URLs", () => {
    expect(loadSettings()).toEqual(defaultSettings());
    expect(providerConnectionSchema.parse({ ...connection, baseUrl: "  https://custom.example/v1///  " }).baseUrl).toBe(connection.baseUrl);
    expect(providerConnectionSchema.safeParse({ ...connection, baseUrl: "http://localhost:11434/v1" }).success).toBe(true);
    expect(providerConnectionSchema.safeParse({ ...connection, baseUrl: "http://[::1]:11434/v1" }).success).toBe(true);
    expect(providerConnectionSchema.safeParse({ ...connection, baseUrl: "http://remote.example/v1" }).success).toBe(false);
  });
  it("persists keys only in the tab session by default", () => {
    const settings = { ...defaultSettings(), ...connection, models: ["custom-a"], model: "custom-a", reasoningEffort: "high" as const };
    expect(saveSettings(settings)).toBe(true);
    expect(localStorage.getItem("scratch_vibe_ai_settings")).not.toContain(connection.apiKey);
    expect(localStorage.getItem("scratch_vibe_api_key")).toBeNull();
    expect(sessionStorage.getItem("scratch_vibe_api_key")).toBe(connection.apiKey);
    expect(loadSettings()).toEqual(settings);
    sessionStorage.clear();
    expect(loadSettings().apiKey).toBe("");
    expect(loadSettings().models).toEqual(["custom-a"]);
  });
  it("remembers only with consent, removes persistent key when disabled, and clears everything on reset", () => {
    const settings = { ...defaultSettings(), ...connection, rememberApiKey: true };
    saveSettings(settings);
    expect(localStorage.getItem("scratch_vibe_api_key")).toBe(connection.apiKey);
    expect(sessionStorage.getItem("scratch_vibe_api_key")).toBeNull();
    expect(loadSettings()).toEqual(settings);
    saveSettings({ ...settings, rememberApiKey: false });
    expect(localStorage.getItem("scratch_vibe_api_key")).toBeNull();
    expect(sessionStorage.getItem("scratch_vibe_api_key")).toBe(connection.apiKey);
    saveSettings(defaultSettings());
    expect(sessionStorage.getItem("scratch_vibe_api_key")).toBeNull();
    expect(loadSettings()).toEqual(defaultSettings());
  });
  it("handles corrupt storage and migrates only non-secret legacy preferences", () => {
    localStorage.setItem("scratch_vibe_ai_settings", "{");
    expect(() => loadSettings()).not.toThrow();
    localStorage.clear();
    localStorage.setItem("scratch_vibe_custom_model", "legacy-model");
    localStorage.setItem("scratch_vibe_reasoning_effort", "low");
    localStorage.setItem("scratch_vibe_cached_models", '["stale-model"]');
    expect(loadSettings()).toMatchObject({ model: "legacy-model", reasoningEffort: "low", models: [], apiKey: "" });
    saveSettings(loadSettings());
    expect(localStorage.getItem("scratch_vibe_custom_model")).toBeNull();
    expect(localStorage.getItem("scratch_vibe_cached_models")).toBeNull();
  });
  it("continues in memory when browser storage is blocked", () => {
    vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } });
    expect(loadSettings()).toEqual(defaultSettings());
    expect(saveSettings({ ...defaultSettings(), ...connection })).toBe(false);
  });
});

describe("browser provider requests", () => {
  it("lists models straight from the provider with the key only in the Authorization header", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "a" }, { id: "a" }, { id: "b" }] })));
    expect(await fetchModelList(connection)).toEqual(["a", "b"]);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${connection.baseUrl}/models`);
    expect(String(url)).not.toContain(connection.apiKey);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${connection.apiKey}` });
  });
  it("validates the connection before any request", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(fetchModelList({ ...connection, baseUrl: "http://remote.example/v1" })).rejects.toThrow("Custom URL");
    await expect(fetchModelList({ ...connection, apiKey: "" })).rejects.toThrow("API key");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports provider errors from the model list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(fetchModelList(connection)).rejects.toThrow("HTTP 401");
  });
  it("explains CORS/network failures instead of a bare 'Failed to fetch'", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchModelList(connection)).rejects.toThrow("CORS");
  });
  it("sends the selected model and thinking level straight to the provider", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } }));
    const reply = await fetchReply([{ role: "user", content: "hello" }], {}, new AbortController().signal, { ...connection, model: "selected-model", reasoningEffort: "high" });
    expect(reply.content).toBe("OK");
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${connection.baseUrl}/chat/completions`);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${connection.apiKey}` });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "selected-model", reasoning_effort: "high" });
    expect(String(init?.body)).not.toContain(connection.apiKey);
  });
  it("refuses to chat without a valid connection", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(fetchReply([{ role: "user", content: "hello" }], {}, new AbortController().signal, { model: "m" })).rejects.toThrow("Cài đặt AI");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("names the target of a redirect (browsers hide it behind an opaque redirect)", async () => {
    const opaque = { type: "opaqueredirect", status: 0, ok: false, headers: new Headers(), body: null } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(opaque);
    await expect(fetchReply([{ role: "user", content: "hello" }], {}, new AbortController().signal, { ...connection, model: "m" })).rejects.toThrow(/chuyển hướng/);
  });
});

describe("model-list credential boundaries", () => {
  it("does not forward the key to a different origin including a different port", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('["public-model"]'));
    for (const customModelsUrl of ["https://other.example/models", "https://custom.example:8443/models"]) {
      expect((await requestModels({ ...connection, customModelsUrl })).status).toBe(200);
      expect(fetcher.mock.lastCall?.[1]?.headers).not.toHaveProperty("Authorization");
      // Workers only support "follow"/"manual"; "error" throws there.
      expect(fetcher.mock.lastCall?.[1]?.redirect).toBe("manual");
    }
  });
  it("rejects a redirecting model list instead of following it with the key", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://evil.example/models" } }));
    const result = await requestModels(connection);
    expect(result.status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("names the redirect target in the error instead of a bare status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 301, headers: { Location: "https://ai.ducvu.io.vn/v1?ignored=1" } }));
    const result = await requestModels(connection);
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: expect.stringContaining("HTTP 301 tới https://ai.ducvu.io.vn/v1.") });
  });
  it("authenticates a custom model-list endpoint on the same origin", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('["private-model"]'));
    await requestModels({ ...connection, customModelsUrl: "https://custom.example/catalog" });
    expect(fetcher.mock.lastCall?.[1]?.headers).toMatchObject({ Authorization: "Bearer user-secret" });
  });
  it("sanitizes upstream error bodies and handles empty or timed-out responses", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("user-secret", { status: 401 }))
      .mockResolvedValueOnce(new Response('{}')).mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    const denied = await requestModels(connection);
    expect(denied.status).toBe(502);
    expect(JSON.stringify(denied.body)).not.toContain(connection.apiKey);
    expect((await requestModels(connection)).status).toBe(422);
    expect((await requestModels(connection)).body.error).toContain("15 giây");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
