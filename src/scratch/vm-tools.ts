import { compileScripts, type VariableInfo, type VmBlock } from "../../shared/compiler";
import { parseTool, type BlockNode, type ToolName } from "../../shared/tools";

export interface VmTarget {
  id: string; isStage: boolean; isOriginal: boolean; x: number; y: number; direction: number; size: number; visible: boolean;
  getName(): string;
  getCostumes(): { name: string }[];
  variables: Record<string, VariableInfo & { value: unknown }>;
  comments: Record<string, { blockId: string | null }>;
  blocks: { _blocks: Record<string, VmBlock>; getScripts(): string[]; createBlock(block: VmBlock): void; deleteBlock(id: string): void };
  createVariable(id: string, name: string, type: string, isCloud: boolean): void;
  setXY(x: number, y: number): void;
  setDirection(direction: number): void;
  setSize(size: number): void;
  setVisible(visible: boolean): void;
}
export interface ScratchVm {
  runtime: { targets: VmTarget[]; getTargetForStage(): VmTarget; emitProjectChanged(): void };
  editingTarget: VmTarget;
  setEditingTarget(id: string): void;
  emitWorkspaceUpdate(): void;
  emitTargetsUpdate(): void;
  greenFlag(): void;
  stopAll(): void;
  renameSprite(id: string, name: string): void;
  duplicateSprite(id: string): Promise<void>;
}
function originals(vm: ScratchVm) { return vm.runtime.targets.filter(t => t.isOriginal || t.isStage); }
function findTarget(vm: ScratchVm, id: string) {
  const target = originals(vm).find(t => t.id === id);
  if (!target) throw new Error("Target không tồn tại. Gọi get_project để lấy ID mới.");
  return target;
}
function describe(t: VmTarget) {
  return {
    id: t.id, name: t.getName(), isStage: t.isStage,
    x: t.x, y: t.y, direction: t.direction, size: t.size, visible: t.visible,
    costumes: t.getCostumes().map(c => c.name),
    variables: Object.values(t.variables).map(v => ({ id: v.id, name: v.name, type: v.type, value: v.value })),
    scriptCount: t.blocks.getScripts().length, blockCount: Object.keys(t.blocks._blocks).length,
  };
}
function refresh(vm: ScratchVm, target: VmTarget) {
  vm.setEditingTarget(target.id);
  vm.emitWorkspaceUpdate();
  vm.emitTargetsUpdate();
  vm.runtime.emitProjectChanged();
}

export async function executeVmTool(vm: ScratchVm, name: ToolName, raw: unknown): Promise<unknown> {
  const args = parseTool(name, raw) as Record<string, unknown>;
  if (name === "get_project") return { targets: originals(vm).map(describe), editingTargetId: vm.editingTarget.id };
  if (name === "run_project") { vm.greenFlag(); return { running: true }; }
  if (name === "stop_project") { vm.stopAll(); return { running: false }; }
  const target = findTarget(vm, args.targetId as string);
  if (name === "get_scripts") return { targetId: target.id, scripts: target.blocks.getScripts(), blocks: target.blocks._blocks };
  if (name === "add_scripts" || name === "replace_scripts") {
    const variables = [...Object.values(target.variables), ...Object.values(vm.runtime.getTargetForStage().variables)];
    const blocks = compileScripts(args.scripts as BlockNode[][], {
      isStage: target.isStage, variables,
      yOffset: name === "add_scripts" ? 40 + target.blocks.getScripts().length * 260 : 40,
    });
    if (Object.keys(target.blocks._blocks).length + blocks.length > 10000) throw new Error("Target vượt giới hạn 10.000 block.");
    vm.stopAll();
    if (name === "replace_scripts") {
      for (const id of [...target.blocks.getScripts()]) target.blocks.deleteBlock(id);
      for (const [id, comment] of Object.entries(target.comments)) if (comment.blockId !== null) delete target.comments[id];
    }
    for (const block of blocks) target.blocks.createBlock(block);
    refresh(vm, target);
    return { targetId: target.id, addedBlocks: blocks.length, scriptCount: target.blocks.getScripts().length };
  }
  if (name === "create_variable") {
    let variable = Object.values(target.variables).find(v => v.name === args.name && v.type === "");
    if (!variable) {
      if (Object.keys(target.variables).length >= 200) throw new Error("Tối đa 200 biến trên target.");
      const id = crypto.randomUUID();
      target.createVariable(id, args.name as string, "", false);
      variable = target.variables[id];
    }
    variable.value = args.value;
    refresh(vm, target);
    return { id: variable.id, name: variable.name, value: variable.value };
  }
  if (target.isStage) throw new Error("Tool này chỉ dùng cho sprite, không dùng cho sân khấu.");
  if (name === "duplicate_sprite") {
    if (originals(vm).length >= 50) throw new Error("Tối đa 49 sprite.");
    await vm.duplicateSprite(target.id);
    const copy = vm.editingTarget;
    vm.renameSprite(copy.id, args.name as string);
    refresh(vm, copy);
    return describe(copy);
  }
  if (name === "set_sprite") {
    if (args.x !== undefined || args.y !== undefined) target.setXY((args.x as number | undefined) ?? target.x, (args.y as number | undefined) ?? target.y);
    if (args.direction !== undefined) target.setDirection(args.direction as number);
    if (args.size !== undefined) target.setSize(args.size as number);
    if (args.visible !== undefined) target.setVisible(args.visible as boolean);
    if (args.name !== undefined) vm.renameSprite(target.id, args.name as string);
    refresh(vm, target);
    return describe(target);
  }
  throw new Error(`Tool không hỗ trợ: ${name}`);
}
