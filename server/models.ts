import { parseModelList } from "../shared/models";
import type { modelListRequestSchema } from "../shared/provider";
import type { z } from "zod";

export async function requestModels(config: z.infer<typeof modelListRequestSchema>) {
  const target = new URL(config.customModelsUrl || `${config.baseUrl}/models`);
  const headers: Record<string, string> = { Accept: "application/json" };
  // Never forward the provider's key to a different model-list origin.
  if (target.origin === new URL(config.baseUrl).origin) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  try {
    const upstream = await fetch(target.toString(), {
      // Workers reject redirect:"error"; "manual" returns 3xx, which !ok rejects below.
      headers, redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      return { status: 502, body: { error: `Provider trả lỗi HTTP ${upstream.status} khi lấy danh sách model.` } };
    }
    const models = parseModelList(await upstream.json());
    if (!models.length) {
      return { status: 422, body: { error: "Không tìm thấy danh sách model từ phản hồi của URL." } };
    }
    return { status: 200, body: { models } };
  } catch (error) {
    return {
      status: 502,
      body: {
        error: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "Quá thời gian chờ khi tải danh sách model (15 giây)."
          : "Không thể kết nối đến URL danh sách model.",
      },
    };
  }
}
