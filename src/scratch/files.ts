import { assertAssetsLoaded } from "./assets";
import JSZip from "jszip";
import { vmBytes, originals, findTarget, refresh, type ScratchVm, type Invocation } from "./vm-types";
interface StoredFile { id: string; name: string; bytes: ArrayBuffer }
interface Snapshot extends StoredFile { createdAt: string }
const files: StoredFile[] = [], snapshots = new WeakMap<ScratchVm, Snapshot[]>();
const MAX_BYTES = 50 * 1024 * 1024;
export interface ToolServices { loadProject?(bytes: ArrayBuffer): Promise<void> }
export function uploadFile(name: string, bytes: ArrayBuffer) {
  if (!/\.(sb3|sprite3|png|jpg|jpeg|svg|wav|mp3)$/i.test(name) || name.length > 200) throw new Error("Loại file không hỗ trợ.");
  if (files.length >= 20 || !bytes.byteLength || files.reduce((sum, f) => sum + f.bytes.byteLength, bytes.byteLength) > MAX_BYTES) throw new Error("Tối đa 20 file / 50 MB mỗi tab; tải lại trang để xóa.");
  const file = { id: crypto.randomUUID(), name, bytes }; files.push(file);
  return { id: file.id, name, size: bytes.byteLength };
}
async function validateArchive(bytes: ArrayBuffer, sprite: boolean) {
  const zip = await JSZip.loadAsync(new Uint8Array(bytes)), entry = zip.file(sprite ? "sprite.json" : "project.json");
  if (!entry) throw new Error("Archive Scratch không hợp lệ.");
  const entries = Object.values(zip.files);
  const unpacked = entries.reduce((sum, entry) => sum + ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
  if (entries.length > 2000 || unpacked > 100 * 1024 * 1024) throw new Error("Archive giải nén quá lớn.");
  const raw = await entry.async("string"); if (raw.length > 5_000_000) throw new Error("JSON project quá lớn.");
  const data = JSON.parse(raw);
  if (data.extensionURLs || (data.extensions ?? []).some((e: string) => !["pen", "music"].includes(e))) throw new Error("AI chỉ được nhập project dùng extension Pen/Music, không URL/hardware/camera.");
  const targets = sprite ? [data] : data.targets;
  if (!Array.isArray(targets) || targets.length > 50) throw new Error("Project quá nhiều target hoặc không hợp lệ.");
  const prefixes = new Set(["event", "motion", "looks", "sound", "control", "sensing", "operator", "data", "procedures", "argument", "math", "text", "colour", "pen", "music"]);
  for (const target of targets) {
    if (target.extensionURLs || Object.values(target.blocks ?? {}).some(b => !prefixes.has(String((b as { opcode: string }).opcode).split("_")[0]))) throw new Error("Project chứa extension không được phép nhập bằng AI.");
  }
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function fileTool(vm: ScratchVm, call: Invocation, services: ToolServices): Promise<unknown | undefined> {
  if (call.name === "list_files") return { files: files.map(f => ({ id: f.id, name: f.name, size: f.bytes.byteLength })) };
  if (call.name === "export_project" || call.name === "export_sprite") {
    if (call.name === "export_sprite" && findTarget(vm, call.args.targetId).isStage) throw new Error("Không xuất stage thành sprite.");
    const blob = call.name === "export_project" ? await vm.saveProjectSb3() : await vm.exportSprite(call.args.targetId);
    const filename = call.name === "export_project" ? `${call.args.filename ?? "scratch-vibe"}.sb3` : "sprite.sprite3";
    download(blob, filename); return { filename, bytes: blob.size, downloadStarted: true };
  }
  if (call.name === "list_snapshots") return { snapshots: (snapshots.get(vm) ?? []).map(f => ({ id: f.id, name: f.name, createdAt: f.createdAt, bytes: f.bytes.byteLength })) };
  if (call.name === "save_snapshot") {
    const list = snapshots.get(vm) ?? []; if (list.length >= 5) throw new Error("Tối đa 5 snapshot trong tab; xuất .sb3 để lưu lâu dài.");
    const bytes = await (await vm.saveProjectSb3()).arrayBuffer();
    if (list.reduce((sum, f) => sum + f.bytes.byteLength, bytes.byteLength) > MAX_BYTES) throw new Error("Snapshot vượt tổng 50 MB.");
    const snapshot = { id: crypto.randomUUID(), name: call.args.name, bytes, createdAt: new Date().toISOString() }; list.push(snapshot); snapshots.set(vm, list);
    return { snapshotId: snapshot.id, bytes: bytes.byteLength };
  }
  if (call.name === "restore_snapshot") {
    const snapshot = snapshots.get(vm)?.find(f => f.id === call.args.snapshotId); if (!snapshot) throw new Error("Snapshot không tồn tại trong tab.");
    vm.stopAll(); await (services.loadProject ?? (b => vm.loadProject(b)))(snapshot.bytes.slice(0));
    return { restored: true, refreshTargetIds: true };
  }
  if (call.name === "import_file") {
    const file = files.find(f => f.id === call.args.fileId); if (!file) throw new Error("File chưa được người dùng tải lên.");
    const ext = file.name.split(".").at(-1)!.toLowerCase();
    if (ext === "sb3" || ext === "sprite3") {
      await validateArchive(file.bytes, ext === "sprite3");
      if (ext === "sprite3" && originals(vm).length >= 50) throw new Error("Tối đa 49 sprite.");
      vm.stopAll();
      if (ext === "sb3") await (services.loadProject ?? (b => vm.loadProject(b)))(file.bytes.slice(0));
      else { await vm.addSprite(file.bytes.slice(0)); refresh(vm); }
      for (const target of ext === "sb3" ? originals(vm) : [vm.editingTarget]) assertAssetsLoaded(target);
      return { imported: file.name, refreshTargetIds: true };
    }
    if (!call.args.targetId) throw new Error("Nhập ảnh/âm thanh cần targetId.");
    const target = findTarget(vm, call.args.targetId), storage = vm.runtime.storage;
    const sound = ["wav", "mp3"].includes(ext);
    if ((sound ? target.sprite.sounds.length : target.getCostumes().length) >= 200) throw new Error("Tối đa 200 tài nguyên mỗi loại.");
    let bytes = new Uint8Array(file.bytes), format = ext === "jpeg" ? "jpg" : ext;
    // Restrict uploaded SVG to self-contained SVG. No executable markup or external fetches.
    if (ext === "svg") {
      const svg = new TextDecoder().decode(bytes), doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") throw new Error("SVG không hợp lệ.");
      for (const el of [doc.documentElement, ...doc.querySelectorAll("*")]) {
        if (!["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "title", "desc"].includes(el.localName)) throw new Error("SVG chứa thành phần không an toàn; dùng PNG hoặc create_costume.");
        for (const attr of el.attributes) if (/^on|href|style/i.test(attr.name) || /url\s*\((?!\s*#[\w-]+\s*\))/i.test(attr.value)) throw new Error("SVG không được chứa event, style, URL hoặc tham chiếu bên ngoài.");
      }
      bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(doc.documentElement));
    }
    const asset = storage.createAsset(sound ? storage.AssetType.Sound : ext === "svg" ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap, format, vmBytes(bytes), null, true);
    const metadata = { md5: `${asset.assetId}.${format}`, name: file.name.replace(/\.[^.]+$/, ""), asset, assetId: asset.assetId, dataFormat: format, md5ext: `${asset.assetId}.${format}`, bitmapResolution: 1 };
    if (sound) await vm.addSound(metadata, target.id); else await vm.addCostume(metadata.md5ext, metadata, target.id);
    assertAssetsLoaded(target, [sound ? target.sprite.sounds.at(-1)! : target.getCostumes()[target.currentCostume]]); refresh(vm, target); return { imported: file.name, kind: sound ? "sound" : "costume" };
  }
}
