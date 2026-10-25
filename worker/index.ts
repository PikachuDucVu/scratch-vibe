import { requestAgent, type ProviderConfig } from "../server/agent";
import { chatRequestSchema } from "../shared/chat";
import { DEFAULT_MODEL, modelListRequestSchema } from "../shared/provider";
import { requestModels } from "../server/models";

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
}

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

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  // Credentials are per request, configured only in the web UI.
  const origin = request.headers.get("origin");
  if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "Origin không được phép." }, 403);
  }
  if (url.pathname === "/api/config" && request.method === "GET") {
    return json({ configured: false, model: DEFAULT_MODEL });
  }
  if (url.pathname === "/api/models" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); }
    catch { return json({ error: "Request JSON không hợp lệ." }, 400); }
    const input = modelListRequestSchema.safeParse(body);
    if (!input.success) return json({ error: "Nhập Custom URL hợp lệ và API key trong Cài đặt AI trên web." }, 400);
    const result = await requestModels(input.data);
    return json(result.body, result.status);
  }

  // POST /api/agent
  if (url.pathname === "/api/agent" && request.method === "POST") {
    let bodyData: unknown;
    try {
      bodyData = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Request JSON không hợp lệ." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const input = chatRequestSchema.safeParse(bodyData);
    if (!input.success || JSON.stringify(input.data?.project ?? null).length > 80000) {
      return new Response(JSON.stringify({ error: "Payload không hợp lệ hoặc quá lớn. Kiểm tra Custom URL và API key trong Cài đặt AI trên web." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const effectiveConfig: ProviderConfig = {
      apiKey: input.data.apiKey,
      baseUrl: input.data.baseUrl,
      model: input.data.model || DEFAULT_MODEL,
      reasoningEffort: input.data.reasoningEffort ?? undefined,
    };

    const acceptsSSE = request.headers.get("accept")?.includes("text/event-stream");
    if (acceptsSSE) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      ctx.waitUntil((async () => {
        try {
          const reply = await requestAgent(
            effectiveConfig,
            input.data.messages,
            input.data.project,
            request.signal,
            async delta => {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "delta", delta })}\n\n`));
            }
          );
          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "done", reply })}\n\n`));
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Không thể kết nối provider.";
          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`)).catch(() => {});
        } finally {
          await writer.close().catch(() => {});
        }
      })());

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    }

    try {
      const reply = await requestAgent(
        effectiveConfig,
        input.data.messages,
        input.data.project,
        request.signal
      );
      return new Response(JSON.stringify(reply), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : "Không thể kết nối provider." }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  // GET /api/scratch-assets/*
  if (url.pathname.startsWith("/api/scratch-assets/") && request.method === "GET") {
    const path = url.pathname.slice("/api/scratch-assets/".length);
    if (!/^internalapi\/asset\/[a-f0-9]{32}\.(svg|png|jpg|jpeg|gif|wav|mp3)\/get\/?$/i.test(path)) {
      return new Response(JSON.stringify({ error: "Scratch asset không hợp lệ." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
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
      return new Response(JSON.stringify({ error: "Không tải được asset từ Scratch CDN." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "API không tồn tại." }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
