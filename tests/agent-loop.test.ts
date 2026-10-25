import { describe, expect, it, vi } from "vitest";
import { compactMessages, runAgent, trimHistory, type ToolEvent } from "../src/agent/loop";
import { validateConversation, type ChatMessage } from "../shared/chat";
import type { EditorHandle } from "../src/components/ScratchEditor";

const call = (id: string, name = "get_project", args: unknown = {}) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
function harness() {
  const editor: EditorHandle = {
    tool: vi.fn().mockResolvedValue({ targets: [] }),
    exportProject: vi.fn(), loadProject: vi.fn(),
  };
  const abort = new AbortController();
  const events: ToolEvent[] = [];
  let history: ChatMessage[] = [];
  return { editor, abort, events, get history() { return history; }, options: {
    editor, signal: abort.signal, history: [], prompt: "Hãy tạo chương trình",
    onHistory: (messages: ChatMessage[]) => { history = messages; },
    onTool: (event: ToolEvent) => { events.push(event); },
    confirmReplace: vi.fn().mockResolvedValue(true),
  } };
}
describe("agent tool loop", () => {
  it("executes tools then provides real results to the model", async () => {
    const h = harness();
    const reply = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("a")] }).mockResolvedValueOnce({ role: "assistant", content: "Đã đọc." });
    await expect(runAgent({ ...h.options, reply })).resolves.toBe("Đã đọc.");
    expect(h.history.find(message => message.role === "tool")).toMatchObject({ tool_call_id: "a", content: '{"targets":[]}' });
    expect(h.events.at(-1)?.status).toBe("success");
    expect(() => validateConversation(h.history)).not.toThrow();
  });
  it("returns invalid tool errors instead of executing arbitrary functions", async () => {
    const h = harness();
    const reply = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("a", "shell")] }).mockResolvedValueOnce({ role: "assistant", content: "Không thể thực hiện." });
    await runAgent({ ...h.options, reply });
    expect(h.events.at(-1)?.status).toBe("error");
    expect(h.editor.tool).not.toHaveBeenCalledWith("shell", expect.anything());
  });
  it("asks for permission before destructive replacement", async () => {
    const h = harness();
    h.options.confirmReplace.mockResolvedValue(false);
    const reply = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("a", "replace_scripts", { targetId: "cat", scripts: [[{ opcode: "event_whenflagclicked" }]] })] }).mockResolvedValueOnce({ role: "assistant", content: "Đã giữ nguyên." });
    await runAgent({ ...h.options, reply });
    expect(h.options.confirmReplace).toHaveBeenCalledWith("cat");
    expect(h.editor.tool).not.toHaveBeenCalledWith("replace_scripts", expect.anything());
  });
  it("cancellation waits for active tool and skips remaining tools, retaining a valid ledger", async () => {
    const h = harness();
    const tool = vi.mocked(h.editor.tool);
    tool.mockImplementation(async name => {
      if (name === "stop_project") { h.abort.abort(); return { running: false }; }
      return { targets: [] };
    });
    const reply = vi.fn().mockResolvedValue({ role: "assistant", content: null, tool_calls: [call("a", "stop_project"), call("b", "run_project")] });
    await expect(runAgent({ ...h.options, reply })).rejects.toThrow();
    expect(tool).not.toHaveBeenCalledWith("run_project", expect.anything());
    expect(h.history.filter(message => message.role === "tool")).toHaveLength(2);
    expect(() => validateConversation(h.history)).not.toThrow();
  });
  it("has no step limit and compacts context so every request stays valid and bounded", async () => {
    const h = harness();
    // Large tool results force compaction long before 60 steps.
    vi.mocked(h.editor.tool).mockResolvedValue({ blob: "x".repeat(40000) });
    let number = 0;
    const sent: ChatMessage[][] = [];
    const reply = vi.fn().mockImplementation(async (messages: ChatMessage[]) => {
      sent.push([...messages]); // Copy: the loop appends to the same array after sending.
      // Distinct arguments each step: identical consecutive calls trip the loop guard.
      return number < 60 ? { role: "assistant", content: null, tool_calls: [call(`a${number}`, "get_project", { offset: number++ })] } : { role: "assistant", content: "Xong." };
    });
    await expect(runAgent({ ...h.options, reply })).resolves.toBe("Xong.");
    expect(reply).toHaveBeenCalledTimes(61);
    for (const messages of sent) {
      expect(messages.length).toBeLessThanOrEqual(90);
      expect(JSON.stringify(messages).length).toBeLessThanOrEqual(700000);
      expect(messages[0]).toEqual({ role: "user", content: "Hãy tạo chương trình" });
      expect(() => validateConversation(messages)).not.toThrow();
    }
    expect(() => validateConversation(h.history)).not.toThrow();
  });
  it("keeps only the most recent images when compacting", () => {
    const prompt: ChatMessage = { role: "user", content: "p" };
    const image = (i: number): ChatMessage => ({ role: "user", content: [{ type: "text", text: `img${i}` }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJj", detail: "low" } }] });
    const compacted = compactMessages([prompt, ...[0, 1, 2, 3, 4].map(image)], prompt);
    expect(compacted.filter(m => Array.isArray(m.content)).map(m => (m.content as { text?: string }[])[0].text)).toEqual(["img2", "img3", "img4"]);
    expect(compacted).toHaveLength(6);
  });
  it("trims by complete user turns, not through tool results", () => {
    const turn: ChatMessage[] = [{ role: "user", content: "test" }, { role: "assistant", content: null, tool_calls: [call("a")] }, { role: "tool", tool_call_id: "a", content: "{}" }, { role: "assistant", content: "ok" }];
    const history = Array.from({ length: 20 }, (_, i) => turn.map(message => message.role === "assistant" && message.tool_calls ? { ...message, tool_calls: [call(`a${i}`)] } : message.role === "tool" ? { ...message, tool_call_id: `a${i}` } : message)).flat();
    const trimmed = trimHistory(history);
    expect(trimmed.length).toBeLessThanOrEqual(60);
    expect(() => validateConversation(trimmed)).not.toThrow();
  });
  it("forwards model and reasoning effort options to the provider call", async () => {
    const h = harness();
    const reply = vi.fn().mockResolvedValueOnce({ role: "assistant", content: "Đã xử lý." });
    await runAgent({ ...h.options, reply, model: "o3-mini", reasoningEffort: "high" });
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({
      model: "o3-mini",
      reasoningEffort: "high",
    }));
  });
});

describe("expanded tool permissions and images", () => {
  it.each(["delete_sprite", "delete_script", "restore_snapshot", "import_file", "run_project", "test_input"])("does not execute %s without a confirmation handler", async name => {
    const h = harness();
    const args = name === "restore_snapshot" ? { snapshotId: "s" } : name === "import_file" ? { fileId: "f" } : name === "test_input" ? { device: "keyboard", key: "space" } : name === "run_project" ? {} : { targetId: "cat", ...(name === "delete_script" ? { scriptId: "s" } : {}) };
    const reply = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("a", name, args)] }).mockResolvedValueOnce({ role: "assistant", content: "Không thực hiện." });
    await runAgent({ ...h.options, reply });
    expect(h.editor.tool).not.toHaveBeenCalledWith(name, expect.anything());
    expect(h.events.at(-1)?.status).toBe("error");
  });
  it("cancels a confirmed operation when cancellation occurred inside confirmation", async () => {
    const h = harness();
    const confirmTool = vi.fn(async () => { h.abort.abort(); return true; });
    const reply = vi.fn().mockResolvedValue({ role: "assistant", content: null, tool_calls: [call("a", "delete_sprite", { targetId: "cat" })] });
    await expect(runAgent({ ...h.options, reply, confirmTool })).rejects.toThrow();
    expect(h.editor.tool).not.toHaveBeenCalledWith("delete_sprite", expect.anything());
    expect(() => validateConversation(h.history)).not.toThrow();
  });
  it("sends captures as vision input only after all tool results, without base64 in tool text", async () => {
    const h = harness();
    vi.mocked(h.editor.tool).mockImplementation(async name => name === "capture_stage" ? { image: "data:image/jpeg;base64,YWJj", width: 480, height: 360 } : { targets: [] });
    const reply = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("a", "capture_stage"), call("b", "get_project")] }).mockResolvedValueOnce({ role: "assistant", content: "Đã xem ảnh." });
    await runAgent({ ...h.options, reply });
    expect(h.history[4]).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image_url" }] });
    const result = h.history.find(m => m.role === "tool")!;
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(() => validateConversation(h.history)).not.toThrow();
  });
  it("sends costume images to the model with their metadata", async () => {
    const h = harness();
    vi.mocked(h.editor.tool).mockImplementation(async name => name === "get_costume_image" ? { name: "cat-a", index: 0, image: "data:image/jpeg;base64,YWJj" } : { targets: [] });
    const reply = vi.fn().mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("a", "get_costume_image", { targetId: "cat" })] }).mockResolvedValueOnce({ role: "assistant", content: "Mèo màu cam." });
    await runAgent({ ...h.options, reply });
    expect(h.history.find(m => m.role === "tool")).toMatchObject({ content: JSON.stringify({ name: "cat-a", index: 0, imageFollows: true }) });
    expect(h.history.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("get_costume_image") }, { type: "image_url" }] });
    expect(() => validateConversation(h.history)).not.toThrow();
  });
});

describe("loop safety, modes and media", () => {
  it("stops a model that repeats the same mutating call, keeping a valid ledger", async () => {
    const h = harness();
    const args = { targetId: "cat", x: 1 };
    let n = 0;
    const reply = vi.fn().mockImplementation(async () => ({ role: "assistant", content: null, tool_calls: [call(`r${n++}`, "set_sprite", args)] }));
    await expect(runAgent({ ...h.options, reply })).rejects.toThrow(/lặp lại/);
    // 2 real executions, then blocked repeats until the run is stopped.
    expect(vi.mocked(h.editor.tool).mock.calls.filter(([name]) => name === "set_sprite")).toHaveLength(2);
    expect(() => validateConversation(h.history)).not.toThrow();
  });
  it("honors a user-set step limit", async () => {
    const h = harness();
    let n = 0;
    const reply = vi.fn().mockImplementation(async () => ({ role: "assistant", content: null, tool_calls: [call(`s${n}`, "get_project", { offset: n++ })] }));
    await expect(runAgent({ ...h.options, reply, maxSteps: 4 })).rejects.toThrow(/4 bước/);
    expect(reply).toHaveBeenCalledTimes(4);
  });
  it("plan mode only lets reading tools run and sends the mode to the server", async () => {
    const h = harness();
    const reply = vi.fn()
      .mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("p1", "get_project"), call("p2", "add_scripts", { targetId: "cat", scripts: [[{ opcode: "event_whenflagclicked" }]] }), call("p3", "run_project")] })
      .mockResolvedValueOnce({ role: "assistant", content: "Kế hoạch: 1. ..." });
    await runAgent({ ...h.options, reply, mode: "plan", confirmTool: vi.fn().mockResolvedValue(true) });
    const executed = vi.mocked(h.editor.tool).mock.calls.map(([name]) => name);
    expect(executed).not.toContain("add_scripts");
    expect(executed).not.toContain("run_project");
    expect(reply.mock.calls[0][3]).toMatchObject({ mode: "plan" });
    expect(h.history.filter(m => m.role === "tool").map(m => m.content).join()).toContain("lập kế hoạch");
  });
  it("takes one undo snapshot per step before the first change and routes provider tools to the app", async () => {
    const h = harness();
    const beforeMutation = vi.fn().mockResolvedValue(undefined);
    const runProviderTool = vi.fn().mockResolvedValue({ index: 1, name: "rồng", image: "data:image/jpeg;base64,YWJj" });
    const reply = vi.fn()
      .mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("m1", "get_project"), call("m2", "generate_costume", { targetId: "cat", prompt: "con rồng" }), call("m3", "set_sprite", { targetId: "cat", x: 5 })] })
      .mockResolvedValueOnce({ role: "assistant", content: null, tool_calls: [call("m4", "get_project")] })
      .mockResolvedValueOnce({ role: "assistant", content: "Xong." });
    await runAgent({ ...h.options, reply, beforeMutation, runProviderTool });
    expect(beforeMutation).toHaveBeenCalledTimes(1);
    expect(runProviderTool).toHaveBeenCalledWith("generate_costume", { targetId: "cat", prompt: "con rồng" }, expect.anything());
    expect(h.editor.tool).not.toHaveBeenCalledWith("generate_costume", expect.anything());
    expect(h.history.find(m => m.role === "user" && Array.isArray(m.content) && m.content[1]?.type === "image_url")).toBeTruthy();
    expect(() => validateConversation(h.history)).not.toThrow();
  });
  it("accepts a prompt with attached images and never strips them while compacting", async () => {
    const h = harness();
    const prompt = [{ type: "text" as const, text: "Làm game giống ảnh này" }, { type: "image_url" as const, image_url: { url: "data:image/jpeg;base64,YWJj", detail: "high" as const } }];
    vi.mocked(h.editor.tool).mockImplementation(async name => name === "capture_stage" ? { image: "data:image/jpeg;base64,YWJj" } : { targets: [] });
    let n = 0;
    const sent: ChatMessage[][] = [];
    const reply = vi.fn().mockImplementation(async (messages: ChatMessage[]) => {
      sent.push([...messages]);
      return n < 6 ? { role: "assistant", content: null, tool_calls: [call(`c${n}`, "capture_stage", {}), call(`d${n}`, "get_project", { offset: n++ })] } : { role: "assistant", content: "Xong." };
    });
    await runAgent({ ...h.options, reply, prompt });
    for (const messages of sent) {
      expect(messages[0]).toEqual({ role: "user", content: prompt });
      expect(messages.slice(1).filter(m => m.role === "user" && Array.isArray(m.content)).length).toBeLessThanOrEqual(3);
    }
  });
  it("adds up token usage across steps", async () => {
    const h = harness();
    const onUsage = vi.fn();
    const reply = vi.fn().mockImplementation(async (_m: unknown, _p: unknown, _s: unknown, options: { onDelta(d: unknown): void }) => {
      options.onDelta({ usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } });
      return reply.mock.calls.length === 1 ? { role: "assistant", content: null, tool_calls: [call("u1")] } : { role: "assistant", content: "OK" };
    });
    await runAgent({ ...h.options, reply, onUsage });
    expect(onUsage).toHaveBeenLastCalledWith({ promptTokens: 200, completionTokens: 20, totalTokens: 220 });
  });
  it("treats user messages with attachments as turn boundaries when trimming", () => {
    const attached: ChatMessage = { role: "user", content: [{ type: "text", text: "ảnh" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJj", detail: "low" } }] };
    const filler = Array.from({ length: 70 }, (_, i): ChatMessage => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    const trimmed = trimHistory([...filler, attached, { role: "assistant", content: "ok" }]);
    expect(trimmed.length).toBeLessThanOrEqual(60);
    expect(trimmed).toContainEqual(attached);
  });
});
