import { parseModelList } from "./models";
import { PROVIDER_UNREACHABLE, providerRedirectMessage, type modelListRequestSchema } from "./provider";
import type { z } from "zod";

export async function requestModels(config: z.infer<typeof modelListRequestSchema>, signal?: AbortSignal) {
  const target = new URL(config.customModelsUrl || `${config.baseUrl}/models`);
  const headers: Record<string, string> = { Accept: "application/json" };
  // Never forward the provider's key to a different model-list origin.
  if (target.origin === new URL(config.baseUrl).origin) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const timeout = AbortSignal.timeout(15000);
  try {
    const upstream = await fetch(target.toString(), {
      // "manual" keeps the key from following a redirect; the 3xx (or browser opaque redirect) is rejected below.
      headers, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      return { status: 502, body: { error: providerRedirectMessage(upstream.status, upstream.headers.get("location"), target.toString()) } };
    }
    if (!upstream.ok) {
      return { status: 502, body: { error: `Provider trả lỗi HTTP ${upstream.status} khi lấy danh sách model.` } };
    }
    const models = parseModelList(await upstream.json());
    if (!models.length) {
      return { status: 422, body: { error: "Không tìm thấy danh sách model từ phản hồi của URL." } };
    }
    return { status: 200, body: { models } };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      status: 502,
      body: {
        error: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "Quá thời gian chờ khi tải danh sách model (15 giây)."
          : PROVIDER_UNREACHABLE,
      },
    };
  }
}
