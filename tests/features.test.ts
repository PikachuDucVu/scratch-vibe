import { describe, expect, it, vi } from "vitest";
import { diffInventory, type Inventory } from "../src/agent/changes";
import { fetchWithRetry, systemPrompt } from "../shared/agent";
import { guessImageModel } from "../shared/models";

const text = { stage: "Sân khấu", added: "Sprite mới", removed: "Đã xóa", blocks: "block", changedBlocks: "block sửa", removedBlocks: "block", variables: "biến", costumes: "costume", sounds: "âm thanh", renamed: "đổi tên từ" };
const target = (over: Partial<Inventory["targets"][number]> = {}) => ({ id: "cat", name: "Mèo", isStage: false, blocks: {}, variables: [], costumes: ["cat-a#1"], sounds: [], ...over });

describe("change summary", () => {
  it("counts added, edited and removed blocks and asset changes, and picks blocks to highlight", () => {
    const before: Inventory = { targets: [target({ blocks: { a: "1", b: "2", c: "3" } }), { ...target(), id: "old", name: "Cũ" }] };
    const after: Inventory = { targets: [target({ name: "Mèo con", blocks: { a: "1", b: "changed", d: "4" }, variables: [":Điểm"], costumes: ["cat-a#1", "rồng#9"] }), { ...target(), id: "new", name: "Bóng" }] };
    const summary = diffInventory(before, after, text);
    expect(summary.lines).toEqual([
      "Mèo con: đổi tên từ “Mèo” · +1 block · 1 block sửa · −1 block · +biến: Điểm · +costume: rồng",
      "Sprite mới: Bóng",
      "Đã xóa: Cũ",
    ]);
    expect(summary.highlight).toEqual({ targetId: "cat", blockIds: ["d", "b"] });
  });
  it("reports nothing when nothing changed", () => {
    const same: Inventory = { targets: [target({ blocks: { a: "1" } })] };
    expect(diffInventory(same, same, text)).toEqual({ lines: [], highlight: undefined });
  });
});

describe("system prompt modes and language", () => {
  it("adds mode instructions and switches reply language", () => {
    expect(systemPrompt()).not.toContain("CHẾ ĐỘ");
    expect(systemPrompt("plan")).toContain("CHẾ ĐỘ LẬP KẾ HOẠCH");
    expect(systemPrompt("explain")).toContain("CHẾ ĐỘ GIẢI THÍCH");
    expect(systemPrompt("teach")).toContain("CHẾ ĐỘ DẠY HỌC");
    expect(systemPrompt("build", "en")).toContain("Always reply to the user in simple, friendly English");
    expect(systemPrompt()).toContain("generate_costume");
    expect(systemPrompt()).toContain("record_run");
  });
});

describe("provider retries", () => {
  const init = () => ({ method: "POST", signal: new AbortController().signal });
  it("retries transient 429/5xx and network errors, then succeeds", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response("ok"));
    const response = await fetchWithRetry("https://p.example/v1/chat/completions", init(), [0, 0]);
    expect(await response.text()).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("does not retry client errors and gives up after the configured attempts", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 401 }));
    expect((await fetchWithRetry("https://p.example/x", init(), [0, 0])).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response("down", { status: 503 }));
    expect((await fetchWithRetry("https://p.example/x", init(), [0, 0])).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("stops waiting as soon as the user aborts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("busy", { status: 503 }));
    const controller = new AbortController();
    const pending = fetchWithRetry("https://p.example/x", { method: "POST", signal: controller.signal }, [60000]);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeDefined();
  });
});

describe("image model guess", () => {
  it("prefers gpt-image models, then other image models", () => {
    expect(guessImageModel(["gpt-6", "gemini-3.1-flash-image", "gpt-image-2"])).toBe("gpt-image-2");
    expect(guessImageModel(["gpt-6", "gemini-3.1-flash-image"])).toBe("gemini-3.1-flash-image");
    expect(guessImageModel(["gpt-6", "claude"])).toBe("");
  });
});
