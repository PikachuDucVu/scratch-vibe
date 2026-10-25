import { PROVIDER_TOOLS, parseTool, type ToolName } from "../../shared/tools";
import { graphTool, descendants, procedures } from "./graph";
import { assetTool } from "./assets";
import { fileTool, type ToolServices } from "./files";
import { mediaTool } from "./media";
import { originals, findTarget, describe, refresh, paginate, preview, type Invocation, type ScratchVm, type VmTarget, type VmVariable } from "./vm-types";
export type { ScratchVm, VmTarget } from "./vm-types";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Must stay below the chat schema's image limit so the agent loop can forward it.
const IMAGE_LIMIT = 110000;
// Re-encode to a bounded JPEG; never forward arbitrary renderer/asset URLs to the model.
async function toJpeg(src: string | HTMLCanvasElement, width: number, height: number) {
  let source: CanvasImageSource = src as HTMLCanvasElement;
  if (typeof src === "string") { const img = new Image(); img.src = src; await img.decode(); source = img; }
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height); // JPEG has no alpha.
  context.drawImage(source, 0, 0, width, height);
  for (const quality of [0.75, 0.6, 0.45, 0.3]) {
    const image = canvas.toDataURL("image/jpeg", quality);
    if (image.length <= IMAGE_LIMIT) return image;
  }
  throw new Error("Ảnh quá lớn; dùng assert_state thay thế.");
}
async function naturalSize(src: string) {
  const img = new Image(); img.src = src; await img.decode();
  // SVGs without width/height report 0; fall back to the browser's default replaced size.
  return { width: img.naturalWidth || 300, height: img.naturalHeight || 150 };
}
const imageTypes: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" };
function runtimeInfo(vm: ScratchVm, offset?: number, limit?: number) {
  const active = vm.runtime.threads.filter(t => !t.updateMonitor && t.status !== 4);
  return { running: active.length > 0, threadCount: active.length, threads: active.slice(0, 30).map(t => ({ targetId: t.target.id, topBlock: t.topBlock, status: t.status })),
    clones: paginate(vm.runtime.targets.filter(t => !t.isOriginal && !t.isStage).map(t => ({ id: t.id, name: t.getName(), x: t.x, y: t.y, visible: t.visible })), offset, limit),
    pressedKeys: ["space", "up arrow", "down arrow", "left arrow", "right arrow", ..."abcdefghijklmnopqrstuvwxyz0123456789"].filter(key => vm.runtime.ioDevices.keyboard.getKeyIsDown(key)),
    mouse: { x: vm.runtime.ioDevices.mouse.getScratchX(), y: vm.runtime.ioDevices.mouse.getScratchY(), isDown: vm.runtime.ioDevices.mouse.getIsDown() } };
}
function snapshot(vm: ScratchVm) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chụp sân khấu quá thời gian.")), 5000);
    vm.renderer.requestSnapshot(url => { clearTimeout(timer); resolve(url); }); vm.renderer.draw();
  });
}
const KEY_NAMES: Record<string, string> = { space: " ", "right arrow": "ArrowRight", "left arrow": "ArrowLeft", "up arrow": "ArrowUp", "down arrow": "ArrowDown" };
function mousePosition(vm: ScratchVm, x: number, y: number) {
  const canvasWidth = vm.renderer.canvas.clientWidth, canvasHeight = vm.renderer.canvas.clientHeight;
  if (!canvasWidth || !canvasHeight) throw new Error("Sân khấu chưa hiển thị để giả lập chuột.");
  return { x: Math.max(0.001, (x / 480 + 0.5) * canvasWidth), y: Math.max(0.001, (0.5 - y / 360) * canvasHeight), canvasWidth, canvasHeight };
}
type RecordArgs = Extract<Invocation, { name: "record_run" }>["args"];
const round = (n: number) => Math.round(n * 10) / 10;
// Samples the running project over time and builds a contact sheet so a vision model can judge motion.
async function recordRun(vm: ScratchVm, a: RecordArgs) {
  const targets = a.targetIds?.length ? a.targetIds.map(id => findTarget(vm, id)) : originals(vm).filter(t => !t.isStage).slice(0, 8);
  const stage = vm.runtime.getTargetForStage();
  const variables = [stage, ...targets].flatMap(t => Object.values(t.variables).filter(v => v.type === "").map(v => ({ owner: t, v }))).slice(0, 20);
  const frameCount = a.frames ?? 4, duration = a.durationMs;
  const frameTimes = frameCount === 1 ? [duration] : Array.from({ length: frameCount }, (_, i) => Math.round(i * duration / (frameCount - 1)));
  const read = () => targets.map(t => ({ x: round(t.x), y: round(t.y), d: round(t.direction), c: t.currentCostume, v: t.visible, s: round(t.size) }));
  const samples: { t: number; targets: ReturnType<typeof read>; vars: unknown[] }[] = [];
  const frames: { t: number; url: string }[] = [];
  const pressed = new Set<string>(), timers: ReturnType<typeof setTimeout>[] = [];
  const release = () => {
    for (const key of pressed) vm.postIOData("keyboard", { key, isDown: false });
    pressed.clear();
  };
  if (a.greenFlag) vm.greenFlag();
  const start = performance.now();
  try {
    for (const input of a.inputs ?? []) {
      timers.push(setTimeout(() => {
        if (input.device === "keyboard") {
          const key = KEY_NAMES[input.key!] ?? input.key!; // Checked by parseTool (checkRecordInputs).
          vm.postIOData("keyboard", { key, isDown: true }); pressed.add(key);
          timers.push(setTimeout(() => { vm.postIOData("keyboard", { key, isDown: false }); pressed.delete(key); }, input.durationMs ?? 150));
        } else {
          const mouse = mousePosition(vm, input.x!, input.y!);
          vm.postIOData("mouse", { ...mouse, isDown: true });
          timers.push(setTimeout(() => vm.postIOData("mouse", { ...mouse, isDown: false }), input.durationMs ?? 100));
        }
      }, input.atMs));
    }
    let nextFrame = 0;
    for (;;) {
      const t = Math.round(performance.now() - start);
      samples.push({ t, targets: read(), vars: variables.map(({ v }) => preview(v.value)) });
      while (nextFrame < frameTimes.length && t >= frameTimes[nextFrame]) { frames.push({ t, url: await snapshot(vm) }); nextFrame++; }
      if (t >= duration) break;
      await delay(Math.min(100, duration - t));
    }
  } finally {
    for (const timer of timers) clearTimeout(timer);
    release();
  }
  // Contact sheet: up to 3 columns of 240x180 frames, each labeled with its time.
  const columns = Math.min(3, frames.length), rows = Math.ceil(frames.length / columns);
  const sheet = document.createElement("canvas"); sheet.width = columns * 240; sheet.height = rows * 180;
  const ctx = sheet.getContext("2d")!; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, sheet.width, sheet.height);
  for (const [i, frame] of frames.entries()) {
    const img = new Image(); img.src = frame.url; await img.decode();
    const x = (i % columns) * 240, y = Math.floor(i / columns) * 180;
    ctx.drawImage(img, x, y, 240, 180);
    ctx.strokeStyle = "#94a3b8"; ctx.strokeRect(x + 0.5, y + 0.5, 239, 179);
    ctx.fillStyle = "rgba(15,23,42,.75)"; ctx.fillRect(x + 4, y + 4, 62, 18);
    ctx.fillStyle = "#ffffff"; ctx.font = "12px sans-serif"; ctx.fillText(`t=${(frame.t / 1000).toFixed(1)}s`, x + 8, y + 17);
  }
  const summary = targets.map((t, i) => {
    const track = samples.map(s => s.targets[i]);
    let distance = 0, costumeChanges = 0, visibilityChanges = 0;
    for (let k = 1; k < track.length; k++) {
      distance += Math.hypot(track[k].x - track[k - 1].x, track[k].y - track[k - 1].y);
      if (track[k].c !== track[k - 1].c) costumeChanges++;
      if (track[k].v !== track[k - 1].v) visibilityChanges++;
    }
    const xs = track.map(p => p.x), ys = track.map(p => p.y);
    return { id: t.id, name: t.getName(), start: track[0], end: track.at(-1), minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), distance: round(distance), costumeChanges, visibilityChanges };
  });
  const variableSummary = variables.map(({ owner, v }, i) => {
    const values = samples.map(s => s.vars[i]);
    return { id: v.id, name: v.name, owner: owner.getName(), start: values[0], end: values.at(-1), changes: values.filter((value, k) => k > 0 && value !== values[k - 1]).length };
  });
  // At most 12 evenly spaced timeline rows keep the result small.
  const step = Math.max(1, Math.ceil(samples.length / 12));
  const timeline = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
  return { durationMs: duration, frames: frames.map(f => f.t), targets: summary, variables: variableSummary, timeline, image: await toJpeg(sheet, sheet.width, sheet.height), runtime: runtimeInfo(vm) };
}
function ownVariable(target: VmTarget, id: string) {
  const variable = target.variables[id]; if (!variable) throw new Error("Biến/list không tồn tại trên target sở hữu.");
  if (variable.isCloud) throw new Error("Không sửa cloud variable bằng AI.");
  return variable;
}
function newVariable(target: VmTarget, name: string, type: string, value: unknown, allowExisting = false) {
  let variable = Object.values(target.variables).find(v => v.name === name && v.type === type);
  if (variable && !allowExisting) throw new Error("Tên đã tồn tại; dùng tool cập nhật theo ID.");
  if (variable?.isCloud) throw new Error("Không sửa cloud variable bằng AI.");
  if (!variable) {
    if (Object.keys(target.variables).length >= 200) throw new Error("Tối đa 200 biến/list/broadcast mỗi target.");
    const id = crypto.randomUUID(); target.createVariable(id, name, type, false); variable = target.variables[id];
  }
  variable.value = value; return variable;
}
function ensureMonitor(vm: ScratchVm, target: VmTarget, variable: VmVariable) {
  if (!["", "list"].includes(variable.type)) return;
  const field = variable.type === "list" ? "LIST" : "VARIABLE", monitors = vm.runtime.monitorBlocks;
  if (!monitors._blocks[variable.id]) monitors.createBlock({ id: variable.id, opcode: variable.type === "list" ? "data_listcontents" : "data_variable", next: null, parent: null, inputs: {}, fields: { [field]: { name: field, value: variable.name, id: variable.id, variableType: variable.type } }, shadow: false, topLevel: true, targetId: target.isStage ? null : target.id });
}
function variableSummary(variable: VmVariable) { return { id: variable.id, name: variable.name, type: variable.type, value: preview(variable.value), length: Array.isArray(variable.value) ? variable.value.length : undefined }; }
export async function executeVmTool(vm: ScratchVm, name: ToolName, raw: unknown, services: ToolServices = {}): Promise<unknown> {
  const call = { name, args: parseTool(name, raw) } as Invocation;
  if (PROVIDER_TOOLS.has(name)) throw new Error(`${name} chạy ở app, không chạy trong editor.`);
  const fileResult = await fileTool(vm, call, services); if (fileResult !== undefined) return fileResult;
  const assetResult = await assetTool(vm, call); if (assetResult !== undefined) return assetResult;
  const mediaResult = await mediaTool(vm, call); if (mediaResult !== undefined) return mediaResult;
  if (call.name === "record_run") return recordRun(vm, call.args);
  if (call.name === "get_project") {
    const page = paginate(originals(vm).map(describe), call.args.offset, call.args.limit ?? 20);
    return { targets: page.items, total: page.total, nextOffset: page.nextOffset, editingTargetId: vm.editingTarget?.id, extensions: ["pen", "music"].filter(e => vm.extensionManager.isExtensionLoaded(e)) };
  }
  if (call.name === "load_extension") {
    await vm.extensionManager.loadExtensionURL(call.args.extension); return { extension: call.args.extension, loaded: vm.extensionManager.isExtensionLoaded(call.args.extension) };
  }
  if (call.name === "get_runtime") return runtimeInfo(vm, call.args.offset, call.args.limit);
  if (call.name === "wait_project") { await delay(call.args.durationMs); return runtimeInfo(vm); }
  if (call.name === "run_project") { vm.greenFlag(); return { running: true, verified: false }; }
  if (call.name === "stop_project") { vm.stopAll(); return { running: false }; }
  if (call.name === "capture_stage") {
    const dataUrl = await snapshot(vm);
    if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("Ảnh sân khấu không hợp lệ.");
    return { image: await toJpeg(dataUrl, 480, 360), width: 480, height: 360 };
  }
  if (call.name === "test_input") {
    const a = call.args;
    if (a.device === "answer") { if (a.text === undefined) throw new Error("answer cần text."); vm.runtime.emit("ANSWER", a.text); }
    else if (a.device === "keyboard") {
      if (!a.key) throw new Error("keyboard cần key.");
      const key = KEY_NAMES[a.key] ?? a.key;
      try { vm.postIOData("keyboard", { key, isDown: true }); await delay(a.durationMs ?? 100); }
      finally { vm.postIOData("keyboard", { key, isDown: false }); }
    } else {
      if (a.x === undefined || a.y === undefined) throw new Error("mouse cần x/y.");
      const mouse = mousePosition(vm, a.x, a.y);
      try { vm.postIOData("mouse", { ...mouse, isDown: true }); await delay(a.durationMs ?? 100); }
      finally { vm.postIOData("mouse", { ...mouse, isDown: false }); }
    }
    return runtimeInfo(vm);
  }
  if (call.name === "create_broadcast") {
    const target = vm.runtime.getTargetForStage();
    const variable = newVariable(target, call.args.name, "broadcast_msg", call.args.name, true);
    // emitWorkspaceUpdate garbage-collects unused broadcasts. Keep it until first reference.
    vm.runtime.emitProjectChanged(); return variableSummary(variable);
  }
  if (!("targetId" in call.args)) throw new Error(`Tool chưa hỗ trợ: ${name}`);
  const target = findTarget(vm, call.args.targetId!);
  if (call.name === "get_scripts") {
    const ids = call.args.scriptId ? [...descendants(target, call.args.scriptId)] : Object.keys(target.blocks._blocks);
    const page = paginate(ids.map(id => target.blocks._blocks[id]), call.args.offset, call.args.limit);
    return { targetId: target.id, scripts: page.items.filter(b => b.topLevel).map(b => b.id), scriptCount: target.blocks.getScripts().length,
      blocks: Object.fromEntries(page.items.map(b => [b.id, b])), total: page.total, nextOffset: page.nextOffset };
  }
  if (call.name === "get_procedures") return { procedures: procedures(target) };
  if (call.name === "get_costume_image") {
    const index = call.args.index ?? target.currentCostume, costume = target.getCostumes()[index];
    if (!costume) throw new Error("Costume index không hợp lệ; xem get_assets.");
    const data = (costume.asset as { data?: Uint8Array } | undefined)?.data;
    const type = imageTypes[String(costume.dataFormat).toLowerCase()];
    if (!data?.length || !type) throw new Error("Không đọc được dữ liệu ảnh của costume này.");
    // Copy into this realm: asset bytes belong to the parent editor's window.
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type }));
    try {
      const natural = await naturalSize(url);
      // Fit within 360px; enlarge tiny costumes (max 4x) so details stay visible.
      const scale = Math.min(360 / natural.width, 360 / natural.height, 4);
      const width = Math.max(1, Math.round(natural.width * scale)), height = Math.max(1, Math.round(natural.height * scale));
      const resolution = Number(costume.bitmapResolution) || 1;
      return { targetId: target.id, index, name: costume.name.slice(0, 120), dataFormat: costume.dataFormat, isCurrent: index === target.currentCostume,
        stageSize: { width: Math.round(natural.width / resolution), height: Math.round(natural.height / resolution) },
        rotationCenter: { x: costume.rotationCenterX, y: costume.rotationCenterY }, width, height, image: await toJpeg(url, width, height) };
    } finally { URL.revokeObjectURL(url); }
  }
  if (call.name === "get_comments") return paginate(Object.values(target.comments).map(c => ({ id: c.id, blockId: c.blockId, text: c.text.slice(0, 4000), truncated: c.text.length > 4000, x: c.x, y: c.y })), call.args.offset, call.args.limit);
  if (call.name === "get_assets") {
    const kind = call.args.kind ?? "costume";
    return { kind, ...paginate((kind === "costume" ? target.getCostumes() : target.sprite.sounds).map((a, index) => ({ index, name: a.name, assetId: a.assetId, dataFormat: a.dataFormat })), call.args.offset, call.args.limit) };
  }
  if (call.name === "get_variables") {
    if (call.args.variableId) {
      const v = target.variables[call.args.variableId]; if (!v) throw new Error("Biến không tồn tại.");
      if (Array.isArray(v.value)) return { id: v.id, name: v.name, type: v.type, ...paginate(v.value.map(v => typeof v === "string" ? v.slice(0, 2000) : v), call.args.offset, call.args.limit), itemTextLimit: 2000 };
      if (typeof v.value === "string") { const offset = call.args.offset ?? 0, limit = Math.min(call.args.limit ?? 2000, 2000); return { id: v.id, name: v.name, value: v.value.slice(offset, offset + limit), nextOffset: offset + limit < v.value.length ? offset + limit : null }; }
      return { id: v.id, name: v.name, type: v.type, value: v.value };
    }
    return paginate(Object.values(target.variables).map(variableSummary), call.args.offset, call.args.limit);
  }
  const graphResult = graphTool(vm, target, call); if (graphResult !== undefined) return graphResult;
  switch (call.name) {
    case "create_variable": case "create_list": {
      const variable = call.name === "create_variable" ? newVariable(target, call.args.name, "", call.args.value, true) : newVariable(target, call.args.name, "list", [...call.args.items]);
      ensureMonitor(vm, target, variable); refresh(vm, target); return variableSummary(variable);
    }
    case "set_variable": case "rename_variable": case "delete_variable": case "update_list": case "set_monitor": {
      const a = call.args, variable = ownVariable(target, a.variableId);
      if (call.name === "set_variable") { if (variable.type !== "") throw new Error("Chỉ set scalar variable."); variable.value = call.args.value; }
      if (call.name === "rename_variable") {
        if (Object.values(target.variables).some(v => v.id !== variable.id && v.type === variable.type && v.name === call.args.name)) throw new Error("Tên đã tồn tại.");
        target.renameVariable(variable.id, call.args.name);
        for (const t of vm.runtime.targets) for (const b of Object.values(t.blocks._blocks)) for (const f of Object.values(b.fields)) if (f.id === variable.id) f.value = call.args.name;
        for (const t of vm.runtime.targets) t.blocks.resetCache();
        if (variable.type === "broadcast_msg") variable.value = variable.name;
      }
      if (call.name === "delete_variable") {
        if (vm.runtime.targets.some(t => Object.values(t.blocks._blocks).some(b => Object.values(b.fields).some(f => f.id === variable.id) || (b.opcode === "sensing_of" && b.fields.PROPERTY?.value === variable.name)))) throw new Error("Biến/list/broadcast vẫn được block tham chiếu; xóa/sửa tham chiếu trước.");
        target.deleteVariable(variable.id);
      }
      if (call.name === "update_list") {
        if (variable.type !== "list" || !Array.isArray(variable.value)) throw new Error("variableId không phải list.");
        const a = call.args, items = [...variable.value], i = a.index === undefined ? -1 : a.index - 1;
        if (["set", "append"].includes(a.operation) && !a.items) throw new Error("Thao tác cần items.");
        if (["insert", "replace"].includes(a.operation) && a.value === undefined) throw new Error("Thao tác cần value.");
        if (["insert", "replace", "delete"].includes(a.operation) && (i < 0 || i >= items.length + (a.operation === "insert" ? 1 : 0))) throw new Error("Index list ngoài phạm vi (bắt đầu từ 1).");
        if (a.operation === "clear" || a.operation === "set") items.length = 0;
        if (a.operation === "set" || a.operation === "append") items.push(...a.items!);
        if (a.operation === "insert") items.splice(i, 0, a.value);
        if (a.operation === "replace") items[i] = a.value;
        if (a.operation === "delete") items.splice(i, 1);
        if (items.length > 10000) throw new Error("Tối đa 10.000 phần tử qua tool list.");
        variable.value = items; variable._monitorUpToDate = false;
      }
      if (call.name === "set_monitor") {
        if (!["", "list"].includes(variable.type)) throw new Error("Broadcast không có monitor.");
        ensureMonitor(vm, target, variable);
        vm.setEditingTarget(target.id); vm.runtime.monitorBlocks.changeBlock({ id: variable.id, element: "checkbox", value: call.args.visible }, vm.runtime);
      }
      refresh(vm, target); return call.name === "delete_variable" ? { deleted: variable.id } : variableSummary(variable);
    }
    case "set_comment": {
      const a = call.args, old = a.commentId ? target.comments[a.commentId] : undefined;
      if (a.commentId && !old) throw new Error("Comment không tồn tại.");
      const blockId = a.blockId !== undefined ? a.blockId : old?.blockId ?? null;
      const block = blockId ? target.blocks._blocks[blockId] : null;
      if (blockId && !block) throw new Error("Block không tồn tại.");
      if (block?.comment && block.comment !== a.commentId) throw new Error("Block đã có comment.");
      if (old) { if (old.blockId && target.blocks._blocks[old.blockId]) delete target.blocks._blocks[old.blockId].comment;
        Object.assign(old, { text: a.text, blockId, x: a.x ?? old.x, y: a.y ?? old.y }); if (block) block.comment = old.id;
      } else target.createComment(crypto.randomUUID(), blockId, a.text, a.x ?? 40, a.y ?? 40, 250, 180, false);
      refresh(vm, target); return { commentId: old?.id ?? Object.values(target.comments).at(-1)!.id };
    }
    case "delete_comment": {
      const comment = target.comments[call.args.commentId]; if (!comment) throw new Error("Comment không tồn tại.");
      if (comment.blockId && target.blocks._blocks[comment.blockId]) delete target.blocks._blocks[comment.blockId].comment;
      delete target.comments[comment.id]; refresh(vm, target); return { deleted: comment.id };
    }
    case "assert_state": {
      const a = call.args; let actual: unknown;
      if (a.property === "variable" || a.property === "listLength") {
        const v = target.variables[a.variableId ?? ""]; if (!v) throw new Error("Cần variableId thuộc target.");
        if (a.property === "listLength" && !Array.isArray(v.value)) throw new Error("Biến không phải list.");
        actual = a.property === "listLength" ? (v.value as unknown[]).length : v.value;
      } else actual = target[a.property];
      // Scratch stores numeric literals in text slots as strings. Numeric assertions
      // accept finite numeric strings while preserving the raw actual value in the result.
      const numeric = typeof actual === "number" ? actual : typeof actual === "string" && actual.trim() !== "" ? Number(actual) : NaN;
      const passed = typeof a.expected === "number" && Number.isFinite(numeric) ? Math.abs(numeric - a.expected) <= (a.tolerance ?? 0) : actual === a.expected;
      return { passed, property: a.property, expected: a.expected, actual: preview(actual) };
    }
    case "delete_sprite": case "duplicate_sprite": case "set_sprite": {
      if (target.isStage) throw new Error("Tool chỉ dùng cho sprite.");
      if (call.name === "delete_sprite") { vm.stopAll(); vm.deleteSprite(target.id); refresh(vm); return { deleted: target.id }; }
      if (call.name === "duplicate_sprite") {
        if (originals(vm).length >= 50) throw new Error("Tối đa 49 sprite.");
        await vm.duplicateSprite(target.id); vm.renameSprite(vm.editingTarget.id, call.args.name); refresh(vm); return describe(vm.editingTarget);
      }
      const a = call.args;
      if (a.costume !== undefined && !target.getCostumes()[a.costume]) throw new Error("Costume index không hợp lệ.");
      if (a.x !== undefined || a.y !== undefined) target.setXY(a.x ?? target.x, a.y ?? target.y);
      if (a.direction !== undefined) target.setDirection(a.direction);
      if (a.size !== undefined) target.setSize(a.size);
      if (a.visible !== undefined) target.setVisible(a.visible);
      if (a.name !== undefined) vm.renameSprite(target.id, a.name);
      if (a.rotationStyle !== undefined) target.setRotationStyle(a.rotationStyle);
      if (a.draggable !== undefined) target.setDraggable(a.draggable);
      if (a.costume !== undefined) target.setCostume(a.costume);
      if (a.layer !== undefined) { target.goToBack(); target.goForwardLayers(a.layer); }
      refresh(vm, target); return describe(target);
    }
  }
  throw new Error(`Tool chưa hỗ trợ: ${name}`);
}
