import { messageSchema, type AgentReply, type ChatMessage, type ReasoningEffortOption } from "../../shared/chat";
import { parseModelList } from "../../shared/models";
import { parseTool } from "../../shared/tools";
import type { EditorHandle } from "../components/ScratchEditor";

export interface ToolEvent { id: string; name: string; status: "running" | "success" | "error"; detail?: string }
export interface AgentCallOptions {
  model?: string;
  reasoningEffort?: ReasoningEffortOption | null;
  onDelta?: (delta: { text?: string; reasoning?: string }) => void;
}

export async function fetchModelList(customUrl?: string, signal?: AbortSignal): Promise<string[]> {
  const trimmed = customUrl?.trim() ?? "";
  const query = trimmed ? `?url=${encodeURIComponent(trimmed)}` : "";
  try {
    const response = await fetch(`/api/models${query}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Không thể tải danh sách model.");
    return data.models as string[];
  } catch (error) {
    if (trimmed && !signal?.aborted) {
      try {
        const direct = await fetch(trimmed, { signal });
        if (direct.ok) {
          const parsed = parseModelList(await direct.json());
          if (parsed.length) return parsed;
        }
      } catch { /* fallback failed, throw original error */ }
    }
    throw error;
  }
}

export function trimHistory(history: ChatMessage[]) {
  let result = [...history];
  while (result.length > 60 || JSON.stringify(result).length > 450000) {
    const nextTurn = result.findIndex((message, index) => index > 0 && message.role === "user");
    if (nextTurn < 0) return []; // One huge turn: start a fresh conversation.
    result = result.slice(nextTurn);
  }
  return result;
}
export async function fetchReply(messages: ChatMessage[], project: unknown, signal: AbortSignal, agentConfig?: AgentCallOptions) {
  const body: Record<string, unknown> = { messages, project };
  if (agentConfig?.model) body.model = agentConfig.model;
  if (agentConfig?.reasoningEffort !== undefined) body.reasoningEffort = agentConfig.reasoningEffort;
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream, application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (response.ok && contentType.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalReply: AgentReply | null = null;
    let streamError: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const event = JSON.parse(payload) as
            | { type: "delta"; delta: { text?: string; reasoning?: string } }
            | { type: "done"; reply: AgentReply }
            | { type: "error"; error: string };
          if (event.type === "delta") {
            agentConfig?.onDelta?.(event.delta);
          } else if (event.type === "done") {
            finalReply = event.reply;
          } else if (event.type === "error") {
            streamError = event.error;
          }
        } catch { /* skip malformed line */ }
      }
    }

    if (streamError) throw new Error(streamError);
    if (!finalReply) throw new Error("Không nhận được phản hồi hoàn chỉnh từ agent.");
    const reply = messageSchema.parse({ role: "assistant", ...finalReply });
    if (reply.role !== "assistant") throw new Error("Phản hồi agent không hợp lệ.");
    return reply;
  }

  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Không kết nối được agent.");
  const reply = messageSchema.parse({ role: "assistant", ...data });
  if (reply.role !== "assistant") throw new Error("Phản hồi agent không hợp lệ.");
  return reply;
}

export async function runAgent(options: {
  editor: EditorHandle; history: ChatMessage[]; prompt: string; signal: AbortSignal;
  onHistory(messages: ChatMessage[]): void;
  onTool(event: ToolEvent): void;
  onStream?(text: string, reasoning: string): void;
  confirmReplace(targetId: string): Promise<boolean>;
  reply?: typeof fetchReply;
  model?: string;
  reasoningEffort?: ReasoningEffortOption | null;
}) {
  const { editor, signal, model, reasoningEffort, onStream } = options;
  const messages: ChatMessage[] = [...trimHistory(options.history), { role: "user", content: options.prompt }];
  options.onHistory([...messages]);
  let count = 0;
  for (let step = 0; step < 12; step++) {
    signal.throwIfAborted();
    const project = await editor.tool("get_project", {});
    signal.throwIfAborted();
    let streamText = "";
    let streamReasoning = "";
    const callOptions: AgentCallOptions = {
      model,
      reasoningEffort,
      ...(onStream ? {
        onDelta: delta => {
          if (delta.text) streamText += delta.text;
          if (delta.reasoning) streamReasoning += delta.reasoning;
          onStream(streamText, streamReasoning);
        },
      } : {}),
    };
    const reply = await (options.reply ?? fetchReply)(messages, project, signal, callOptions);
    signal.throwIfAborted();
    onStream?.("", "");
    messages.push(reply);
    if (!reply.tool_calls?.length) {
      options.onHistory([...messages]);
      return reply.content ?? "Đã hoàn thành.";
    }
    for (const call of reply.tool_calls) {
      const event = { id: call.id, name: call.function.name };
      options.onTool({ ...event, status: "running" });
      let result: unknown;
      try {
        signal.throwIfAborted();
        if (++count > 36) throw new Error("Vượt giới hạn 36 tool calls.");
        const args = parseTool(call.function.name, JSON.parse(call.function.arguments));
        if (call.function.name === "replace_scripts" && !await options.confirmReplace((args as { targetId: string }).targetId)) {
          throw new Error("Người dùng không cho phép thay thế scripts. Giữ nguyên code hiện tại.");
        }
        signal.throwIfAborted();
        result = await editor.tool(call.function.name, args);
        options.onTool({ ...event, status: "success", detail: JSON.stringify(result) });
      } catch (error) {
        const detail = signal.aborted ? "Đã dừng theo yêu cầu người dùng. Không thực thi các tool tiếp theo." : error instanceof Error ? error.message : String(error);
        result = { error: detail };
        options.onTool({ ...event, status: "error", detail });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) ?? "null" });
    }
    // Only persist complete tool batches, including cancelled/skipped calls.
    options.onHistory([...messages]);
    signal.throwIfAborted();
    if (count >= 36 || messages.length > 90) throw new Error("Đạt giới hạn tool/context của lượt này. Hãy kiểm tra project và gửi yêu cầu nhỏ hơn.");
  }
  throw new Error("Đạt giới hạn 12 bước. Thay đổi đã thực hiện được giữ lại; có thể hoàn tác hoặc gửi yêu cầu tiếp theo.");
}
