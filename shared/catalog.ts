export type InputSpec = "number" | "text" | "boolean" | "stack" | { menu: string; field: string; values?: readonly string[] };
export interface BlockSpec {
  kind: "hat" | "stack" | "reporter" | "boolean" | "terminal";
  inputs?: Record<string, InputSpec>;
  fields?: Record<string, readonly string[] | null>;
  variable?: boolean;
  spriteOnly?: boolean;
}
const s = (inputs?: Record<string, InputSpec>, extra?: Partial<BlockSpec>): BlockSpec => ({ kind: "stack", inputs, ...extra });
const r = (inputs?: Record<string, InputSpec>, extra?: Partial<BlockSpec>): BlockSpec => ({ kind: "reporter", inputs, ...extra });
const b = (inputs: Record<string, InputSpec>): BlockSpec => ({ kind: "boolean", inputs });
const keyValues = ["space", "up arrow", "down arrow", "left arrow", "right arrow", "any", ..."abcdefghijklmnopqrstuvwxyz0123456789"];

// Deliberate allowlist: no eval, JavaScript, network, arbitrary extensions or procedures.
export const CATALOG: Record<string, BlockSpec> = {
  event_whenflagclicked: { kind: "hat" },
  event_whenkeypressed: { kind: "hat", fields: { KEY_OPTION: keyValues } },
  event_whenthisspriteclicked: { kind: "hat", spriteOnly: true },
  event_whenbackdropswitchesto: { kind: "hat", fields: { BACKDROP: null } },
  motion_movesteps: s({ STEPS: "number" }, { spriteOnly: true }),
  motion_turnright: s({ DEGREES: "number" }, { spriteOnly: true }),
  motion_turnleft: s({ DEGREES: "number" }, { spriteOnly: true }),
  motion_gotoxy: s({ X: "number", Y: "number" }, { spriteOnly: true }),
  motion_glidesecstoxy: s({ SECS: "number", X: "number", Y: "number" }, { spriteOnly: true }),
  motion_pointindirection: s({ DIRECTION: "number" }, { spriteOnly: true }),
  motion_changexby: s({ DX: "number" }, { spriteOnly: true }),
  motion_changeyby: s({ DY: "number" }, { spriteOnly: true }),
  motion_setx: s({ X: "number" }, { spriteOnly: true }),
  motion_sety: s({ Y: "number" }, { spriteOnly: true }),
  motion_ifonedgebounce: s(undefined, { spriteOnly: true }),
  motion_setrotationstyle: s(undefined, { fields: { STYLE: ["left-right", "don't rotate", "all around"] }, spriteOnly: true }),
  motion_xposition: r(undefined, { spriteOnly: true }),
  motion_yposition: r(undefined, { spriteOnly: true }),
  motion_direction: r(undefined, { spriteOnly: true }),
  looks_say: s({ MESSAGE: "text" }, { spriteOnly: true }),
  looks_sayforsecs: s({ MESSAGE: "text", SECS: "number" }, { spriteOnly: true }),
  looks_think: s({ MESSAGE: "text" }, { spriteOnly: true }),
  looks_thinkforsecs: s({ MESSAGE: "text", SECS: "number" }, { spriteOnly: true }),
  looks_show: s(undefined, { spriteOnly: true }),
  looks_hide: s(undefined, { spriteOnly: true }),
  looks_changesizeby: s({ CHANGE: "number" }, { spriteOnly: true }),
  looks_setsizeto: s({ SIZE: "number" }, { spriteOnly: true }),
  looks_size: r(undefined, { spriteOnly: true }),
  looks_nextcostume: s(undefined, { spriteOnly: true }),
  looks_nextbackdrop: s(),
  looks_switchcostumeto: s({ COSTUME: { menu: "looks_costume", field: "COSTUME" } }, { spriteOnly: true }),
  looks_switchbackdropto: s({ BACKDROP: { menu: "looks_backdrops", field: "BACKDROP" } }),
  looks_changeeffectby: s({ CHANGE: "number" }, { fields: { EFFECT: ["COLOR", "FISHEYE", "WHIRL", "PIXELATE", "MOSAIC", "BRIGHTNESS", "GHOST"] } }),
  looks_cleargraphiceffects: s(),
  control_wait: s({ DURATION: "number" }),
  control_repeat: s({ TIMES: "number", SUBSTACK: "stack" }),
  control_forever: s({ SUBSTACK: "stack" }, { kind: "terminal" }),
  control_if: s({ CONDITION: "boolean", SUBSTACK: "stack" }),
  control_if_else: s({ CONDITION: "boolean", SUBSTACK: "stack", SUBSTACK2: "stack" }),
  control_wait_until: s({ CONDITION: "boolean" }),
  control_repeat_until: s({ CONDITION: "boolean", SUBSTACK: "stack" }),
  control_stop: s(undefined, { kind: "terminal", fields: { STOP_OPTION: ["all", "this script"] } }),
  sensing_keypressed: b({ KEY_OPTION: { menu: "sensing_keyoptions", field: "KEY_OPTION", values: keyValues } }),
  sensing_touchingobject: b({ TOUCHINGOBJECTMENU: { menu: "sensing_touchingobjectmenu", field: "TOUCHINGOBJECTMENU" } }),
  sensing_mousedown: { kind: "boolean" },
  sensing_mousex: r(),
  sensing_mousey: r(),
  sensing_timer: r(),
  sensing_resettimer: s(),
  sensing_askandwait: s({ QUESTION: "text" }),
  sensing_answer: r(),
  operator_add: r({ NUM1: "number", NUM2: "number" }),
  operator_subtract: r({ NUM1: "number", NUM2: "number" }),
  operator_multiply: r({ NUM1: "number", NUM2: "number" }),
  operator_divide: r({ NUM1: "number", NUM2: "number" }),
  operator_random: r({ FROM: "number", TO: "number" }),
  operator_mod: r({ NUM1: "number", NUM2: "number" }),
  operator_round: r({ NUM: "number" }),
  operator_equals: b({ OPERAND1: "text", OPERAND2: "text" }),
  operator_gt: b({ OPERAND1: "text", OPERAND2: "text" }),
  operator_lt: b({ OPERAND1: "text", OPERAND2: "text" }),
  operator_and: b({ OPERAND1: "boolean", OPERAND2: "boolean" }),
  operator_or: b({ OPERAND1: "boolean", OPERAND2: "boolean" }),
  operator_not: b({ OPERAND: "boolean" }),
  operator_join: r({ STRING1: "text", STRING2: "text" }),
  operator_length: r({ STRING: "text" }),
  data_variable: r(undefined, { fields: { VARIABLE: null }, variable: true }),
  data_setvariableto: s({ VALUE: "text" }, { fields: { VARIABLE: null }, variable: true }),
  data_changevariableby: s({ VALUE: "number" }, { fields: { VARIABLE: null }, variable: true }),
};

export function catalogHelp(): string {
  return Object.entries(CATALOG).map(([opcode, spec]) => {
    const inputs = Object.entries(spec.inputs ?? {}).map(([name, type]) => `${name}:${typeof type === "string" ? type : `menu(${type.field})${type.values ? `[${type.values.join("|")}]` : ""}`}`).join(", ");
    const fields = Object.entries(spec.fields ?? {}).map(([name, values]) => `${name}:${values ? values.join("|") : "name"}`).join(", ");
    return `${opcode} (${spec.kind}${spec.spriteOnly ? ", sprite only" : ""})${inputs ? ` inputs{${inputs}}` : ""}${fields ? ` fields{${fields}}` : ""}`;
  }).join("\n");
}
