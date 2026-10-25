import { describe, expect, it } from "vitest";
import { CATALOG } from "../shared/catalog";
import { compileScripts, compileProcedure, type CompileOptions, type ProcedureInfo } from "../shared/compiler";
import type { BlockNode } from "../shared/tools";
const hat: BlockNode = { opcode: "event_whenflagclicked" };
const procedure: ProcedureInfo = { proccode: "Do %s %b", argumentids: ["arg1", "arg2"], argumentnames: ["n", "yes"], argumentdefaults: ["", false], warp: true };
const options: CompileOptions = { isStage: false, variables: [{ id: "scalar", name: "v", type: "" }, { id: "list", name: "l", type: "list" }, { id: "broadcast", name: "m", type: "broadcast_msg" }], procedures: [procedure], extensions: ["pen", "music"], parameters: [{ name: "n", type: "string_number" }, { name: "yes", type: "boolean" }] };
const condition: BlockNode = { opcode: "operator_equals", inputs: { OPERAND1: 1, OPERAND2: 1 } };
describe("expanded Scratch compiler", () => {
  it.each(Object.keys(CATALOG))("compiles %s with validated graph links", opcode => {
    const spec = CATALOG[opcode];
    const fields = Object.fromEntries(Object.entries(spec.fields ?? {}).map(([key, values]) => [key, values?.[0] ?? (key === "VARIABLE" ? "scalar" : key === "LIST" ? "list" : key === "BROADCAST_OPTION" ? "broadcast" : key === "PROCEDURE" ? procedure.proccode : key === "VALUE" ? opcode.endsWith("boolean") ? "yes" : "n" : "name")]));
    const inputs = Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([key, type]) => [key, typeof type === "object" ? type.variableType ? "broadcast" : type.values?.[0] ?? "1" : type === "stack" ? [] : type === "boolean" ? condition : type === "color" ? "#123456" : type === "number" ? 1 : "hello"]));
    const node: BlockNode = { opcode, fields, inputs };
    if (opcode === "procedures_call") node.inputs = { n: 2, yes: condition };
    const script = spec.kind === "hat" ? [node] : spec.kind === "reporter" ? [hat, { opcode: "looks_switchbackdropto", inputs: { BACKDROP: node } }] : spec.kind === "boolean" ? [hat, { opcode: "control_if", inputs: { CONDITION: node, SUBSTACK: [] } }] : [hat, node];
    const blocks = compileScripts([script], { ...options, isStage: spec.stageOnly ?? false });
    expect(blocks.some(b => b.opcode === opcode)).toBe(true);
    for (const b of blocks) {
      if (b.parent) expect(blocks.some(parent => parent.id === b.parent)).toBe(true);
      if (b.next) expect(blocks.find(next => next.id === b.next)?.parent).toBe(b.id);
      for (const input of Object.values(b.inputs)) {
        if (input.block) expect(blocks.some(child => child.id === input.block)).toBe(true);
        if (input.shadow) expect(blocks.find(child => child.id === input.shadow)?.shadow).toBe(true);
      }
    }
  });
  it("requires IDs when local/global variable names collide", () => {
    const vars = [...options.variables, { id: "other", name: "v", type: "" }];
    const script = (value: string): BlockNode[][] => [[hat, { opcode: "data_setvariableto", fields: { VARIABLE: value }, inputs: { VALUE: 1 } }]];
    expect(() => compileScripts(script("v"), { ...options, variables: vars })).toThrow(/phạm vi/);
    expect(() => compileScripts(script("scalar"), { ...options, variables: vars })).not.toThrow();
  });
  it("only permits reporters inside the correct procedure scope", () => {
    expect(() => compileScripts([[hat, { opcode: "motion_setx", inputs: { X: { opcode: "argument_reporter_string_number", fields: { VALUE: "n" } } } }]], { ...options, parameters: [] })).toThrow(/Tham số/);
    const blocks = compileProcedure(procedure, [{ opcode: "procedures_call", fields: { PROCEDURE: procedure.proccode }, inputs: { n: 1, yes: condition } }], options);
    expect(blocks[0].opcode).toBe("procedures_definition");
    expect(blocks[1].mutation).toMatchObject({ proccode: procedure.proccode, argumentids: '["arg1","arg2"]', warp: "true" });
    expect(blocks.find(b => b.opcode === "procedures_call")!.inputs).toHaveProperty("arg2");
  });
  it("supports stop-other-scripts without incorrectly terminating the stack", () => {
    expect(() => compileScripts([[hat, { opcode: "control_stop", fields: { STOP_OPTION: "other scripts in sprite" } }, { opcode: "looks_show" }]], options)).not.toThrow();
    expect(() => compileScripts([[hat, { opcode: "control_stop", fields: { STOP_OPTION: "this script" } }, { opcode: "looks_show" }]], options)).toThrow();
  });
  it("blocks arbitrary extensions and requires explicit safe-extension loading", () => {
    expect(() => compileScripts([[hat, { opcode: "pen_penDown" }]], { ...options, extensions: [] })).toThrow(/load_extension/);
    expect(() => compileScripts([[hat, { opcode: "evil_eval" }]], options)).toThrow();
    expect(() => compileScripts([[hat, { opcode: "pen_setPenColorToColor", inputs: { COLOR: "url(https://evil.example)" } }]], options)).toThrow();
  });
});
