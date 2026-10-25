import { IMAGE_URL_LIMIT } from "../../shared/chat";
import { guessImageModel, type AISettings } from "../../shared/models";
import type { EditorHandle } from "../components/ScratchEditor";

type Connection = Pick<AISettings, "baseUrl" | "apiKey">;
interface TargetInfo { id: string; name: string; isStage: boolean }

async function mediaRequest(path: string, connection: Connection, body: BodyInit, signal: AbortSignal, json = true) {
  const headers: Record<string, string> = { "X-Provider-Url": connection.baseUrl, "X-Provider-Key": connection.apiKey };
  if (json) headers["Content-Type"] = "application/json"; // FormData sets its own multipart boundary.
  const response = await fetch(`/api/media/${path}`, { method: "POST", headers, body, signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Tạo media thất bại (HTTP ${response.status}).`);
  }
  return response;
}

async function decodeImage(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try { const img = new Image(); img.src = url; await img.decode(); return img; }
  finally { URL.revokeObjectURL(url); }
}
function canvas(width: number, height: number) {
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(width)); c.height = Math.max(1, Math.round(height)); return c;
}

// Clears a plain background reachable from the image border (for providers without transparent output).
export function removeBackground(image: ImageData, tolerance = 42) {
  const { data, width, height } = image;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent++;
  if (transparent > width * height * 0.01) return false; // Already has real transparency.
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  const bg = [0, 1, 2].map(c => corners.reduce((sum, p) => sum + data[p * 4 + c], 0) / 4);
  const distance = (p: number) => Math.hypot(data[p * 4] - bg[0], data[p * 4 + 1] - bg[1], data[p * 4 + 2] - bg[2]);
  const seen = new Uint8Array(width * height), queue: number[] = [];
  const push = (p: number) => { if (!seen[p] && distance(p) < tolerance) { seen[p] = 1; queue.push(p); } };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (queue.length) {
    const p = queue.pop()!, x = p % width, y = (p - x) / width;
    data[p * 4 + 3] = 0;
    if (x > 0) push(p - 1); if (x < width - 1) push(p + 1); if (y > 0) push(p - width); if (y < height - 1) push(p + width);
  }
  // Soften the edge: partially fade near-background pixels touching the removed area.
  for (let p = 0; p < width * height; p++) {
    if (seen[p]) continue;
    const x = p % width, near = (x > 0 && seen[p - 1]) || (x < width - 1 && seen[p + 1]) || seen[p - width] || seen[p + width];
    if (near) { const d = distance(p); if (d < tolerance * 2) data[p * 4 + 3] = Math.min(data[p * 4 + 3], Math.round(255 * (d - tolerance) / tolerance)); }
  }
  return true;
}
function alphaBounds(image: ImageData) {
  const { data, width, height } = image;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
async function pngBytes(c: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Không mã hóa được ảnh PNG.");
  return blob.arrayBuffer();
}
// JPEG preview under the chat image limit, for the user and the vision model.
export function jpegPreview(source: CanvasImageSource, width: number, height: number, maxSide = 360) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const c = canvas(width * scale, height * scale), ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height); // JPEG has no alpha.
  ctx.drawImage(source, 0, 0, c.width, c.height);
  for (const quality of [0.8, 0.65, 0.5, 0.35]) {
    const url = c.toDataURL("image/jpeg", quality);
    if (url.length <= IMAGE_URL_LIMIT) return url;
  }
  throw new Error("Ảnh xem trước quá lớn.");
}

async function targetInfo(editor: EditorHandle, targetId: string) {
  const project = await editor.tool("get_project", { limit: 200 }) as { targets: TargetInfo[] };
  const target = project.targets.find(t => t.id === targetId);
  if (!target) throw new Error("Target không tồn tại. Gọi get_project để lấy ID mới.");
  return target;
}

export interface CostumeArgs { targetId: string; prompt: string; name?: string; fromIndex?: number; size?: number; removeBackground?: boolean }
export async function generateCostume(editor: EditorHandle, settings: AISettings, args: CostumeArgs, signal: AbortSignal) {
  if (!editor.internal) throw new Error("Editor chưa hỗ trợ thêm tài nguyên.");
  const model = settings.imageModel || guessImageModel(settings.models);
  if (!model) throw new Error("Chưa chọn model tạo ảnh. Mở Cài đặt AI → Tạo hình & âm thanh để chọn (ví dụ gpt-image-2).");
  const target = await targetInfo(editor, args.targetId);
  const style = target.isStage
    ? "Scratch game backdrop: a landscape scene that fills the whole image, bright and child-friendly, no text, no watermark."
    : "Scratch game sprite: one single character or object, full body, centered with padding, clean cartoon style with crisp outlines, readable when small, transparent background, no text, no frame, no ground shadow.";
  const prompt = `${args.prompt}\n\n${style}`;
  const size = target.isStage ? "1536x1024" : "1024x1024";
  let response: Response;
  if (args.fromIndex !== undefined) {
    // Image edit with the existing costume as reference keeps the same character across frames.
    const reference = await editor.internal("costumePng", { targetId: target.id, index: args.fromIndex, maxSide: 1024 }) as { bytes: ArrayBuffer };
    const form = new FormData();
    form.set("model", model); form.set("prompt", prompt); form.set("size", size); form.set("quality", settings.imageQuality);
    if (!target.isStage) form.set("background", "transparent");
    form.set("image", new Blob([reference.bytes], { type: "image/png" }), "reference.png");
    response = await mediaRequest("images/edits", settings, form, signal, false);
  } else {
    response = await mediaRequest("images/generations", settings, JSON.stringify({
      model, prompt, size, quality: settings.imageQuality, n: 1, ...(target.isStage ? {} : { background: "transparent" }),
    }), signal);
  }
  const data = await response.json() as { data?: { b64_json?: string; url?: string }[] };
  const item = data.data?.[0];
  let blob: Blob;
  if (item?.b64_json) blob = await (await fetch(`data:image/png;base64,${item.b64_json}`)).blob();
  else if (item?.url && /^https:\/\//.test(item.url)) {
    const image = await fetch(item.url, { signal }).catch(() => null);
    if (!image?.ok) throw new Error("Provider trả link ảnh nhưng trình duyệt không tải được (CORS). Thử model khác.");
    blob = await image.blob();
  } else throw new Error("Provider không trả về ảnh.");
  signal.throwIfAborted();
  const img = await decodeImage(blob);
  let output: HTMLCanvasElement, cx: number, cy: number;
  if (target.isStage) {
    // Cover-fit into 960x720 (2x of the 480x360 stage).
    output = canvas(960, 720);
    const scale = Math.max(960 / img.naturalWidth, 720 / img.naturalHeight), w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    output.getContext("2d")!.drawImage(img, (960 - w) / 2, (720 - h) / 2, w, h);
    cx = 480; cy = 360;
  } else {
    const source = canvas(img.naturalWidth, img.naturalHeight), sctx = source.getContext("2d")!;
    sctx.drawImage(img, 0, 0);
    const pixels = sctx.getImageData(0, 0, source.width, source.height);
    if (args.removeBackground !== false && removeBackground(pixels)) sctx.putImageData(pixels, 0, 0);
    const box = alphaBounds(pixels) ?? { x: 0, y: 0, width: source.width, height: source.height };
    // size is the longest side on stage; bitmaps are stored at 2x.
    const longest = (args.size ?? 160) * 2, scale = longest / Math.max(box.width, box.height);
    output = canvas(box.width * scale, box.height * scale);
    output.getContext("2d")!.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, output.width, output.height);
    cx = output.width / 2; cy = output.height / 2;
  }
  const bytes = await pngBytes(output);
  const added = await editor.internal("addAsset", {
    targetId: target.id, kind: "costume", name: args.name ?? args.prompt.slice(0, 40), format: "png", bytes,
    bitmapResolution: 2, rotationCenterX: cx, rotationCenterY: cy,
  }, [bytes]) as { index: number; name: string; count: number };
  return { ...added, targetId: target.id, model, stageSize: { width: Math.round(output.width / 2), height: Math.round(output.height / 2) }, image: jpegPreview(output, output.width, output.height) };
}

export interface SpeechArgs { targetId: string; text: string; name?: string; voice?: string }
export async function generateSpeech(editor: EditorHandle, settings: AISettings, args: SpeechArgs, signal: AbortSignal) {
  if (!editor.internal) throw new Error("Editor chưa hỗ trợ thêm tài nguyên.");
  if (!settings.speechModel) throw new Error("Chưa chọn model đọc chữ (TTS) trong Cài đặt AI. Provider hiện tại có thể không hỗ trợ; dùng create_sound cho hiệu ứng âm thanh.");
  const target = await targetInfo(editor, args.targetId);
  const response = await mediaRequest("audio/speech", settings, JSON.stringify({
    model: settings.speechModel, input: args.text, voice: args.voice ?? settings.speechVoice ?? "alloy", response_format: "mp3",
  }), signal);
  const type = response.headers.get("content-type") ?? "";
  if (!/^audio\//i.test(type)) throw new Error("Provider không trả về âm thanh.");
  const bytes = await response.arrayBuffer(), size = bytes.byteLength; // Transfer detaches the buffer.
  const format = /wav/i.test(type) ? "wav" : "mp3";
  const added = await editor.internal("addAsset", { targetId: target.id, kind: "sound", name: args.name ?? args.text.slice(0, 40), format, bytes }, [bytes]) as { index: number; name: string; count: number };
  return { ...added, targetId: target.id, model: settings.speechModel, bytes: size };
}
