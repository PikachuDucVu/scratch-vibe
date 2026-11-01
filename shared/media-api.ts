import { providerConnectionSchema } from "../shared/provider";

// Fixed provider endpoints only; the browser builds the provider body itself.
export const MEDIA_PATHS: Record<string, string> = {
  "images/generations": "application/json",
  "images/edits": "multipart/form-data",
  "audio/speech": "application/json",
};
export const MEDIA_BODY_LIMIT = 12 * 1024 * 1024;
export const MEDIA_RESPONSE_LIMIT = 20 * 1024 * 1024;
const RESPONSE_TYPES = /^(application\/json|image\/(png|jpeg|webp)|audio\/(mpeg|mp3|wav|x-wav|wave|ogg|aac|flac))\b/i;

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

function providerError(status: number, code?: string) {
  if (status === 401 || status === 403) return "Provider từ chối API key. Kiểm tra Cài đặt AI trên web.";
  if (status === 429) return "Provider đã giới hạn yêu cầu hoặc hết quota. Thử lại sau.";
  if (code === "model_not_found" || status === 404) return "Provider không có model/endpoint này. Chọn model khác trong Cài đặt AI.";
  return `Provider trả lỗi HTTP ${status}${code ? ` (${code})` : ""}.`;
}

// Proxies one media request. Credentials travel in headers so the body passes through untouched
// (no parsing of multi-megabyte payloads; Workers have a small CPU budget).
export async function proxyMedia(path: string, headers: Headers, readBody: () => Promise<ArrayBuffer>, signal?: AbortSignal): Promise<Response> {
  const expected = MEDIA_PATHS[path];
  if (!expected) return json({ error: "Media API không tồn tại." }, 404);
  const connection = providerConnectionSchema.safeParse({ baseUrl: headers.get("x-provider-url") ?? "", apiKey: headers.get("x-provider-key") ?? "" });
  if (!connection.success) return json({ error: "Nhập Custom URL hợp lệ và API key trong Cài đặt AI trên web." }, 400);
  const type = headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith(expected)) return json({ error: "Kiểu nội dung không hợp lệ." }, 415);
  const length = Number(headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) return json({ error: "Thiếu Content-Length." }, 411);
  if (length > MEDIA_BODY_LIMIT) return json({ error: "Request quá lớn." }, 413);
  const body = await readBody();
  if (body.byteLength > MEDIA_BODY_LIMIT) return json({ error: "Request quá lớn." }, 413);
  const timeout = AbortSignal.timeout(300000);
  let upstream: Response;
  try {
    upstream = await fetch(`${connection.data.baseUrl}/${path}`, {
      method: "POST", body, redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${connection.data.apiKey}`, "Content-Type": type },
    });
  } catch (error) {
    return json({ error: error instanceof Error && error.name === "TimeoutError" ? "Provider tạo media quá 5 phút." : "Không thể kết nối provider." }, 502);
  }
  if (!upstream.ok) {
    // Never echo upstream bodies; only a short machine-readable error code.
    let code: string | undefined;
    try {
      const text = (await upstream.text()).slice(0, 4096);
      const raw = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
      if (typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw)) code = raw;
    } catch { /* non-JSON error body */ }
    return json({ error: providerError(upstream.status, code) }, 502);
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!RESPONSE_TYPES.test(contentType) || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    return json({ error: "Provider trả dữ liệu không hỗ trợ." }, 502);
  }
  let bytes = 0;
  const limited = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MEDIA_RESPONSE_LIMIT) controller.error(new Error("Phản hồi media quá lớn."));
      else controller.enqueue(chunk);
    },
  }));
  return new Response(limited, { status: 200, headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
}
