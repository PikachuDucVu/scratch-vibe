import { z } from "zod";
import type { ToolCall } from "./tools";
// Prefix of the text part that labels images produced by tools (not typed by the user).
export const TOOL_IMAGE_PREFIX = "[Ảnh từ tool]";
export const IMAGE_URL_LIMIT = 110000;
export const imageUrlSchema = z.string().max(IMAGE_URL_LIMIT).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/);
// One text part plus up to 3 images (user attachments or one tool image).
const imageContent = z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(6000) }).strict(),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: imageUrlSchema, detail: z.enum(["low", "high"]) }).strict() }).strict(),
])).min(1).max(4);
export type UserContent = string | z.infer<typeof imageContent>;
export function isToolImage(message: { role: string; content: unknown }) {
  return message.role === "user" && Array.isArray(message.content) &&
    message.content[0]?.type === "text" && String(message.content[0].text).startsWith(TOOL_IMAGE_PREFIX);
}
// A user turn starts at a message the person wrote: plain text or text + attached images.
export function isUserTurn(message: { role: string; content: unknown }) {
  return message.role === "user" && (typeof message.content === "string" || !isToolImage(message));
}
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
// build: make changes; plan: propose a plan only; explain: read and explain only; teach: small guided steps.
export const agentModeSchema = z.enum(["build", "plan", "explain", "teach"]);
export type AgentMode = z.infer<typeof agentModeSchema>;
export const languageSchema = z.enum(["vi", "en"]);
export type Language = z.infer<typeof languageSchema>;

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
