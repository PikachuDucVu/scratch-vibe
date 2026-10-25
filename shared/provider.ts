import { z } from "zod";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4.1";

export const providerUrlSchema = z.string().trim().min(1).max(2048).superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Custom URL phải dùng HTTPS (hoặc HTTP localhost cho model local)." });
    }
    if (url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Custom URL không được chứa tài khoản, query hoặc fragment." });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Custom URL không đúng định dạng." });
  }
}).transform(value => value.replace(/\/+$/, ""));

export const providerConnectionSchema = z.object({
  baseUrl: providerUrlSchema,
  apiKey: z.string().trim().min(1, "Nhập API key trong Cài đặt AI trên web.").max(4096).regex(/^[^\s\u0000-\u001f\u007f]+$/, "API key không hợp lệ."),
}).strict();

export const modelListRequestSchema = providerConnectionSchema.extend({
  customModelsUrl: z.union([z.literal(""), providerUrlSchema]).optional(),
}).strict();

export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
