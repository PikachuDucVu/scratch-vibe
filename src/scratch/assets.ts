import { vmBytes, findTarget, originals, refresh, describe, paginate, type ScratchVm, type Invocation, type Asset, type VmTarget } from "./vm-types";

async function library(kind: string): Promise<(Asset & { tags?: string[] })[]> {
  const data = kind === "sprite" ? await import("../../node_modules/@scratch/scratch-gui-standalone/src/lib/libraries/sprites.json") : kind === "costume" ? await import("../../node_modules/@scratch/scratch-gui-standalone/src/lib/libraries/costumes.json") : kind === "backdrop" ? await import("../../node_modules/@scratch/scratch-gui-standalone/src/lib/libraries/backdrops.json") : await import("../../node_modules/@scratch/scratch-gui-standalone/src/lib/libraries/sounds.json");
  return data.default as unknown as (Asset & { tags?: string[] })[];
}
async function libraryEntry(id: string) {
  const match = /^(sprite|costume|backdrop|sound):(\d+)$/.exec(id);
  if (!match) throw new Error("libraryId không hợp lệ; gọi search_library.");
  const item = (await library(match[1]))[Number(match[2])];
  if (!item) throw new Error("Không tìm thấy libraryId.");
  return { kind: match[1], item: structuredClone(item) };
}
export function assertAssetsLoaded(target: VmTarget, assets = [...target.getCostumes(), ...target.sprite.sounds]) {
  if (assets.some(asset => asset.broken)) throw new Error("Không tải/giải mã được tài nguyên; Scratch đã dùng placeholder. Thao tác được hủy để không báo thành công sai.");
}
function assetLimit(target: VmTarget, kind: string) {
  if ((kind === "sound" ? target.sprite.sounds.length : target.getCostumes().length) >= 200) throw new Error("Tối đa 200 tài nguyên mỗi loại trên target.");
}
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
export async function addSvg(vm: ScratchVm, targetId: string, name: string, svg: string, width: number, height: number) {
  const storage = vm.runtime.storage;
  const asset = storage.createAsset(storage.AssetType.ImageVector, "svg", vmBytes(new TextEncoder().encode(svg)), null, true);
  await vm.addCostume(`${asset.assetId}.svg`, { name, asset, assetId: asset.assetId, dataFormat: "svg", bitmapResolution: 1, rotationCenterX: width / 2, rotationCenterY: height / 2 }, targetId);
}
export async function assetTool(vm: ScratchVm, call: Invocation): Promise<unknown | undefined> {
  if (call.name === "search_library") {
    const a = call.args, query = (a.query ?? "").toLocaleLowerCase();
    const rows = (await library(a.kind)).map((item, index) => ({ libraryId: `${a.kind}:${index}`, name: item.name, tags: item.tags ?? [] })).filter(item => [item.name, ...item.tags].some(s => s.toLocaleLowerCase().includes(query)));
    return paginate(rows, a.offset, a.limit ?? 30);
  }
  if (call.name === "add_sprite") {
    if (originals(vm).length >= 50) throw new Error("Tối đa 49 sprite.");
    if (call.args.libraryId) {
      const { kind, item } = await libraryEntry(call.args.libraryId);
      if (kind !== "sprite") throw new Error("Cần libraryId của sprite.");
      await vm.addSprite({ ...item, name: call.args.name });
    } else {
      const storage = vm.runtime.storage;
      const asset = storage.createAsset(storage.AssetType.ImageVector, "svg", vmBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')), null, true);
      await vm.addSprite({ name: call.args.name, isStage: false, variables: {}, lists: {}, broadcasts: {}, blocks: {}, costumes: [{ name: "blank", assetId: asset.assetId, md5ext: `${asset.assetId}.svg`, dataFormat: "svg", bitmapResolution: 1, rotationCenterX: 0, rotationCenterY: 0 }], sounds: [], currentCostume: 0, x: 0, y: 0, direction: 90, size: 100, visible: true, rotationStyle: "all around" });
    }
    assertAssetsLoaded(vm.editingTarget); refresh(vm); return describe(vm.editingTarget);
  }
  if (call.name === "add_asset") {
    const a = call.args, target = findTarget(vm, a.targetId), { kind, item } = await libraryEntry(a.libraryId);
    if (kind === "sprite" || (kind === "backdrop" && !target.isStage) || (kind === "costume" && target.isStage)) throw new Error("Loại tài nguyên không phù hợp target.");
    assetLimit(target, kind);
    if (a.name) item.name = a.name;
    if (kind === "sound") { item.md5 = item.md5ext; await vm.addSound(item, target.id); }
    else await vm.addCostume(String(item.md5ext), item, target.id);
    assertAssetsLoaded(target, [kind === "sound" ? target.sprite.sounds.at(-1)! : target.getCostumes()[target.currentCostume]]); refresh(vm, target); return { kind, count: kind === "sound" ? target.sprite.sounds.length : target.getCostumes().length };
  }
  if (call.name === "manage_asset") {
    const a = call.args, target = findTarget(vm, a.targetId), assets = a.kind === "sound" ? target.sprite.sounds : target.getCostumes();
    if (!assets[a.index]) throw new Error("Index tài nguyên không tồn tại.");
    if (a.action === "rename" && !a.name) throw new Error("rename cần name.");
    if (a.action === "reorder" && (a.newIndex === undefined || a.newIndex >= assets.length)) throw new Error("newIndex không hợp lệ.");
    if (a.action === "delete" && a.kind === "costume" && assets.length === 1) throw new Error("Không thể xóa costume cuối cùng.");
    if (a.action === "select" && a.kind !== "costume") throw new Error("Chỉ select được costume/backdrop.");
    if (a.action === "duplicate") assetLimit(target, a.kind);
    vm.stopAll(); vm.setEditingTarget(target.id);
    const sound = a.kind === "sound";
    if (a.action === "rename") { if (sound) vm.renameSound(a.index, a.name!); else vm.renameCostume(a.index, a.name!); }
    if (a.action === "delete") { if (sound) vm.deleteSound(a.index); else vm.deleteCostume(a.index); }
    if (a.action === "duplicate") { if (sound) await vm.duplicateSound(a.index); else await vm.duplicateCostume(a.index); }
    if (a.action === "reorder") { if (sound) vm.reorderSound(target.id, a.index, a.newIndex!); else vm.reorderCostume(target.id, a.index, a.newIndex!); }
    if (a.action === "select") target.setCostume(a.index);
    if (a.action === "duplicate") assertAssetsLoaded(target, [assets[a.index + 1]]); refresh(vm, target); return { action: a.action, count: assets.length };
  }
  if (call.name === "create_costume") {
    const a = call.args, target = findTarget(vm, a.targetId); assetLimit(target, "costume");
    const shapes = a.shapes.map(s => {
      const attrs = `fill="${s.fill}" stroke="${s.stroke ?? "none"}" stroke-width="${s.strokeWidth ?? 1}"`;
      if (s.type === "rect") return `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" ${attrs}/>`;
      if (s.type === "ellipse") return `<ellipse cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" ${attrs}/>`;
      if (s.type === "line") return `<line x1="${s.x}" y1="${s.y}" x2="${s.x + s.width}" y2="${s.y + s.height}" ${attrs}/>`;
      return `<text x="${s.x}" y="${s.y}" font-family="sans-serif" font-size="${s.fontSize ?? 24}" ${attrs}>${escape(s.text ?? "")}</text>`;
    }).join("");
    await addSvg(vm, target.id, a.name, `<svg xmlns="http://www.w3.org/2000/svg" width="${a.width}" height="${a.height}" viewBox="0 0 ${a.width} ${a.height}">${shapes}</svg>`, a.width, a.height);
    assertAssetsLoaded(target, [target.getCostumes()[target.currentCostume]]); refresh(vm, target); return { index: target.currentCostume, name: target.getCostumes()[target.currentCostume].name };
  }
}
