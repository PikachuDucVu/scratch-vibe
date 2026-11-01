import express from "express";
import { resolve } from "node:path";
import { DEFAULT_MODEL } from "../shared/provider";

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
  app.get("/api/config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Share links need cloud storage; only the Cloudflare deploy has it.
    res.json({ configured: false, model: DEFAULT_MODEL, share: false });
  });
  app.all(/^\/api\/share(\/.*)?$/, (_req, res) => { res.status(501).json({ error: "Chia sẻ chỉ có trên bản deploy Cloudflare." }); });
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
  return app;
}
