import { describe, expect, it, vi } from "vitest";
import { runAgent, trimHistory, type ToolEvent } from "../src/agent/loop";
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
  it("bounds iterations and keeps complete tool batches", async () => {
    const h = harness();
    let number = 0;
    const reply = vi.fn().mockImplementation(async () => ({ role: "assistant", content: null, tool_calls: [call(`a${number++}`)] }));
    await expect(runAgent({ ...h.options, reply })).rejects.toThrow(/12 bước/);
    expect(reply).toHaveBeenCalledTimes(12);
    expect(() => validateConversation(h.history)).not.toThrow();
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
    expect(reply).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), {
      model: "o3-mini",
      reasoningEffort: "high",
    });
  });
});
