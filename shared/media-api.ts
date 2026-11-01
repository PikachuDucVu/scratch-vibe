import { PROVIDER_UNREACHABLE, providerConnectionSchema, providerRedirectMessage } from "./provider";

// Fixed provider endpoints only; the caller builds the provider body itself.
export const MEDIA_PATHS: Record<string, string> = {
  "images/generations": "application/json",
  "images/edits": "multipart/form-data",
  "audio/speech": "application/json",
};
export const MEDIA_BODY_LIMIT = 12 * 1024 * 1024;
export const MEDIA_RESPONSE_LIMIT = 20 * 1024 * 1024;
const RESPONSE_TYPES = /^(application\/json|image\/(png|jpeg|webp)|audio\/(mpeg|mp3|wav|x-wav|wave|ogg|aac|flac))\b/i;

function providerError(status: number, code?: string) {
  if (status === 401 || status === 403) return "Provider từ chối API key. Kiểm tra Cài đặt AI trên web.";
  if (status === 429) return "Provider đã giới hạn yêu cầu hoặc hết quota. Thử lại sau.";
  if (code === "model_not_found" || status === 404) return "Provider không có model/endpoint này. Chọn model khác trong Cài đặt AI.";
  return `Provider trả lỗi HTTP ${status}${code ? ` (${code})` : ""}.`;
}

// Calls one provider media endpoint directly and returns the successful response; throws a short Vietnamese error otherwise.
// `body` is JSON text for generations/speech and FormData for edits (the browser sets the multipart boundary).
export async function requestMedia(path: string, connection: { baseUrl: string; apiKey: string }, body: string | FormData, signal: AbortSignal): Promise<Response> {
  const expected = MEDIA_PATHS[path];
  if (!expected) throw new Error("Media API không tồn tại.");
  const parsed = providerConnectionSchema.safeParse({ baseUrl: connection.baseUrl, apiKey: connection.apiKey }); // The schema is strict: callers pass whole settings objects.
  if (!parsed.success) throw new Error("Nhập Custom URL hợp lệ và API key trong Cài đặt AI trên web.");
  if (typeof body === "string" && body.length > MEDIA_BODY_LIMIT) throw new Error("Request quá lớn.");
  const endpoint = `${parsed.data.baseUrl}/${path}`;
  const timeout = AbortSignal.timeout(300000);
  const headers: Record<string, string> = { Authorization: `Bearer ${parsed.data.apiKey}` };
  if (typeof body === "string") headers["Content-Type"] = expected;
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, { method: "POST", body, redirect: "manual", signal: AbortSignal.any([signal, timeout]), headers });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(error instanceof Error && error.name === "TimeoutError" ? "Provider tạo media quá 5 phút." : PROVIDER_UNREACHABLE);
  }
  if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
    throw new Error(providerRedirectMessage(upstream.status, upstream.headers.get("location"), endpoint));
  }
  if (!upstream.ok) {
    // Never echo upstream bodies; only a short machine-readable error code.
    let code: string | undefined;
    try {
      const text = (await upstream.text()).slice(0, 4096);
      const raw = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
      if (typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw)) code = raw;
    } catch { /* non-JSON error body */ }
    throw new Error(providerError(upstream.status, code));
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!RESPONSE_TYPES.test(contentType) || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    throw new Error("Provider trả dữ liệu không hỗ trợ.");
  }
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MEDIA_RESPONSE_LIMIT) {
    await upstream.body.cancel().catch(() => {});
    throw new Error("Phản hồi media quá lớn.");
  }
  let bytes = 0;
  const limited = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MEDIA_RESPONSE_LIMIT) controller.error(new Error("Phản hồi media quá lớn."));
      else controller.enqueue(chunk);
    },
  }));
  return new Response(limited, { status: 200, headers: { "Content-Type": contentType } });
}
