import { DEFAULT_MODEL } from "../shared/provider";

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }
interface KvStore {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
}

export interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
  // Optional so local tests and preview deploys work without the bindings.
  API_LIMITER?: RateLimiter;
  SHARE_LIMITER?: RateLimiter;
  SHARES?: KvStore;
}

const SHARE_LIMIT = 10 * 1024 * 1024;
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Serve API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx, url);
    }

    // Serve static frontend assets from dist/
    return env.ASSETS.fetch(request);
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

async function limited(limiter: RateLimiter | undefined, request: Request, group: string) {
  if (!limiter) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return !(await limiter.limit({ key: `${group}:${ip}` })).success;
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const origin = request.headers.get("origin");
  if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "Origin không được phép." }, 403);
  }
  // Browsers always send Origin on POST, so requiring it blocks plain scripted POSTs.
  if (request.method === "POST" && origin !== url.origin) return json({ error: "Thiếu Origin hợp lệ." }, 403);
  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({ configured: false, model: DEFAULT_MODEL, share: Boolean(env.SHARES) });
  }

  if (url.pathname === "/api/share" && request.method === "POST") {
    if (!env.SHARES) return json({ error: "Bản deploy này chưa bật chia sẻ." }, 501);
    if (await limited(env.SHARE_LIMITER, request, "share")) return json({ error: "Chia sẻ quá nhiều. Thử lại sau một phút." }, 429);
    const length = Number(request.headers.get("content-length"));
    if (!Number.isFinite(length) || length <= 0) return json({ error: "Thiếu Content-Length." }, 411);
    if (length > SHARE_LIMIT) return json({ error: "Project vượt 10 MB, không chia sẻ được." }, 413);
    const bytes = await request.arrayBuffer();
    const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
    // .sb3 is a ZIP archive; reject anything else so the store is not a generic file host.
    if (bytes.byteLength > SHARE_LIMIT || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
      return json({ error: "Chỉ chia sẻ được file Scratch .sb3." }, 400);
    }
    const id = shareId();
    await env.SHARES.put(id, bytes, { expirationTtl: SHARE_TTL_SECONDS, metadata: { size: bytes.byteLength, createdAt: new Date().toISOString() } });
    return json({ id, url: `${url.origin}/?share=${id}`, expiresInDays: 30 });
  }
  const share = /^\/api\/share\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
  if (share && request.method === "GET") {
    if (!env.SHARES) return json({ error: "Bản deploy này chưa bật chia sẻ." }, 501);
    if (await limited(env.API_LIMITER, request, "share-get")) return json({ error: "Quá nhiều yêu cầu. Thử lại sau một phút." }, 429);
    const bytes = await env.SHARES.get(share[1], "arrayBuffer");
    if (!bytes) return json({ error: "Link chia sẻ không tồn tại hoặc đã hết hạn." }, 404);
    return new Response(bytes, { headers: { "Content-Type": "application/x.scratch.sb3", "Cache-Control": "private, max-age=3600" } });
  }

  // GET /api/scratch-assets/*
  if (url.pathname.startsWith("/api/scratch-assets/") && request.method === "GET") {
    const path = url.pathname.slice("/api/scratch-assets/".length);
    if (!/^internalapi\/asset\/[a-f0-9]{32}\.(svg|png|jpg|jpeg|gif|wav|mp3)\/get\/?$/i.test(path)) {
      return json({ error: "Scratch asset không hợp lệ." }, 400);
    }
    try {
      const upstream = await fetch(`https://assets.scratch.mit.edu/${path.replace(/\/$/, "")}/`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!upstream.ok) {
        return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
      }
      const headers = new Headers(upstream.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(upstream.body, { status: 200, headers });
    } catch {
      return json({ error: "Không tải được asset từ Scratch CDN." }, 502);
    }
  }

  return json({ error: "API không tồn tại." }, 404);
}

// 128-bit random, URL-safe, 22 characters: unguessable share links.
function shareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
