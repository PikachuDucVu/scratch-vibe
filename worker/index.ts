import { requestAgent, type ProviderConfig } from "../server/agent";
import { chatRequestSchema } from "../shared/chat";
import { parseModelList } from "../shared/models";

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface Env {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  OPENAI_REASONING_EFFORT?: string;
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
  const baseUrl = env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const defaultModel = env.OPENAI_MODEL || (baseUrl.includes("ai.ducvu.io.vn") ? "gemini-3.8-flash-high" : "gpt-4.1");

  // GET /api/config
  if (url.pathname === "/api/config" && request.method === "GET") {
    return new Response(
      JSON.stringify({
        configured: Boolean(env.OPENAI_API_KEY),
        model: defaultModel,
        ...(env.OPENAI_REASONING_EFFORT ? { reasoningEffort: env.OPENAI_REASONING_EFFORT } : {}),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  // GET /api/models
  if (url.pathname === "/api/models" && request.method === "GET") {
    const rawUrl = url.searchParams.get("url")?.trim() ?? "";
    let targetUrl: URL;
    const headers: Record<string, string> = { Accept: "application/json" };

    if (rawUrl) {
      try {
        targetUrl = new URL(rawUrl);
        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
          return new Response(JSON.stringify({ error: "URL không hợp lệ. Phải là HTTP hoặc HTTPS." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
      } catch {
        return new Response(JSON.stringify({ error: "URL không đúng định dạng." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const base = new URL(baseUrl);
        if (targetUrl.host === base.host && env.OPENAI_API_KEY) {
          headers.Authorization = `Bearer ${env.OPENAI_API_KEY}`;
        }
      } catch { /* ignore */ }
    } else {
      try {
        targetUrl = new URL(`${baseUrl.replace(/\/$/, "")}/models`);
        if (env.OPENAI_API_KEY) {
          headers.Authorization = `Bearer ${env.OPENAI_API_KEY}`;
        }
      } catch {
        return new Response(JSON.stringify({ error: "Cấu hình OPENAI_BASE_URL không hợp lệ." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    try {
      const upstream = await fetch(targetUrl.toString(), {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!upstream.ok) {
        return new Response(JSON.stringify({ error: `Provider trả lỗi HTTP ${upstream.status} khi lấy danh sách model.` }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      const data = await upstream.json();
      const models = parseModelList(data);
      if (!models.length) {
        return new Response(JSON.stringify({ error: "Không tìm thấy danh sách model từ phản hồi của URL." }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ models }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      const msg = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "Quá thời gian chờ khi tải danh sách model (15 giây)."
        : "Không thể kết nối đến URL danh sách model.";
      return new Response(JSON.stringify({ error: msg }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // POST /api/agent
  if (url.pathname === "/api/agent" && request.method === "POST") {
    if (!env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "Chưa cấu hình OPENAI_API_KEY trên Cloudflare Worker." }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

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
      return new Response(JSON.stringify({ error: "Payload hội thoại không hợp lệ hoặc quá lớn." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const effectiveConfig: ProviderConfig = {
      apiKey: env.OPENAI_API_KEY,
      baseUrl,
      model: input.data.model?.trim() || defaultModel,
      reasoningEffort: input.data.reasoningEffort !== undefined
        ? (input.data.reasoningEffort ?? undefined)
        : (env.OPENAI_REASONING_EFFORT as any || undefined),
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
            delta => {
              writer.write(encoder.encode(`data: ${JSON.stringify({ type: "delta", delta })}\n\n`));
            }
          );
          writer.write(encoder.encode(`data: ${JSON.stringify({ type: "done", reply })}\n\n`));
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Không thể kết nối provider.";
          writer.write(encoder.encode(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`));
        } finally {
          writer.close();
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
        headers: { "Content-Type": "application/json" },
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
