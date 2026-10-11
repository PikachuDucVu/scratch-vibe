import "dotenv/config";
import { createApp } from "./app";
import type { ReasoningEffort } from "./agent";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT không hợp lệ.");
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const url = new URL(baseUrl);
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
  throw new Error("OPENAI_BASE_URL phải dùng HTTPS (hoặc HTTP localhost cho model local).");
}
const reasoningEffort = process.env.OPENAI_REASONING_EFFORT?.trim() || undefined;
if (reasoningEffort && !["low", "medium", "high"].includes(reasoningEffort)) {
  throw new Error("OPENAI_REASONING_EFFORT phải là low, medium hoặc high (hoặc để trống).");
}
const production = process.argv.includes("--production");
const defaultModel = process.env.OPENAI_MODEL ?? (baseUrl.includes("ai.ducvu.io.vn") ? "gemini-3.8-flash-high" : "gpt-4.1");
const app = createApp({
  config: { apiKey: process.env.OPENAI_API_KEY ?? "", model: defaultModel, baseUrl, reasoningEffort: reasoningEffort as ReasoningEffort | undefined },
  port, appOrigin: process.env.APP_ORIGIN ?? "http://127.0.0.1:5173", production,
});
app.listen(port, "127.0.0.1", () => {
  console.log(`Scratch Vibe ${production ? "app" : "API"}: http://127.0.0.1:${port}`);
  if (!process.env.OPENAI_API_KEY) console.log("Chat AI chưa bật. Điền OPENAI_API_KEY trong .env; editor và demo vẫn hoạt động.");
});
