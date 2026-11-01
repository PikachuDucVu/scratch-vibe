import { afterEach, describe, expect, it, vi } from "vitest";
import { requestMedia } from "../shared/media-api";

const connection = { baseUrl: "https://media-provider.example/v1", apiKey: "browser-media-key" };
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

describe("direct media requests", () => {
  it("posts the body unchanged with the key as Authorization", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"data":[{"b64_json":"AAA"}]}', { headers: { "content-type": "application/json" } }));
    const body = JSON.stringify({ model: "gpt-image-2", prompt: "cat" });
    const response = await requestMedia("images/generations", connection, body, signal());
    expect(await response.json()).toEqual({ data: [{ b64_json: "AAA" }] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${connection.baseUrl}/images/generations`);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer browser-media-key", "Content-Type": "application/json" });
    expect(init?.body).toBe(body);
    expect(init?.redirect).toBe("manual");
  });
  it("accepts a whole settings object, not only the two connection fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
    await expect(requestMedia("images/generations", { ...connection, model: "m", imageQuality: "low" } as typeof connection, "{}", signal())).resolves.toBeInstanceOf(Response);
  });
  it("lets the browser set the multipart boundary for image edits", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
    await requestMedia("images/edits", connection, new FormData(), signal());
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("Content-Type");
  });
  it("rejects unknown paths and bad credentials without fetching", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(requestMedia("files", connection, "{}", signal())).rejects.toThrow("Media API");
    await expect(requestMedia("images/generations", { ...connection, apiKey: "" }, "{}", signal())).rejects.toThrow("Cài đặt AI");
    await expect(requestMedia("images/generations", { ...connection, baseUrl: "http://remote.example/v1" }, "{}", signal())).rejects.toThrow("Cài đặt AI");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never echoes provider error bodies, only a safe error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"error":{"message":"secret browser-media-key","code":"model_not_found"}}', { status: 400 }));
    const error = await requestMedia("audio/speech", connection, "{}", signal()).then(() => new Error(""), (e: Error) => e);
    expect(error.message).not.toContain("browser-media-key");
    expect(error.message).toContain("model");
  });
  it("names the redirect target instead of following it", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 301, headers: { Location: "https://media-provider.example/v1" } }));
    await expect(requestMedia("audio/speech", connection, "{}", signal())).rejects.toThrow("HTTP 301 tới https://media-provider.example/v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported response types", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { headers: { "content-type": "text/html" } }));
    await expect(requestMedia("images/generations", connection, "{}", signal())).rejects.toThrow("không hỗ trợ");
  });
});
