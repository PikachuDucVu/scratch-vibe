import type { VmBlock, VariableInfo } from "../../shared/compiler";
import type { TOOL_SCHEMAS, ToolName } from "../../shared/tools";
import type { z } from "zod";
export type Invocation = { [K in ToolName]: { name: K; args: z.infer<(typeof TOOL_SCHEMAS)[K]> } }[ToolName];
export interface Asset { name: string; assetId?: string; dataFormat?: string; md5ext?: string; rotationCenterX?: number; rotationCenterY?: number; [key: string]: unknown }
export interface VmComment { id: string; blockId: string | null; text: string; x: number; y: number; width: number; height: number; minimized: boolean }
export interface VmVariable extends VariableInfo { value: unknown; isCloud?: boolean; _monitorUpToDate?: boolean }
export interface VmTarget {
  id: string; isStage: boolean; isOriginal: boolean; x: number; y: number; direction: number; size: number; visible: boolean;
  currentCostume: number; rotationStyle: string; draggable: boolean; volume: number; effects: Record<string, number>;
  sprite: { sounds: Asset[]; name: string };
  getName(): string; getCostumes(): Asset[];
  variables: Record<string, VmVariable>; comments: Record<string, VmComment>;
  blocks: { _blocks: Record<string, VmBlock>; getScripts(): string[]; createBlock(block: VmBlock): void; deleteBlock(id: string): void; resetCache(): void };
  createVariable(id: string, name: string, type: string, isCloud: boolean): void;
  renameVariable(id: string, name: string): void; deleteVariable(id: string): void;
  createComment(id: string, blockId: string | null, text: string, x: number, y: number, width: number, height: number, minimized: boolean): void;
  setXY(x: number, y: number): void; setDirection(direction: number): void; setSize(size: number): void; setVisible(visible: boolean): void;
  setRotationStyle(style: string): void; setCostume(index: number): void; setDraggable(draggable: boolean): void;
  goToBack(): void; goForwardLayers(layers: number): void;
}
export interface ScratchVm {
  runtime: {
    targets: VmTarget[]; getTargetForStage(): VmTarget; emitProjectChanged(): void; emit(name: string, ...args: unknown[]): void;
    threads: { status: number; target: VmTarget; topBlock: string; updateMonitor?: boolean }[];
    ioDevices: { keyboard: { getKeyIsDown(key: string): boolean }; mouse: { getScratchX(): number; getScratchY(): number; getIsDown(): boolean } };
    monitorBlocks: { _blocks: Record<string, unknown>; createBlock(block: unknown): void; changeBlock(args: unknown, runtime: unknown): void };
    storage: { AssetType: { ImageVector: unknown; ImageBitmap: unknown; Sound: unknown }; createAsset(type: unknown, format: string, data: Uint8Array, id: null, generate: boolean): { assetId: string; dataFormat: string } };
  };
  renderer: { canvas: { clientWidth: number; clientHeight: number }; draw(): void; requestSnapshot(callback: (url: string) => void): void };
  extensionManager: { isExtensionLoaded(name: string): boolean; loadExtensionURL(name: string): Promise<void> };
  editingTarget: VmTarget;
  setEditingTarget(id: string): void; emitWorkspaceUpdate(): void; emitTargetsUpdate(): void;
  greenFlag(): void; stopAll(): void; postIOData(device: string, data: unknown): void;
  renameSprite(id: string, name: string): void; duplicateSprite(id: string): Promise<void>; deleteSprite(id: string): unknown;
  addSprite(data: string | object | ArrayBuffer): Promise<void>;
  addCostume(md5ext: string, costume: Asset, targetId?: string): Promise<void>; addSound(sound: Asset, targetId?: string): Promise<void>;
  renameCostume(index: number, name: string): void; renameSound(index: number, name: string): void;
  deleteCostume(index: number): unknown; deleteSound(index: number): unknown;
  duplicateCostume(index: number): Promise<void>; duplicateSound(index: number): Promise<void>;
  reorderCostume(id: string, index: number, newIndex: number): void; reorderSound(id: string, index: number, newIndex: number): void;
  saveProjectSb3(): Promise<Blob>; exportSprite(id: string): Promise<Blob>; loadProject(data: ArrayBuffer): Promise<void>;
}
export function originals(vm: ScratchVm) { return vm.runtime.targets.filter(t => t.isOriginal || t.isStage); }
export function findTarget(vm: ScratchVm, id: string) {
  const target = originals(vm).find(t => t.id === id);
  if (!target) throw new Error("Target không tồn tại. Gọi get_project để lấy ID mới.");
  return target;
}
export function refresh(vm: ScratchVm, target = vm.editingTarget) {
  if (!target) target = vm.runtime.getTargetForStage();
  const stage = vm.runtime.getTargetForStage();
  const broadcasts = Object.values(stage.variables).filter(v => v.type === "broadcast_msg");
  vm.setEditingTarget(target.id); vm.emitWorkspaceUpdate(); vm.emitTargetsUpdate();
  // VM's workspace refresh prunes unused messages, but a tool can create one before adding its blocks.
  for (const v of broadcasts) stage.variables[v.id] ??= v;
  vm.runtime.emitProjectChanged();
}
export function preview(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map(v => typeof v === "string" ? v.slice(0, 100) : v);
  return typeof value === "string" ? value.slice(0, 200) : value;
}
export function describe(t: VmTarget) {
  return { id: t.id, name: t.getName(), isStage: t.isStage, x: t.x, y: t.y, direction: t.direction, size: t.size, visible: t.visible,
    rotationStyle: t.rotationStyle, draggable: t.draggable, currentCostume: t.currentCostume, volume: t.volume,
    costumes: t.getCostumes().slice(0, 10).map(c => c.name.slice(0,120)), costumeCount: t.getCostumes().length, soundCount: t.sprite.sounds.length,
    variables: Object.values(t.variables).slice(0, 10).map(v => ({ id: v.id, name: v.name, type: v.type, value: preview(v.value), preview: true })), variableCount: Object.keys(t.variables).length,
    scriptCount: t.blocks.getScripts().length, blockCount: Object.keys(t.blocks._blocks).length };
}
// Byte-budgeted pages work for both small and imported projects. Never silently drop pages.
export function paginate<T>(items: T[], offset = 0, limit = 100, budget = 55000) {
  const result: T[] = []; let bytes = 0;
  for (const item of items.slice(offset, offset + limit)) {
    const size = JSON.stringify(item).length;
    if (size > budget) throw new Error("Một mục quá lớn; hãy dùng truy vấn chi tiết/phân trang dữ liệu của mục này.");
    if (bytes + size > budget) break;
    bytes += size; result.push(item);
  }
  const end = offset + result.length;
  return { items: result, total: items.length, offset, nextOffset: end < items.length ? end : null };
}

// The tools module runs in its own iframe. Scratch's bundled JSZip uses instanceof
// checks, so asset bytes must be allocated in the VM's (parent editor) realm.
export function vmBytes(bytes: Uint8Array): Uint8Array {
  const Bytes = typeof window === "undefined" ? Uint8Array : (window.parent as unknown as { Uint8Array: typeof Uint8Array }).Uint8Array;
  return new Bytes(bytes);
}
