import express from "express";
import { resolve } from "node:path";
import { chatRequestSchema } from "../shared/chat";
import { parseModelList } from "../shared/models";
import { requestAgent, type ProviderConfig } from "./agent";

export function createApp(options: { config: ProviderConfig; port: number; appOrigin: string; production?: boolean }) {
  const app = express();
  app.disable("x-powered-by");
  const origins = new Set([options.appOrigin, `http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`]);
  if (options.appOrigin === "http://127.0.0.1:5173") origins.add("http://localhost:5173");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(req.hostname)) {
      res.status(403).json({ error: "Chỉ cho phép host loopback." }); return;
    }
    if (req.path.startsWith("/api/") && ((req.headers.origin && !origins.has(req.headers.origin)) || req.headers["sec-fetch-site"] === "cross-site")) {
      res.status(403).json({ error: "Origin không được phép." }); return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      configured: Boolean(options.config.apiKey),
      model: options.config.model,
      ...(options.config.reasoningEffort ? { reasoningEffort: options.config.reasoningEffort } : {}),
    });
  });
  app.get("/api/models", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
    let targetUrl: URL;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (rawUrl) {
      try {
        targetUrl = new URL(rawUrl);
        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
          res.status(400).json({ error: "URL không hợp lệ. Chỉ chấp nhận HTTP hoặc HTTPS." }); return;
        }
      } catch {
        res.status(400).json({ error: "URL không đúng định dạng." }); return;
      }
      try {
        const base = new URL(options.config.baseUrl);
        if (targetUrl.host === base.host && options.config.apiKey) {
          headers.Authorization = `Bearer ${options.config.apiKey}`;
        }
      } catch { /* ignore */ }
    } else {
      try {
        targetUrl = new URL(`${options.config.baseUrl.replace(/\/$/, "")}/models`);
        if (options.config.apiKey) {
          headers.Authorization = `Bearer ${options.config.apiKey}`;
        }
      } catch {
        res.status(500).json({ error: "Cấu hình OPENAI_BASE_URL không hợp lệ." }); return;
      }
    }
    try {
      const upstream = await fetch(targetUrl.toString(), { headers, signal: AbortSignal.timeout(15000) });
      if (!upstream.ok) {
        res.status(502).json({ error: `Provider trả lỗi HTTP ${upstream.status} khi lấy danh sách model.` }); return;
      }
      const data = await upstream.json();
      const models = parseModelList(data);
      if (!models.length) {
        res.status(422).json({ error: "Không tìm thấy danh sách model từ phản hồi của URL." }); return;
      }
      res.json({ models });
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "Quá thời gian chờ khi tải danh sách model (15 giây)."
          : "Không thể kết nối đến URL danh sách model.",
      });
    }
  });
  let active = false;
  let requests: number[] = [];
  app.post("/api/agent", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!options.config.apiKey) { res.status(503).json({ error: "Chưa cấu hình OPENAI_API_KEY trong .env ở server." }); return; }
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success || JSON.stringify(input.data?.project ?? null).length > 80000) {
      res.status(400).json({ error: "Payload hội thoại không hợp lệ hoặc quá lớn." }); return;
    }
    requests = requests.filter(time => time > Date.now() - 60000);
    if (active || requests.length >= 120) { res.status(429).json({ error: "Agent đang bận xử lý yêu cầu khác. Thử lại sau." }); return; }
    requests.push(Date.now());
    active = true;
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", close);
    const effectiveConfig: ProviderConfig = {
      ...options.config,
      model: input.data.model?.trim() || options.config.model,
      reasoningEffort: input.data.reasoningEffort !== undefined
        ? (input.data.reasoningEffort ?? undefined)
        : options.config.reasoningEffort,
    };

    const acceptsSSE = req.headers.accept?.includes("text/event-stream");
    if (acceptsSSE) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      try {
        const reply = await requestAgent(
          effectiveConfig,
          input.data.messages,
          input.data.project,
          controller.signal,
          delta => {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "delta", delta })}\n\n`);
            }
          }
        );
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "done", reply })}\n\n`);
          res.end();
        }
      } catch (error) {
        if (!res.writableEnded && !controller.signal.aborted) {
          const msg = error instanceof Error ? error.message : "Không thể kết nối provider.";
          res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
          res.end();
        }
      } finally {
        active = false;
        res.off("close", close);
      }
      return;
    }

    try {
      const reply = await requestAgent(effectiveConfig, input.data.messages, input.data.project, controller.signal);
      if (!controller.signal.aborted) res.json(reply);
    } catch (error) {
      if (!controller.signal.aborted) res.status(502).json({ error: error instanceof Error ? error.message : "Không thể kết nối provider." });
    } finally {
      active = false;
      res.off("close", close);
    }
  });
  app.get(/^\/api\/scratch-assets\/(.*)$/, async (req, res) => {
    const path = req.path.slice("/api/scratch-assets/".length);
    if (!/^internalapi\/asset\/[a-f0-9]{32}\.(svg|png|jpg|jpeg|gif|wav|mp3)\/get\/?$/i.test(path)) {
      res.status(400).json({ error: "Scratch asset không hợp lệ." }); return;
    }
    try {
      const upstream = await fetch(`https://assets.scratch.mit.edu/${path.replace(/\/$/, "")}/`, { signal: AbortSignal.timeout(20000) });
      if (!upstream.ok) { res.status(upstream.status === 404 ? 404 : 502).end(); return; }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      if (buffer.length > 20 * 1024 * 1024) throw new Error("Asset quá lớn.");
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(buffer);
    } catch { res.status(502).json({ error: "Không tải được asset từ Scratch CDN." }); }
  });
  app.use("/api", (_req, res) => { res.status(404).json({ error: "API không tồn tại." }); });
  if (options.production) app.use(express.static(resolve("dist")));
  const errorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? "Request quá lớn." : "Request JSON không hợp lệ." });
  };
  app.use(errorHandler);
  return app;
}
