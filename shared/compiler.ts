import { CATALOG, type InputSpec } from "./catalog";
import { type BlockNode } from "./tools";

export interface VmBlock {
  id: string; opcode: string; next: string | null; parent: string | null;
  inputs: Record<string, { name: string; block: string | null; shadow: string | null }>;
  fields: Record<string, { name: string; value: string; id?: string; variableType?: string }>;
  shadow: boolean; topLevel: boolean; x?: number; y?: number;
}
export interface VariableInfo { id: string; name: string; type: string }

// Compile fully before touching the VM. Unknown opcodes, fields, bad graphs and
// unresolved variables fail atomically, rather than inserting half a script.
export function compileScripts(scripts: BlockNode[][], options: { isStage: boolean; variables: VariableInfo[]; yOffset?: number; id?: () => string }) {
  const blocks: VmBlock[] = [];
  const makeId = options.id ?? (() => crypto.randomUUID());
  const ids = new Set<string>();
  function freshId() {
    const id = makeId();
    if (ids.has(id)) throw new Error("Duplicate block ID");
    ids.add(id);
    return id;
  }
  function push(opcode: string, parent: string | null, shadow = false) {
    if (blocks.length >= 1000) throw new Error("Tối đa 1000 block cho mỗi tool call.");
    const block: VmBlock = { id: freshId(), opcode, next: null, parent, inputs: {}, fields: {}, shadow, topLevel: false };
    blocks.push(block);
    return block;
  }
  function scalar(value: unknown, spec: "number" | "text", parent: string) {
    if (typeof value !== "string" && typeof value !== "number") throw new Error("Input phải là số, chuỗi hoặc reporter.");
    const block = push(spec === "number" ? "math_number" : "text", parent, true);
    const name = spec === "number" ? "NUM" : "TEXT";
    block.fields[name] = { name, value: String(value) };
    return block.id;
  }
  function chain(nodes: BlockNode[], parent: string | null, top: boolean, depth: number): string | null {
    let first: VmBlock | undefined;
    let previous: VmBlock | undefined;
    for (const [index, node] of nodes.entries()) {
      const spec = CATALOG[node.opcode];
      if (!spec) throw new Error(`Opcode không được hỗ trợ: ${node.opcode}`);
      if (top && index === 0 ? spec.kind !== "hat" : !["stack", "terminal"].includes(spec.kind)) {
        throw new Error(top && index === 0 ? "Script phải bắt đầu bằng event hat." : `Không thể nối ${node.opcode} vào stack.`);
      }
      if (previous && CATALOG[previous.opcode].kind === "terminal") throw new Error("Không thể nối block sau forever/stop.");
      const block = nodeBlock(node, previous?.id ?? parent, depth);
      if (previous) previous.next = block.id;
      if (!first) first = block;
      previous = block;
    }
    if (first && top) {
      first.topLevel = true;
      first.x = 40;
      first.y = (options.yOffset ?? 40) + scripts.indexOf(nodes) * 260;
    }
    return first?.id ?? null;
  }
  function input(value: unknown, spec: InputSpec, parent: string, depth: number) {
    if (spec === "stack") {
      if (!Array.isArray(value)) throw new Error("SUBSTACK phải là mảng block.");
      return { block: chain(value, parent, false, depth + 1), shadow: null };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const node = value as BlockNode;
      const childSpec = CATALOG[node.opcode];
      if (!childSpec || (spec === "boolean" ? childSpec.kind !== "boolean" : childSpec.kind !== "reporter")) {
        throw new Error(`Reporter không phù hợp với input: ${node.opcode}`);
      }
      if (typeof spec === "object") throw new Error("Menu chỉ nhận tên dạng chuỗi trong bản MVP.");
      const child = nodeBlock(node, parent, depth + 1);
      const shadow = spec === "boolean" ? null : scalar(spec === "number" ? 0 : "", spec, parent);
      return { block: child.id, shadow };
    }
    if (typeof spec === "object") {
      if (typeof value !== "string" || value.length > 120) throw new Error("Menu phải là tên dạng chuỗi.");
      if (spec.values && !spec.values.includes(value)) throw new Error(`Menu không hợp lệ: ${value}`);
      const menu = push(spec.menu, parent, true);
      menu.fields[spec.field] = { name: spec.field, value };
      return { block: menu.id, shadow: menu.id };
    }
    if (spec === "boolean") throw new Error("Điều kiện cần một boolean block (ví dụ operator_gt).");
    const id = scalar(value, spec, parent);
    return { block: id, shadow: id };
  }
  function nodeBlock(node: BlockNode, parent: string | null, depth: number): VmBlock {
    if (depth > 16) throw new Error("Block lồng quá sâu (tối đa 16).");
    const spec = CATALOG[node.opcode];
    if (!spec) throw new Error(`Opcode không được hỗ trợ: ${node.opcode}`);
    if (spec.spriteOnly && options.isStage) throw new Error(`${node.opcode} không dùng được trên sân khấu.`);
    for (const key of Object.keys(node.inputs ?? {})) if (!Object.hasOwn(spec.inputs ?? {}, key)) throw new Error(`Input không hợp lệ: ${node.opcode}.${key}`);
    for (const key of Object.keys(node.fields ?? {})) if (!Object.hasOwn(spec.fields ?? {}, key)) throw new Error(`Field không hợp lệ: ${node.opcode}.${key}`);
    const block = push(node.opcode, parent);
    for (const [name, values] of Object.entries(spec.fields ?? {})) {
      const value = node.fields?.[name];
      if (value === undefined || (values && !values.includes(value))) throw new Error(`Field bắt buộc/không hợp lệ: ${node.opcode}.${name}`);
      block.fields[name] = { name, value };
      if (spec.variable && name === "VARIABLE") {
        const variable = options.variables.find(v => v.name === value && v.type === "");
        if (!variable) throw new Error(`Chưa có biến ${value}; gọi create_variable trước.`);
        block.fields[name].id = variable.id;
        block.fields[name].variableType = "";
      }
    }
    for (const [name, type] of Object.entries(spec.inputs ?? {})) {
      if (node.inputs?.[name] === undefined) throw new Error(`Thiếu input: ${node.opcode}.${name}`);
      block.inputs[name] = { name, ...input(node.inputs[name], type, block.id, depth) };
    }
    return block;
  }
  for (const script of scripts) {
    if (!script.length) throw new Error("Script trống.");
    chain(script, null, true, 0);
  }
  return blocks;
}
