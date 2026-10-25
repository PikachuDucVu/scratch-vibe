import { assertAssetsLoaded } from "./assets";
import { findTarget, originals, refresh, vmBytes, type Asset, type Invocation, type ScratchVm, type VmTarget } from "./vm-types";

const IMAGE_TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" };
const MAX_CANVAS = 2400; // Pixels per side; Scratch bitmaps are stored at 2x stage size.
const SAMPLE_RATE = 44100;

export async function loadImage(src: string) {
  const img = new Image(); img.src = src; await img.decode(); return img;
}
function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.min(MAX_CANVAS, Math.round(width)));
  canvas.height = Math.max(1, Math.min(MAX_CANVAS, Math.round(height)));
  return canvas;
}
function assetData(asset: Asset) {
  const data = (asset.asset as { data?: Uint8Array } | undefined)?.data;
  if (!data?.length) throw new Error("Không đọc được dữ liệu của tài nguyên này.");
  // Copy into this realm: asset bytes belong to the parent editor's window.
  return new Uint8Array(data);
}

// A costume rendered at 2x stage resolution (Scratch's bitmapResolution 2) with its rotation center.
export interface Raster { canvas: HTMLCanvasElement; cx: number; cy: number }
export async function renderCostume(costume: Asset): Promise<Raster> {
  const format = String(costume.dataFormat).toLowerCase(), type = IMAGE_TYPES[format];
  if (!type) throw new Error("Định dạng costume không hỗ trợ.");
  const url = URL.createObjectURL(new Blob([assetData(costume)], { type }));
  try {
    const img = await loadImage(url);
    // SVGs without width/height report 0; fall back to the browser's default replaced size.
    const width = img.naturalWidth || 300, height = img.naturalHeight || 150;
    const factor = format === "svg" ? 2 : 2 / (Number(costume.bitmapResolution) || 1);
    const canvas = canvasOf(width * factor, height * factor);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    // rotationCenter is in the image's own pixel/unit space for both SVG and bitmaps.
    const scale = canvas.width / width;
    const cx = Number.isFinite(Number(costume.rotationCenterX)) ? Number(costume.rotationCenterX) : width / 2;
    const cy = Number.isFinite(Number(costume.rotationCenterY)) ? Number(costume.rotationCenterY) : height / 2;
    return { canvas, cx: cx * scale, cy: cy * scale };
  } finally { URL.revokeObjectURL(url); }
}

function transformed(src: Raster, matrix: DOMMatrix): Raster {
  const corners = [[0, 0], [src.canvas.width, 0], [0, src.canvas.height], [src.canvas.width, src.canvas.height]].map(([x, y]) => matrix.transformPoint({ x, y }));
  const minX = Math.min(...corners.map(p => p.x)), minY = Math.min(...corners.map(p => p.y));
  const width = Math.max(...corners.map(p => p.x)) - minX, height = Math.max(...corners.map(p => p.y)) - minY;
  if (width > MAX_CANVAS || height > MAX_CANVAS) throw new Error("Costume sau biến đổi quá lớn; giảm scale.");
  const canvas = canvasOf(width, height), ctx = canvas.getContext("2d")!;
  const placed = new DOMMatrix().translate(-minX, -minY).multiply(matrix);
  ctx.setTransform(placed); ctx.drawImage(src.canvas, 0, 0);
  const center = placed.transformPoint({ x: src.cx, y: src.cy });
  return { canvas, cx: center.x, cy: center.y };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (t: number) => {
    t = (t % 1 + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return v * 255;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}
type CostumeOp = Extract<Invocation, { name: "edit_costume" }>["args"]["operations"][number];
export function applyCostumeOps(src: Raster, operations: CostumeOp[]): Raster {
  let raster = src;
  for (const op of operations) {
    if (op.type === "flip") raster = transformed(raster, op.axis === "horizontal" ? new DOMMatrix().scale(-1, 1) : new DOMMatrix().scale(1, -1));
    else if (op.type === "rotate") raster = transformed(raster, new DOMMatrix().rotate(op.degrees));
    else if (op.type === "scale") raster = transformed(raster, new DOMMatrix().scale(op.factor));
    else {
      const ctx = raster.canvas.getContext("2d")!, image = ctx.getImageData(0, 0, raster.canvas.width, raster.canvas.height), px = image.data;
      const tint = op.type === "tint" ? [1, 3, 5].map(i => parseInt(op.color.slice(i, i + 2), 16)) : null;
      for (let i = 0; i < px.length; i += 4) {
        if (op.type === "opacity") { px[i + 3] = px[i + 3] * op.amount / 100; continue; }
        let [r, g, b] = [px[i], px[i + 1], px[i + 2]];
        if (op.type === "grayscale") r = g = b = 0.299 * r + 0.587 * g + 0.114 * b;
        else if (op.type === "brightness") { const add = op.amount * 2.55; r += add; g += add; b += add; }
        else if (op.type === "tint") { const t = op.amount / 100; r += (tint![0] - r) * t; g += (tint![1] - g) * t; b += (tint![2] - b) * t; }
        else {
          const [h, s, l] = rgbToHsl(r, g, b);
          [r, g, b] = op.type === "hue" ? hslToRgb(h + op.degrees / 360, s, l) : hslToRgb(h, Math.max(0, Math.min(1, s * (1 + op.amount / 100))), l);
        }
        px[i] = r; px[i + 1] = g; px[i + 2] = b; // Uint8ClampedArray clamps to 0..255.
      }
      ctx.putImageData(image, 0, 0);
    }
  }
  return raster;
}

async function pngBytes(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Không mã hóa được ảnh PNG.");
  return new Uint8Array(await blob.arrayBuffer());
}

export interface NewAsset { kind: "costume" | "sound"; name: string; format: "png" | "svg" | "wav" | "mp3"; bytes: Uint8Array; rotationCenterX?: number; rotationCenterY?: number; bitmapResolution?: number }
// Adds an asset and returns its index; with replaceIndex, the new asset takes that slot.
export async function addAsset(vm: ScratchVm, target: VmTarget, item: NewAsset, replaceIndex?: number) {
  const sound = item.kind === "sound", storage = vm.runtime.storage;
  const list = () => sound ? target.sprite.sounds : target.getCostumes();
  if (replaceIndex === undefined && list().length >= 200) throw new Error("Tối đa 200 tài nguyên mỗi loại trên target.");
  if (replaceIndex !== undefined && !list()[replaceIndex]) throw new Error("Index tài nguyên không tồn tại.");
  const type = sound ? storage.AssetType.Sound : item.format === "svg" ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
  const asset = storage.createAsset(type, item.format, vmBytes(item.bytes), null, true);
  const md5ext = `${asset.assetId}.${item.format}`;
  const metadata: Asset = { name: item.name, asset, assetId: asset.assetId, dataFormat: item.format, md5: md5ext, md5ext };
  const current = target.currentCostume;
  if (sound) await vm.addSound(metadata, target.id);
  else await vm.addCostume(md5ext, { ...metadata, bitmapResolution: item.bitmapResolution ?? 2, rotationCenterX: item.rotationCenterX, rotationCenterY: item.rotationCenterY }, target.id);
  let index = list().length - 1;
  assertAssetsLoaded(target, [list()[index]]);
  if (replaceIndex !== undefined) {
    vm.stopAll(); vm.setEditingTarget(target.id);
    if (sound) { vm.deleteSound(replaceIndex); vm.reorderSound(target.id, list().length - 1, replaceIndex); }
    else { vm.deleteCostume(replaceIndex); vm.reorderCostume(target.id, list().length - 1, replaceIndex); target.setCostume(current); }
    index = replaceIndex;
  }
  refresh(vm, target);
  return { index, name: list()[index].name, count: list().length };
}

// ---------- Sound ----------
function wav(samples: Float32Array, rate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buffer);
}
function noise(ctx: OfflineAudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate), data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource(); source.buffer = buffer; return source;
}
type SoundPreset = Extract<Invocation, { name: "create_sound" }>["args"]["preset"];
const PRESET_MS: Record<SoundPreset, number> = { beep: 150, coin: 350, jump: 250, laser: 300, hit: 150, explosion: 900, powerup: 600, click: 30, whoosh: 600, tone: 500 };
export async function synthesize(preset: SoundPreset, options: { frequency?: number; durationMs?: number; volume?: number }) {
  const seconds = (options.durationMs ?? PRESET_MS[preset]) / 1000, ctx = new OfflineAudioContext(1, Math.ceil(SAMPLE_RATE * seconds), SAMPLE_RATE);
  const out = ctx.createGain(); out.connect(ctx.destination);
  const peak = (options.volume ?? 70) / 100, end = seconds;
  out.gain.setValueAtTime(0.0001, 0); out.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), Math.min(0.01, end / 4));
  out.gain.exponentialRampToValueAtTime(0.0001, end);
  const osc = (type: OscillatorType, from: number, to = from) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(from, 0);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(to, end);
    o.connect(out); o.start(0); o.stop(end); return o;
  };
  const filtered = (type: BiquadFilterType, from: number, to: number) => {
    const n = noise(ctx, seconds), f = ctx.createBiquadFilter(); f.type = type;
    f.frequency.setValueAtTime(from, 0); f.frequency.exponentialRampToValueAtTime(to, end);
    n.connect(f); f.connect(out); n.start(0);
  };
  if (preset === "beep") osc("square", options.frequency ?? 880);
  else if (preset === "tone") osc("sine", options.frequency ?? 440);
  else if (preset === "coin") { const o = osc("square", 988); o.frequency.setValueAtTime(1319, Math.min(0.08, end / 3)); }
  else if (preset === "jump") osc("square", 300, 900);
  else if (preset === "laser") osc("sawtooth", 1500, 200);
  else if (preset === "powerup") { const o = osc("square", 400, 1600); const lfo = ctx.createOscillator(), depth = ctx.createGain(); lfo.frequency.value = 18; depth.gain.value = 60; lfo.connect(depth); depth.connect(o.frequency); lfo.start(0); lfo.stop(end); }
  else if (preset === "hit") { filtered("lowpass", 3000, 300); osc("sine", 150, 60); }
  else if (preset === "explosion") filtered("lowpass", 2000, 60);
  else if (preset === "click") filtered("highpass", 2000, 2000);
  else filtered("bandpass", 300, 3000); // whoosh
  const rendered = await ctx.startRendering();
  return wav(rendered.getChannelData(0), SAMPLE_RATE);
}
export async function decodeSound(sound: Asset) {
  // decodeAudioData detaches its input, so give it a private copy.
  const bytes = assetData(sound), buffer = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels; }
  return { samples: mono, rate: buffer.sampleRate };
}
type SoundOp = Extract<Invocation, { name: "edit_sound" }>["args"]["operations"][number];
export function applySoundOps(input: Float32Array, rate: number, operations: SoundOp[]) {
  let s = input;
  const at = (ms: number) => Math.max(0, Math.min(s.length, Math.round(ms * rate / 1000)));
  for (const op of operations) {
    if (op.type === "trim") {
      const start = at(op.startMs), end = at(op.endMs);
      if (end <= start) throw new Error("trim cần endMs lớn hơn startMs và nằm trong độ dài âm thanh.");
      s = s.slice(start, end);
    } else if (op.type === "volume") s = s.map(v => Math.max(-1, Math.min(1, v * op.percent / 100)));
    else if (op.type === "fade_in" || op.type === "fade_out") {
      const n = Math.min(s.length, at(op.ms)); s = s.slice();
      for (let i = 0; i < n; i++) { const index = op.type === "fade_in" ? i : s.length - 1 - i; s[index] *= i / n; }
    } else if (op.type === "reverse") s = s.slice().reverse();
    else if (op.type === "speed") {
      const length = Math.max(1, Math.floor(s.length / op.factor)), out = new Float32Array(length);
      for (let i = 0; i < length; i++) { const p = i * op.factor, j = Math.floor(p), f = p - j; out[i] = (s[j] ?? 0) * (1 - f) + (s[j + 1] ?? 0) * f; }
      s = out;
    } else {
      const delay = Math.max(1, Math.round(op.delayMs * rate / 1000)), out = new Float32Array(s.length + delay * 3);
      out.set(s);
      for (let i = delay; i < out.length; i++) out[i] += out[i - delay] * op.decay;
      s = out.map(v => Math.max(-1, Math.min(1, v)));
    }
    if (s.length > rate * 120) throw new Error("Âm thanh sau chỉnh sửa vượt 2 phút.");
  }
  return wav(s, rate);
}

// ---------- Model tools ----------
export async function mediaTool(vm: ScratchVm, call: Invocation): Promise<unknown | undefined> {
  if (call.name === "edit_costume") {
    const a = call.args, target = findTarget(vm, a.targetId), costume = target.getCostumes()[a.index];
    if (!costume) throw new Error("Costume index không hợp lệ; xem get_assets.");
    const raster = applyCostumeOps(await renderCostume(costume), a.operations);
    const bytes = await pngBytes(raster.canvas);
    const result = await addAsset(vm, target, { kind: "costume", name: a.name ?? `${costume.name}-sửa`, format: "png", bytes, rotationCenterX: raster.cx, rotationCenterY: raster.cy }, a.replace ? a.index : undefined);
    return { ...result, replaced: Boolean(a.replace), size: { width: Math.round(raster.canvas.width / 2), height: Math.round(raster.canvas.height / 2) } };
  }
  if (call.name === "create_sound") {
    const a = call.args, target = findTarget(vm, a.targetId);
    return { ...(await addAsset(vm, target, { kind: "sound", name: a.name, format: "wav", bytes: await synthesize(a.preset, a) })), preset: a.preset };
  }
  if (call.name === "edit_sound") {
    const a = call.args, target = findTarget(vm, a.targetId), sound = target.sprite.sounds[a.index];
    if (!sound) throw new Error("Sound index không hợp lệ; xem get_assets kind=sound.");
    const { samples, rate } = await decodeSound(sound);
    const bytes = applySoundOps(samples, rate, a.operations);
    return { ...(await addAsset(vm, target, { kind: "sound", name: a.name ?? `${sound.name}-sửa`, format: "wav", bytes }, a.replace ? a.index : undefined)), replaced: Boolean(a.replace), durationMs: Math.round((bytes.length - 44) / 2 / rate * 1000) };
  }
}

// ---------- Internal operations for the parent app (not exposed to the model) ----------
function hash(value: unknown) {
  const text = JSON.stringify(value); let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function topOf(target: VmTarget, id: string) {
  let block = target.blocks._blocks[id], guard = 0;
  while (block?.parent && guard++ < 10000) block = target.blocks._blocks[block.parent];
  return block?.id;
}
export async function internalOp(vm: ScratchVm, op: string, payload: Record<string, unknown>): Promise<unknown> {
  if (op === "inventory") {
    return { targets: originals(vm).map(t => ({
      id: t.id, name: t.getName(), isStage: t.isStage,
      blocks: Object.fromEntries(Object.values(t.blocks._blocks).map(b => [b.id, hash([b.opcode, b.inputs, b.fields, b.next, b.parent, b.mutation])])),
      variables: Object.values(t.variables).map(v => `${v.type}:${v.name}`),
      costumes: t.getCostumes().map(c => `${c.name}#${c.assetId}`), sounds: t.sprite.sounds.map(s => `${s.name}#${s.assetId}`),
    })) };
  }
  if (op === "highlight") {
    const target = originals(vm).find(t => t.id === payload.targetId);
    if (!target || !Array.isArray(payload.blockIds)) return { highlighted: 0 };
    const tops = [...new Set(payload.blockIds.map(id => topOf(target, String(id))).filter(Boolean))] as string[];
    vm.setEditingTarget(target.id);
    // The GUI glows a stack on SCRIPT_GLOW_ON; turn it off again after a few seconds.
    setTimeout(() => { for (const id of tops) vm.runtime.glowScript?.(id, true); }, 300);
    setTimeout(() => { for (const id of tops) vm.runtime.glowScript?.(id, false); }, 6000);
    return { highlighted: tops.length };
  }
  if (op === "costumePng") {
    const target = findTarget(vm, String(payload.targetId)), costume = target.getCostumes()[Number(payload.index)];
    if (!costume) throw new Error("Costume index không hợp lệ.");
    const raster = await renderCostume(costume), max = Number(payload.maxSide) || 1024;
    const scale = Math.min(1, max / Math.max(raster.canvas.width, raster.canvas.height));
    const canvas = canvasOf(raster.canvas.width * scale, raster.canvas.height * scale);
    canvas.getContext("2d")!.drawImage(raster.canvas, 0, 0, canvas.width, canvas.height);
    return { bytes: (await pngBytes(canvas)).buffer, width: canvas.width, height: canvas.height };
  }
  if (op === "addAsset") {
    const target = findTarget(vm, String(payload.targetId));
    const kind = payload.kind === "sound" ? "sound" : "costume", format = String(payload.format);
    // The buffer comes from another window, so instanceof ArrayBuffer is false here.
    if (Object.prototype.toString.call(payload.bytes) !== "[object ArrayBuffer]") throw new Error("Dữ liệu tài nguyên không hợp lệ.");
    if (!(kind === "sound" ? ["wav", "mp3"] : ["png"]).includes(format)) throw new Error("Định dạng tài nguyên không hỗ trợ.");
    const bytes = new Uint8Array(payload.bytes as ArrayBuffer).slice();
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Tài nguyên vượt 10 MB.");
    return addAsset(vm, target, {
      kind, name: String(payload.name ?? "AI").slice(0, 120), format: format as NewAsset["format"], bytes,
      rotationCenterX: Number(payload.rotationCenterX) || undefined, rotationCenterY: Number(payload.rotationCenterY) || undefined,
      bitmapResolution: Number(payload.bitmapResolution) || 2,
    });
  }
  throw new Error(`Thao tác nội bộ không hợp lệ: ${op}`);
}
