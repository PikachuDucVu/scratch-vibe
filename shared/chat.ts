import { z } from "zod";
import type { ToolCall } from "./tools";
import { providerConnectionSchema } from "./provider";
const imageContent = z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(6000) }).strict(),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string().max(110000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/), detail: z.literal("low") }).strict() }).strict(),
])).min(1).max(2);
const callSchema = z.object({
  id: z.string().min(1).max(120), type: z.literal("function"),
  function: z.object({ name: z.string().min(1).max(80), arguments: z.string().max(100000) }).strict(),
}).strict();
export const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.union([z.string().min(1).max(6000), imageContent]) }).strict(),
  z.object({ role: z.literal("assistant"), content: z.string().max(30000).nullable(), tool_calls: z.array(callSchema).max(8).optional() }).strict(),
  z.object({ role: z.literal("tool"), tool_call_id: z.string().max(120), content: z.string().max(120000) }).strict(),
]);
export type ChatMessage = z.infer<typeof messageSchema>;
export interface AgentReply { content: string | null; tool_calls?: ToolCall[] }

export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);
export type ReasoningEffortOption = z.infer<typeof reasoningEffortSchema>;

export const chatRequestSchema = providerConnectionSchema.extend({
  messages: z.array(messageSchema).min(1).max(100),
  project: z.unknown(),
  model: z.string().trim().min(1).max(200).optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
}).strict();

export function validateConversation(messages: ChatMessage[]) {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) throw new Error("Tool result không khớp tool call.");
    } else {
      if (pending.size) throw new Error("Thiếu kết quả tool call trước lượt tiếp theo.");
      if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
        if (seen.has(call.id)) throw new Error("Tool call ID bị trùng.");
        seen.add(call.id);
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error("Thiếu kết quả tool call.");
  if (messages[0].role !== "user") throw new Error("Hội thoại phải bắt đầu bằng user.");
}
