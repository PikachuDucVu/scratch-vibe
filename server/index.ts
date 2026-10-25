import "dotenv/config";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT không hợp lệ.");
const production = process.argv.includes("--production");
const app = createApp({
  port, appOrigin: process.env.APP_ORIGIN ?? "http://127.0.0.1:5173", production,
});
app.listen(port, "127.0.0.1", () => {
  console.log(`Scratch Vibe ${production ? "app" : "API"}: http://127.0.0.1:${port}`);
  console.log("Cấu hình Custom URL và API key trong Cài đặt AI trên web; editor và demo không cần key.");
});
