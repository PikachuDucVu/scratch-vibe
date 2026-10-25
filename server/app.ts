import express from "express";
import { resolve } from "node:path";
import { chatRequestSchema } from "../shared/chat";
import { DEFAULT_MODEL, modelListRequestSchema } from "../shared/provider";
import { requestModels } from "./models";
import { requestAgent, type ProviderConfig } from "./agent";
import { MEDIA_BODY_LIMIT, proxyMedia } from "./media";
import { withinNodeLimit } from "../shared/bounds";
import { Readable } from "node:stream";

export function createApp(options: { port: number; appOrigin: string; production?: boolean }) {
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
  // Registered before the JSON parser: media bodies pass through to the provider untouched.
  app.post(/^\/api\/media\/(images\/generations|images\/edits|audio\/speech)$/, express.raw({ type: () => true, limit: MEDIA_BODY_LIMIT }), async (req, res) => {
    const headers = new Headers();
    for (const name of ["x-provider-url", "x-provider-key", "content-type", "content-length"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const response = await proxyMedia(req.params[0], headers, async () => new Uint8Array(body).buffer, controller.signal);
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (!response.body) { res.end(); return; }
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
  });
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    if (req.method === "POST" && !withinNodeLimit(req.body)) { res.status(413).json({ error: "Request quá phức tạp." }); return; }
    next();
  });
  app.get("/api/config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Share links need cloud storage; only the Cloudflare deploy has it.
    res.json({ configured: false, model: DEFAULT_MODEL, share: false });
  });
  app.all(/^\/api\/share(\/.*)?$/, (_req, res) => { res.status(501).json({ error: "Chia sẻ chỉ có trên bản deploy Cloudflare." }); });
  app.post("/api/models", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const input = modelListRequestSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Nhập Custom URL hợp lệ và API key trong Cài đặt AI trên web." }); return;
    }
    const result = await requestModels(input.data);
    res.status(result.status).json(result.body);
  });
  let active = false;
  let requests: number[] = [];
  app.post("/api/agent", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success || JSON.stringify(input.data?.project ?? null).length > 80000) {
      res.status(400).json({ error: "Payload không hợp lệ hoặc quá lớn. Kiểm tra Custom URL và API key trong Cài đặt AI trên web." }); return;
    }
    requests = requests.filter(time => time > Date.now() - 60000);
    if (active || requests.length >= 120) { res.status(429).json({ error: "Agent đang bận xử lý yêu cầu khác. Thử lại sau." }); return; }
    requests.push(Date.now());
    active = true;
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", close);
    const effectiveConfig: ProviderConfig = {
      apiKey: input.data.apiKey,
      baseUrl: input.data.baseUrl,
      model: input.data.model || DEFAULT_MODEL,
      reasoningEffort: input.data.reasoningEffort ?? undefined,
      mode: input.data.mode,
      language: input.data.language,
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
