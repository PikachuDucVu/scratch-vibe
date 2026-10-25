import { compileScripts, compileProcedure, isTerminal, type CompileOptions, type ProcedureInfo, type VmBlock } from "../../shared/compiler";
import { CATALOG } from "../../shared/catalog";
import type { BlockNode } from "../../shared/tools";
import { refresh, type Invocation, type ScratchVm, type VmTarget } from "./vm-types";

export function descendants(target: VmTarget, root: string, includeNext = true) {
  const ids = new Set<string>(), queue = [root];
  while (queue.length) {
    const id = queue.pop()!; if (ids.has(id)) continue;
    const block = target.blocks._blocks[id]; if (!block) throw new Error(`Block không tồn tại: ${id}`);
    ids.add(id); if (ids.size > 20000) throw new Error("Graph block quá lớn.");
    if ((id !== root || includeNext) && block.next) queue.push(block.next);
    for (const input of Object.values(block.inputs)) { if (input.block) queue.push(input.block); if (input.shadow) queue.push(input.shadow); }
  }
  return ids;
}
export function procedures(target: VmTarget): ProcedureInfo[] {
  return Object.values(target.blocks._blocks).filter(b => b.opcode === "procedures_prototype").map(b => {
    const m = b.mutation!;
    return { proccode: String(m.proccode), argumentids: JSON.parse(String(m.argumentids)), argumentnames: JSON.parse(String(m.argumentnames)), argumentdefaults: JSON.parse(String(m.argumentdefaults)), warp: m.warp === true || m.warp === "true" };
  });
}
export function compileOptions(vm: ScratchVm, target: VmTarget, blockId?: string): CompileOptions {
  let root = blockId ? target.blocks._blocks[blockId] : undefined;
  const seen = new Set<string>();
  while (root?.parent) { if (seen.has(root.id)) throw new Error("Graph có vòng lặp."); seen.add(root.id); root = target.blocks._blocks[root.parent]; }
  const proto = root?.opcode === "procedures_definition" ? target.blocks._blocks[root.inputs.custom_block?.block ?? ""] : undefined;
  const signature = proto && procedures(target).find(p => p.proccode === proto.mutation?.proccode);
  return { isStage: target.isStage, variables: [...Object.values(target.variables), ...Object.values(vm.runtime.getTargetForStage().variables)],
    procedures: procedures(target), extensions: ["pen", "music"].filter(e => vm.extensionManager.isExtensionLoaded(e)),
    parameters: signature?.argumentnames.map((name, i) => ({ name, type: signature.proccode.match(/%[snb]/g)?.[i] === "%b" ? "boolean" : "string_number" })),
    yOffset: 40 + target.blocks.getScripts().length * 260 };
}
export function removeBlocks(target: VmTarget, ids: Set<string>) {
  // Detach surviving graph first. VM deleteBlock recursively follows next and inputs.
  for (const id of ids) {
    const b = target.blocks._blocks[id]; if (!b) continue;
    b.next = null; b.inputs = {};
  }
  for (const id of ids) target.blocks.deleteBlock(id);
  for (const [id, comment] of Object.entries(target.comments)) if (comment.blockId && ids.has(comment.blockId)) delete target.comments[id];
  target.blocks.resetCache();
}
function ensureCapacity(target: VmTarget, added: number, removed = 0) {
  if (Object.keys(target.blocks._blocks).length - removed + added > 10000) throw new Error("Target vượt giới hạn 10.000 block.");
}
function preventDanglingProcedure(target: VmTarget, removed: Set<string>) {
  const signatures = [...removed].map(id => target.blocks._blocks[id]).filter(b => b.opcode === "procedures_prototype").map(b => b.mutation?.proccode);
  if (Object.values(target.blocks._blocks).some(b => !removed.has(b.id) && b.opcode === "procedures_call" && signatures.includes(b.mutation?.proccode))) throw new Error("My Block còn được gọi; xóa call trước khi xóa định nghĩa.");
}
function reconnect(target: VmTarget, old: VmBlock, id: string | null) {
  if (!old.parent) return;
  const parent = target.blocks._blocks[old.parent];
  if (parent.next === old.id) parent.next = id;
  else for (const input of Object.values(parent.inputs)) {
    if (input.block === old.id) input.block = id ?? (input.shadow === old.id ? null : input.shadow);
    if (input.shadow === old.id) input.shadow = null;
  }
}
export function graphTool(vm: ScratchVm, target: VmTarget, call: Invocation): unknown | undefined {
  const blocks = target.blocks._blocks;
  switch (call.name) {
    case "add_scripts": case "replace_scripts": {
      const replace = call.name === "replace_scripts";
      const options = compileOptions(vm, target);
      // Definitions are deleted by replace-all; do not compile dangling calls against old definitions.
      const compiled = compileScripts(call.args.scripts, { ...options, procedures: replace ? [] : options.procedures, yOffset: replace ? 40 : options.yOffset });
      ensureCapacity(target, compiled.length, replace ? Object.keys(blocks).length : 0);
      vm.stopAll(); if (replace) removeBlocks(target, new Set(Object.keys(blocks)));
      for (const b of compiled) target.blocks.createBlock(b);
      refresh(vm, target); return { targetId: target.id, addedBlocks: compiled.length, scriptCount: target.blocks.getScripts().length };
    }
    case "replace_script": case "delete_script": {
      const old = blocks[call.args.scriptId];
      if (!old?.topLevel) throw new Error("scriptId phải là block đầu của script.");
      const ids = descendants(target, old.id); preventDanglingProcedure(target, ids);
      const compiled = call.name === "replace_script" ? compileScripts([call.args.script], compileOptions(vm, target)) : [];
      ensureCapacity(target, compiled.length, ids.size);
      if (compiled[0]) { compiled[0].x = old.x; compiled[0].y = old.y; }
      vm.stopAll(); removeBlocks(target, ids); for (const b of compiled) target.blocks.createBlock(b);
      refresh(vm, target); return { removedBlocks: ids.size, addedBlocks: compiled.length, scriptId: compiled[0]?.id ?? null };
    }
    case "define_procedure": {
      const a = call.args;
      if (/%[snb]/.test(a.name) || new Set(a.parameters.map(p => p.name)).size !== a.parameters.length) throw new Error("Tên My Block/tham số không hợp lệ hoặc bị trùng.");
      const proccode = [a.name, ...a.parameters.map(p => p.type === "boolean" ? "%b" : "%s")].join(" ");
      if (procedures(target).some(p => p.proccode === proccode)) throw new Error("My Block đã tồn tại; sửa body bằng các tool chỉnh block.");
      const procedure: ProcedureInfo = { proccode, argumentids: a.parameters.map(() => crypto.randomUUID()), argumentnames: a.parameters.map(p => p.name), argumentdefaults: a.parameters.map(p => p.type === "boolean" ? false : p.default ?? ""), warp: a.warp ?? false };
      const compiled = compileProcedure(procedure, a.body, compileOptions(vm, target)); ensureCapacity(target, compiled.length);
      vm.stopAll(); for (const b of compiled) target.blocks.createBlock(b); refresh(vm, target);
      return { ...procedure, definitionId: compiled[0].id };
    }
    case "insert_blocks": {
      const a = call.args, old = blocks[a.blockId]; if (!old || old.shadow) throw new Error("Block không tồn tại/không thể chèn vào shadow.");
      const kind = CATALOG[old.opcode]?.kind;
      if (!["hat", "stack", "terminal"].includes(kind) && old.opcode !== "procedures_definition") throw new Error("Chỉ chèn vào chuỗi lệnh.");
      const before = a.position === "before";
      if (before && (kind === "hat" || old.opcode === "procedures_definition")) throw new Error("Không chèn trước hat/định nghĩa.");
      if (!before && isTerminal({ opcode: old.opcode, fields: Object.fromEntries(Object.entries(old.fields).map(([n, f]) => [n, f.value])) })) throw new Error("Không chèn sau terminal.");
      const successor = before ? old.id : old.next;
      if (successor && isTerminal(a.blocks.at(-1)!)) throw new Error("Terminal sẽ cắt code phía sau.");
      const compiled = compileScripts([a.blocks], { ...compileOptions(vm, target, old.id), stackOnly: true }); ensureCapacity(target, compiled.length);
      const first = compiled[0]; let last = first; while (last.next) last = compiled.find(b => b.id === last.next)!;
      first.parent = before ? old.parent : old.id; first.topLevel = before && old.topLevel; last.next = successor;
      if (first.topLevel) { first.x = old.x; first.y = old.y; }
      vm.stopAll();
      if (before) reconnect(target, old, first.id); else old.next = first.id;
      if (successor) { blocks[successor].parent = last.id; if (blocks[successor].topLevel) { blocks[successor].topLevel = false; const scripts = target.blocks.getScripts(); scripts.splice(scripts.indexOf(successor), 1); } }
      for (const b of compiled) target.blocks.createBlock(b); refresh(vm, target); return { addedBlocks: compiled.length, firstBlockId: first.id };
    }
    case "delete_block": {
      const old = blocks[call.args.blockId];
      if (!old || old.shadow || !["stack", "terminal"].includes(CATALOG[old.opcode]?.kind)) throw new Error("Dùng delete_script cho hat/định nghĩa; chỉ xóa lệnh stack bằng delete_block.");
      const ids = descendants(target, old.id, false); const next = old.next;
      vm.stopAll(); reconnect(target, old, next);
      if (next) { blocks[next].parent = old.parent; if (old.topLevel) { blocks[next].topLevel = true; blocks[next].x = old.x; blocks[next].y = old.y; target.blocks.getScripts().push(next); } }
      removeBlocks(target, ids); refresh(vm, target); return { removedBlocks: ids.size };
    }
    case "update_block": {
      const a = call.args, old = blocks[a.blockId]; if (!old || old.shadow) throw new Error("Block không tồn tại hoặc là shadow.");
      const spec = CATALOG[old.opcode];
      if (!spec) throw new Error("Block không nằm trong catalog an toàn.");
      const signature = old.opcode === "procedures_call" ? procedures(target).find(p => p.proccode === old.mutation?.proccode) : undefined;
      if (signature && a.fields?.PROCEDURE && a.fields.PROCEDURE !== signature.proccode) throw new Error("Không đổi chữ ký My Block tại chỗ; chèn call mới rồi xóa call cũ.");
      const inputSpecs = signature ? Object.fromEntries(signature.argumentnames.map((name, i) => [name, signature.proccode.match(/%[snb]/g)?.[i] === "%b" ? "boolean" : "text"])) : spec.inputs ?? {};
      const fields = Object.fromEntries(Object.entries(old.fields).map(([name, field]) => [name, field.id ?? field.value]));
      if (signature) fields.PROCEDURE = signature.proccode;
      // Compile placeholders for untouched slots, then keep their actual graph unchanged.
      // This preserves IDs/comments and permits edits alongside imported unsupported subtrees.
      const placeholders = Object.fromEntries(Object.entries(inputSpecs).map(([name, type]) => [name,
        typeof type === "object" ? type.variableType ? compileOptions(vm, target).variables.find(v => v.type === type.variableType)?.id ?? "" : type.values?.[0] ?? ""
          : type === "stack" ? [] : type === "boolean" ? { opcode: "operator_equals", inputs: { OPERAND1: 0, OPERAND2: 1 } } : type === "color" ? "#000000" : 0]));
      const node: BlockNode = { opcode: old.opcode, inputs: { ...placeholders, ...a.inputs }, fields: { ...fields, ...a.fields } };
      const kind = spec.kind;
      const wrapper: BlockNode[] = kind === "hat" ? [node] : kind === "reporter" ? [{ opcode: "event_whenflagclicked" }, { opcode: "looks_switchbackdropto", inputs: { BACKDROP: node } }] : kind === "boolean" ? [{ opcode: "event_whenflagclicked" }, { opcode: "control_if", inputs: { CONDITION: node, SUBSTACK: [] } }] : [node];
      const compiled = compileScripts([wrapper], { ...compileOptions(vm, target, old.id), stackOnly: !["hat", "reporter", "boolean"].includes(kind) });
      const root = kind === "reporter" ? compiled.find(b => b.id === compiled[1].inputs.BACKDROP.block)! : kind === "boolean" ? compiled.find(b => b.id === compiled[1].inputs.CONDITION.block)! : compiled[0];
      if (old.next && isTerminal(node)) throw new Error("Terminal sẽ cắt code phía sau.");
      const fakeTarget = { blocks: { _blocks: Object.fromEntries(compiled.map(b => [b.id, b])) } } as VmTarget;
      const removed = new Set<string>(), keep = new Set<string>();
      const inputs = { ...old.inputs };
      for (const name of Object.keys(a.inputs ?? {})) {
        const key = signature ? signature.argumentids[signature.argumentnames.indexOf(name)] : name;
        for (const id of [old.inputs[key]?.block, old.inputs[key]?.shadow]) if (id) for (const child of descendants(target, id)) removed.add(child);
        const input = root.inputs[key]; inputs[key] = input;
        for (const id of [input.block, input.shadow]) if (id) for (const child of descendants(fakeTarget, id)) keep.add(child);
      }
      const replacement = compiled.filter(b => keep.has(b.id));
      for (const b of replacement) if (b.parent === root.id) b.parent = old.id;
      ensureCapacity(target, replacement.length, removed.size);
      vm.stopAll(); removeBlocks(target, removed);
      old.inputs = inputs; old.fields = root.fields; old.mutation = root.mutation;
      for (const b of replacement) target.blocks.createBlock(b);
      target.blocks.resetCache();
      refresh(vm, target); return { blockId: old.id, updated: true };
    }
  }
}
