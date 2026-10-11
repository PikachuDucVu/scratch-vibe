import { describe, expect, it } from "vitest";
import { compileScripts } from "../shared/compiler";
import { parseTool, type BlockNode } from "../shared/tools";
const hat: BlockNode = { opcode: "event_whenflagclicked" };
const options = { isStage: false, variables: [{ id: "score-id", name: "Điểm", type: "" }] };

describe("declarative block compiler", () => {
  it("links hats, stacks, branches, reporters and shadow inputs", () => {
    const blocks = compileScripts([[hat, { opcode: "control_repeat", inputs: {
      TIMES: { opcode: "operator_add", inputs: { NUM1: 2, NUM2: 3 } },
      SUBSTACK: [{ opcode: "data_changevariableby", fields: { VARIABLE: "Điểm" }, inputs: { VALUE: 1 } }],
    } }]], options);
    const [top, repeat] = blocks;
    expect(top.topLevel).toBe(true);
    expect(top.parent).toBeNull();
    expect(top.next).toBe(repeat.id);
    expect(repeat.parent).toBe(top.id);
    const branch = blocks.find(block => block.id === repeat.inputs.SUBSTACK.block)!;
    expect(branch.parent).toBe(repeat.id);
    expect(branch.fields.VARIABLE).toMatchObject({ value: "Điểm", id: "score-id" });
    const reporter = blocks.find(block => block.id === repeat.inputs.TIMES.block)!;
    expect(reporter.opcode).toBe("operator_add");
    expect(reporter.parent).toBe(repeat.id);
    expect(repeat.inputs.TIMES.shadow).not.toBe(repeat.inputs.TIMES.block);
    for (const block of blocks) {
      if (block.parent) expect(blocks.some(parent => parent.id === block.parent)).toBe(true);
      for (const input of Object.values(block.inputs)) {
        if (input.block) expect(blocks.some(child => child.id === input.block)).toBe(true);
        if (input.shadow) expect(blocks.find(child => child.id === input.shadow)?.shadow).toBe(true);
      }
    }
  });
  it("creates menu shadows and boolean slots", () => {
    const blocks = compileScripts([[hat, { opcode: "control_if", inputs: {
      CONDITION: { opcode: "sensing_keypressed", inputs: { KEY_OPTION: "right arrow" } }, SUBSTACK: [],
    } }]], options);
    const condition = blocks.find(block => block.opcode === "sensing_keypressed")!;
    const menu = blocks.find(block => block.opcode === "sensing_keyoptions")!;
    expect(menu.shadow).toBe(true);
    expect(menu.fields.KEY_OPTION.value).toBe("right arrow");
    expect(condition.inputs.KEY_OPTION).toMatchObject({ block: menu.id, shadow: menu.id });
    expect(blocks.find(block => block.opcode === "control_if")!.inputs.CONDITION.shadow).toBeNull();
  });
  it.each([
    [{ opcode: "eval", inputs: {} }],
    [hat, { opcode: "motion_movesteps", inputs: { BAD: 10 } }],
    [hat, { opcode: "motion_movesteps", inputs: { STEPS: 10 }, fields: { BAD: "x" } }],
    [hat, { opcode: "control_if", inputs: { CONDITION: 1, SUBSTACK: [] } }],
    [hat, { opcode: "control_forever", inputs: { SUBSTACK: [] } }, { opcode: "control_wait", inputs: { DURATION: 1 } }],
    [hat, { opcode: "operator_add", inputs: { NUM1: 1, NUM2: 1 } }],
    [hat, { opcode: "data_variable", fields: { VARIABLE: "missing" } }],
    [hat, { opcode: "motion_setrotationstyle", fields: { STYLE: "invalid" } }],
    [hat, { opcode: "sensing_keypressed", inputs: { KEY_OPTION: "invalid" } }],
  ] as BlockNode[][])("rejects invalid script %#", (...nodes) => {
    expect(() => compileScripts([nodes], options)).toThrow();
  });
  it("rejects motion on stage and missing variables", () => {
    expect(() => compileScripts([[hat, { opcode: "motion_movesteps", inputs: { STEPS: 10 } }]], { ...options, isStage: true })).toThrow(/sân khấu/);
    expect(() => compileScripts([[hat, { opcode: "data_setvariableto", fields: { VARIABLE: "unknown" }, inputs: { VALUE: 0 } }]], options)).toThrow(/Chưa có biến/);
  });
  it("bounds nested payloads and rejects unknown tools/keys", () => {
    expect(() => parseTool("shell", { command: "rm -rf /" })).toThrow();
    expect(() => parseTool("get_project", { url: "http://evil" })).toThrow();
    expect(() => parseTool("set_sprite", { targetId: "sprite", size: 999999 })).toThrow();
    let deep: BlockNode = { opcode: "sensing_mousedown" };
    for (let i = 0; i < 30; i++) deep = { opcode: "operator_not", inputs: { OPERAND: deep } };
    expect(() => parseTool("add_scripts", { targetId: "sprite", scripts: [[hat, { opcode: "control_if", inputs: { CONDITION: deep, SUBSTACK: [] } }]] })).toThrow(/phức tạp/);
  });
});
