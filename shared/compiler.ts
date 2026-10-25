import { CATALOG, type InputSpec } from "./catalog";
import { type BlockNode } from "./tools";

export interface VmBlock {
  id: string; opcode: string; next: string | null; parent: string | null;
  inputs: Record<string, { name: string; block: string | null; shadow: string | null }>;
  fields: Record<string, { name: string; value: string; id?: string; variableType?: string }>;
  mutation?: Record<string, unknown>; comment?: string;
  shadow: boolean; topLevel: boolean; x?: number; y?: number;
}
export interface ProcedureInfo { proccode: string; argumentids: string[]; argumentnames: string[]; argumentdefaults: (string | number | boolean)[]; warp: boolean }
export interface CompileOptions { isStage: boolean; variables: VariableInfo[]; yOffset?: number; id?: () => string; procedures?: ProcedureInfo[]; parameters?: { name: string; type: "string_number" | "boolean" }[]; extensions?: string[]; stackOnly?: boolean }
export function isTerminal(node: Pick<BlockNode, "opcode" | "fields">) {
  return CATALOG[node.opcode]?.kind === "terminal" && !(node.opcode === "control_stop" && node.fields?.STOP_OPTION === "other scripts in sprite");
}
export function resolveVariable(variables: VariableInfo[], value: string, type: string) {
  const entries = [...new Map(variables.map(v => [v.id, v])).values()].filter(v => v.type === type);
  const byId = entries.find(v => v.id === value);
  if (byId) return byId;
  const matches = entries.filter(v => v.name === value);
  if (matches.length > 1) throw new Error(`Tên ${value} trùng phạm vi; dùng ID chính xác từ get_variables.`);
  if (!matches.length) throw new Error(`Chưa có biến/list/broadcast ${value}; tạo trước khi tham chiếu.`);
  return matches[0];
}
export interface VariableInfo { id: string; name: string; type: string }

// Compile fully before touching the VM. Unknown opcodes, fields, bad graphs and
// unresolved variables fail atomically, rather than inserting half a script.
export function compileScripts(scripts: BlockNode[][], options: CompileOptions) {
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
      if (top && index === 0 && !options.stackOnly ? spec.kind !== "hat" : !["stack", "terminal"].includes(spec.kind)) {
        throw new Error(top && index === 0 ? "Script phải bắt đầu bằng event hat." : `Không thể nối ${node.opcode} vào stack.`);
      }
      if (index > 0 && isTerminal(nodes[index - 1])) throw new Error("Không thể nối block sau forever/stop.");
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
  function input(value: unknown, spec: InputSpec, parent: string, depth: number): { block: string | null; shadow: string | null } {
    if (spec === "stack") {
      if (!Array.isArray(value)) throw new Error("SUBSTACK phải là mảng block.");
      return { block: chain(value, parent, false, depth + 1), shadow: null };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const node = value as BlockNode;
      const childSpec = CATALOG[node.opcode];
      if (!childSpec || (spec === "boolean" ? childSpec.kind !== "boolean" : !["reporter", "boolean"].includes(childSpec.kind))) {
        throw new Error(`Reporter không phù hợp với input: ${node.opcode}`);
      }
      if (typeof spec === "object" && !spec.reporter) throw new Error("Menu không hỗ trợ reporter.");
      const child = nodeBlock(node, parent, depth + 1);
      const shadow = spec === "boolean" ? null : typeof spec === "object"
        ? input(spec.values?.[0] ?? (spec.variableType ? options.variables.find(v => v.type === spec.variableType)?.id : ""), { ...spec, reporter: false }, parent, depth).shadow
        : spec === "color" ? input("#000000", "color", parent, depth).shadow : scalar(spec === "number" ? 0 : "", spec, parent);
      return { block: child.id, shadow };
    }
    if (typeof spec === "object") {
      if (typeof value !== "string" || value.length > 120) throw new Error("Menu phải là tên dạng chuỗi.");
      if (spec.values && !spec.values.includes(value)) throw new Error(`Menu không hợp lệ: ${value}`);
      const menu = push(spec.menu, parent, true);
      menu.fields[spec.field] = { name: spec.field, value };
      if (spec.variableType !== undefined) {
        const variable = resolveVariable(options.variables, value, spec.variableType);
        menu.fields[spec.field] = { name: spec.field, value: variable.name, id: variable.id, variableType: variable.type };
      }
      return { block: menu.id, shadow: menu.id };
    }
    if (spec === "color") {
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Màu phải có dạng #rrggbb.");
      const color = push("colour_picker", parent, true);
      color.fields.COLOUR = { name: "COLOUR", value };
      return { block: color.id, shadow: color.id };
    }
    if (spec === "boolean") throw new Error("Điều kiện cần một boolean block (ví dụ operator_gt).");
    const id = scalar(value, spec, parent);
    return { block: id, shadow: id };
  }
  function nodeBlock(node: BlockNode, parent: string | null, depth: number): VmBlock {
    if (depth > 16) throw new Error("Block lồng quá sâu (tối đa 16).");
    let spec = CATALOG[node.opcode];
    const procedure = node.opcode === "procedures_call" ? options.procedures?.find(p => p.proccode === node.fields?.PROCEDURE) : undefined;
    if (node.opcode === "procedures_call") {
      if (!procedure) throw new Error("My Block chưa tồn tại; gọi define_procedure hoặc get_procedures.");
      spec = { ...spec, inputs: Object.fromEntries(procedure.argumentnames.map((name, i) => [name, procedure.proccode.match(/%[snb]/g)?.[i] === "%b" ? "boolean" : "text"])) };
    }
    if (!spec) throw new Error(`Opcode không được hỗ trợ: ${node.opcode}`);
    if (spec.spriteOnly && options.isStage) throw new Error(`${node.opcode} không dùng được trên sân khấu.`);
    if (spec.stageOnly && !options.isStage) throw new Error(`${node.opcode} chỉ dùng được trên sân khấu.`);
    if (spec.extension && !options.extensions?.includes(spec.extension)) throw new Error(`Gọi load_extension ${spec.extension} trước.`);
    if (node.opcode.startsWith("argument_reporter_")) {
      const param = options.parameters?.find(p => p.name === node.fields?.VALUE);
      if (!param || node.opcode !== `argument_reporter_${param.type}`) throw new Error("Tham số không thuộc My Block hiện tại hoặc sai kiểu.");
    }
    for (const key of Object.keys(node.inputs ?? {})) if (!Object.hasOwn(spec.inputs ?? {}, key)) throw new Error(`Input không hợp lệ: ${node.opcode}.${key}`);
    for (const key of Object.keys(node.fields ?? {})) if (!Object.hasOwn(spec.fields ?? {}, key)) throw new Error(`Field không hợp lệ: ${node.opcode}.${key}`);
    const block = push(node.opcode, parent);
    for (const [name, values] of Object.entries(spec.fields ?? {})) {
      const value = node.fields?.[name];
      if (value === undefined || (values && !values.includes(value))) throw new Error(`Field bắt buộc/không hợp lệ: ${node.opcode}.${name}`);
      block.fields[name] = { name, value };
      if ((spec.variable && name === "VARIABLE") || (spec.variableType !== undefined && ["LIST", "BROADCAST_OPTION"].includes(name))) {
        const variable = resolveVariable(options.variables, value, spec.variableType ?? "");
        block.fields[name] = { name, value: variable.name, id: variable.id, variableType: variable.type };
      }
    }
    for (const [name, type] of Object.entries(spec.inputs ?? {})) {
      if (node.inputs?.[name] === undefined) throw new Error(`Thiếu input: ${node.opcode}.${name}`);
      block.inputs[name] = { name, ...input(node.inputs[name], type, block.id, depth) };
    }
    if (procedure) {
      block.fields = {};
      block.inputs = Object.fromEntries(procedure.argumentnames.map((name, i) => [procedure.argumentids[i], { ...block.inputs[name], name: procedure.argumentids[i] }]));
      block.mutation = { tagName: "mutation", children: [], proccode: procedure.proccode, argumentids: JSON.stringify(procedure.argumentids), warp: String(procedure.warp) };
    }
    if (node.opcode === "control_stop") block.mutation = { tagName: "mutation", children: [], hasnext: String(node.fields?.STOP_OPTION === "other scripts in sprite") };
    return block;
  }
  for (const script of scripts) {
    if (!script.length) throw new Error("Script trống.");
    chain(script, null, true, 0);
  }
  return blocks;
}

export function compileProcedure(procedure: ProcedureInfo, body: BlockNode[], options: CompileOptions): VmBlock[] {
  const parameters = procedure.argumentnames.map((name, i) => ({ name, type: (procedure.proccode.match(/%[snb]/g)?.[i] === "%b" ? "boolean" : "string_number") as "boolean" | "string_number" }));
  const compiled = body.length ? compileScripts([body], { ...options, stackOnly: true, parameters, procedures: [...(options.procedures ?? []), procedure] }) : [];
  const definitionId = crypto.randomUUID(), prototypeId = crypto.randomUUID();
  const empty = (id: string, opcode: string, parent: string | null, shadow: boolean): VmBlock => ({ id, opcode, parent, next: null, shadow, topLevel: false, inputs: {}, fields: {} });
  const definition = { ...empty(definitionId, "procedures_definition", null, false), topLevel: true, x: 40, y: options.yOffset ?? 40 };
  // Blockly 12 creates prototype parameter reporters from mutation; persisting them duplicates UI children.
  const prototype = empty(prototypeId, "procedures_prototype", definitionId, false);
  definition.inputs.custom_block = { name: "custom_block", block: prototypeId, shadow: null };
  prototype.mutation = { tagName: "mutation", children: [], proccode: procedure.proccode, argumentids: JSON.stringify(procedure.argumentids), argumentnames: JSON.stringify(procedure.argumentnames), argumentdefaults: JSON.stringify(procedure.argumentdefaults), warp: String(procedure.warp) };
  if (compiled[0]) { definition.next = compiled[0].id; compiled[0].parent = definitionId; compiled[0].topLevel = false; delete compiled[0].x; delete compiled[0].y; }
  return [definition, prototype, ...compiled];
}
