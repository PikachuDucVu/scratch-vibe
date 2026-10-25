import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { VmBlock } from "../../shared/compiler";
async function tool(page: Page, name: string, args: unknown = {}): Promise<any> {
  return page.evaluate(async ({ name, args }) => {
    const frame = document.querySelector<HTMLIFrameElement>('.editor-host iframe')!, requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Timeout")); }, 60000);
      function receive(event: MessageEvent) {
        if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", receive);
        if (event.data.type === "scratch:error") reject(new Error(event.data.message)); else resolve(event.data.result);
      }
      window.addEventListener("message", receive);
      frame.contentWindow!.postMessage({ type: "scratch:tool", requestId, name, args }, location.origin);
    });
  }, { name, args });
}
async function start(page: Page) {
  await page.goto("/"); await expect(page.getByText("Editor sẵn sàng", { exact: true })).toBeVisible();
  return targets(page);
}
async function targets(page: Page) {
  const p = await tool(page, "get_project"); return { cat: p.targets.find((t: any) => !t.isStage), stage: p.targets.find((t: any) => t.isStage) };
}
const hat = { opcode: "event_whenflagclicked" };
const number = (opcode: string, name: string, value: number) => ({ opcode, inputs: { [name]: value } });

test("broadcasts, clone lifecycle, lists, monitors and My Blocks actually execute and survive SB3", async ({ page }) => {
  let { cat, stage } = await start(page);
  const broadcast = await tool(page, "create_broadcast", { name: "go" });
  const list = await tool(page, "create_list", { targetId: stage.id, name: "Results", items: [] });
  const score = await tool(page, "create_variable", { targetId: stage.id, name: "Score", value: 0 });
  await tool(page, "set_monitor", { targetId: stage.id, variableId: list.id, visible: true });
  await tool(page, "set_monitor", { targetId: stage.id, variableId: score.id, visible: true });
  const proc = await tool(page, "define_procedure", { targetId: cat.id, name: "Move", parameters: [{ name: "distance", type: "string_number" }, { name: "enabled", type: "boolean" }], warp: true, body: [
    { opcode: "control_if", inputs: { CONDITION: { opcode: "argument_reporter_boolean", fields: { VALUE: "enabled" } }, SUBSTACK: [
      { opcode: "motion_changexby", inputs: { DX: { opcode: "argument_reporter_string_number", fields: { VALUE: "distance" } } } },
    ] } },
  ] });
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [
    [hat, number("motion_setx", "X", 0), { opcode: "procedures_call", fields: { PROCEDURE: proc.proccode }, inputs: { distance: 42, enabled: { opcode: "operator_equals", inputs: { OPERAND1: 1, OPERAND2: 1 } } } }, { opcode: "event_broadcastandwait", inputs: { BROADCAST_INPUT: broadcast.id } }, { opcode: "control_create_clone_of", inputs: { CLONE_OPTION: "_myself_" } }],
    [{ opcode: "event_whenbroadcastreceived", fields: { BROADCAST_OPTION: broadcast.id } }, { opcode: "data_addtolist", fields: { LIST: list.id }, inputs: { ITEM: "broadcast" } }],
    [{ opcode: "control_start_as_clone" }, { opcode: "data_changevariableby", fields: { VARIABLE: score.id }, inputs: { VALUE: 1 } }, { opcode: "data_addtolist", fields: { LIST: list.id }, inputs: { ITEM: "clone" } }, { opcode: "control_delete_this_clone" }],
  ] });
  await tool(page, "run_project");
  await expect.poll(async () => (await tool(page, "assert_state", { targetId: stage.id, property: "variable", variableId: score.id, expected: 1 })).passed).toBe(true);
  expect(await tool(page, "assert_state", { targetId: cat.id, property: "x", expected: 42 })).toMatchObject({ passed: true });
  expect((await tool(page, "get_variables", { targetId: stage.id, variableId: list.id })).items).toEqual(["broadcast", "clone"]);
  expect((await tool(page, "get_runtime")).clones.total).toBe(0);
  expect((await tool(page, "get_procedures", { targetId: cat.id })).procedures[0].proccode).toBe(proc.proccode);
  const snapshot = await tool(page, "save_snapshot", { name: "working" });
  await tool(page, "set_sprite", { targetId: cat.id, x: -42 });
  await tool(page, "restore_snapshot", { snapshotId: snapshot.snapshotId });
  ({ cat, stage } = await targets(page));
  expect(cat.x).toBe(42);
  expect((await tool(page, "get_procedures", { targetId: cat.id })).procedures).toHaveLength(1);
  const svg = page.frameLocator('.editor-host iframe').locator('.blocklyWorkspace .blocklyBlockCanvas').first();
  await expect(svg).toContainText("Move");
});

test("targeted editing, comments and pagination preserve unrelated scripts", async ({ page }) => {
  const { cat } = await start(page);
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [[hat, number("motion_setx", "X", 10), number("motion_sety", "Y", 20)], [{ opcode: "event_whenkeypressed", fields: { KEY_OPTION: "space" } }, number("motion_setx", "X", 99)]] });
  let graph = await tool(page, "get_scripts", { targetId: cat.id });
  const x = Object.values(graph.blocks as Record<string, VmBlock>).find(b => b.opcode === "motion_setx")!;
  const otherScript = graph.scripts[1];
  const comment = await tool(page, "set_comment", { targetId: cat.id, blockId: x.id, text: "hello" });
  await tool(page, "update_block", { targetId: cat.id, blockId: x.id, inputs: { X: 25 } });
  const added = await tool(page, "insert_blocks", { targetId: cat.id, blockId: x.id, position: "after", blocks: [number("motion_changexby", "DX", 5)] });
  await tool(page, "run_project"); await tool(page, "wait_project", { durationMs: 100 });
  expect((await tool(page, "assert_state", { targetId: cat.id, property: "x", expected: 30 })).passed).toBe(true);
  expect((await tool(page, "assert_state", { targetId: cat.id, property: "y", expected: 20 })).passed).toBe(true);
  expect((await tool(page, "get_comments", { targetId: cat.id })).items[0]).toMatchObject({ id: comment.commentId, blockId: x.id });
  await tool(page, "delete_block", { targetId: cat.id, blockId: added.firstBlockId });
  graph = await tool(page, "get_scripts", { targetId: cat.id });
  expect(graph.scripts).toContain(otherScript);
  await tool(page, "replace_script", { targetId: cat.id, scriptId: graph.scripts[0], script: [hat, number("motion_setx", "X", 7)] });
  await tool(page, "test_input", { device: "keyboard", key: "space", durationMs: 100 });
  expect((await tool(page, "assert_state", { targetId: cat.id, property: "x", expected: 99 })).passed).toBe(true);
  await tool(page, "replace_scripts", { targetId: cat.id, scripts: [[hat, ...Array.from({ length: 199 }, () => ({ opcode: "looks_say", inputs: { MESSAGE: "Hi" } }))]] });
  let offset = 0; const all: string[] = [];
  do { const result = await tool(page, "get_scripts", { targetId: cat.id, offset }); all.push(...Object.keys(result.blocks)); offset = result.nextOffset; } while (offset !== null);
  expect(all).toHaveLength(399); expect(new Set(all).size).toBe(399);
  await tool(page, "replace_scripts", { targetId: cat.id, scripts: [] });
  expect((await tool(page, "get_scripts", { targetId: cat.id })).total).toBe(0);
});

test("library assets, vector costumes, safe extensions, capture, exports and uploaded imports", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const { cat, stage } = await start(page);
  const blank = await tool(page, "add_sprite", { name: "Blank" });
  expect(blank.costumeCount).toBe(1);
  await tool(page, "create_costume", { targetId: blank.id, name: "Ball", width: 60, height: 60, shapes: [{ type: "ellipse", x: 0, y: 0, width: 60, height: 60, fill: "#ff0000" }] });
  await tool(page, "manage_asset", { targetId: blank.id, kind: "costume", index: 1, action: "rename", name: "Red ball" });
  await tool(page, "manage_asset", { targetId: blank.id, kind: "costume", index: 1, action: "duplicate" });
  await tool(page, "manage_asset", { targetId: blank.id, kind: "costume", index: 2, action: "reorder", newIndex: 0 });
  expect((await tool(page, "get_assets", { targetId: blank.id })).total).toBe(3);
  const sounds = await tool(page, "search_library", { kind: "sound", query: "pop", limit: 1 });
  await tool(page, "add_asset", { targetId: blank.id, libraryId: sounds.items[0].libraryId });
  expect((await tool(page, "get_assets", { targetId: blank.id, kind: "sound" })).total).toBe(1);
  const backdrops = await tool(page, "search_library", { kind: "backdrop", query: "Blue Sky", limit: 1 });
  await tool(page, "add_asset", { targetId: stage.id, libraryId: backdrops.items[0].libraryId });
  const sprites = await tool(page, "search_library", { kind: "sprite", query: "Ball", limit: 1 });
  const ball = await tool(page, "add_sprite", { name: "Library ball", libraryId: sprites.items[0].libraryId });
  expect(ball.costumeCount).toBeGreaterThan(0);
  await tool(page, "delete_sprite", { targetId: ball.id });
  await tool(page, "load_extension", { extension: "pen" });
  await tool(page, "load_extension", { extension: "music" });
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [[hat, { opcode: "pen_clear" }, { opcode: "pen_setPenColorToColor", inputs: { COLOR: "#0000ff" } }, { opcode: "pen_penDown" }, number("motion_movesteps", "STEPS", 50), { opcode: "pen_penUp" }, number("music_setTempo", "TEMPO", 100), number("sound_setvolumeto", "VOLUME", 20)]] });
  await tool(page, "run_project"); await tool(page, "wait_project", { durationMs: 100 });
  const capture = await tool(page, "capture_stage"); expect(capture.image).toMatch(/^data:image\/jpeg;base64,/);
  const downloaded = page.waitForEvent("download"); await tool(page, "export_project", { filename: "full-tools" });
  const file = await downloaded; expect(file.suggestedFilename()).toBe("full-tools.sb3");
  const bytes = await readFile((await file.path())!);
  await page.getByLabel("Tải tệp cho AI").setInputFiles({ name: "roundtrip.sb3", mimeType: "application/zip", buffer: bytes });
  await expect(page.getByRole("status")).toContainText("Đã tải tệp");
  const files = await tool(page, "list_files");
  await tool(page, "import_file", { fileId: files.files[0].id });
  expect((await tool(page, "get_project")).extensions).toEqual(expect.arrayContaining(["pen", "music"]));
  expect(errors).toEqual([]);
});

test("variable/list/comment CRUD, block input preservation, safe rejection and file tools", async ({ page }) => {
  let { cat, stage } = await start(page);
  const variable = await tool(page, "create_variable", { targetId: stage.id, name: "v", value: 1 });
  await tool(page, "set_variable", { targetId: stage.id, variableId: variable.id, value: 3 });
  await tool(page, "rename_variable", { targetId: stage.id, variableId: variable.id, name: "renamed" });
  expect((await tool(page, "get_variables", { targetId: stage.id })).items.find((v: any) => v.id === variable.id)).toMatchObject({ name: "renamed", value: 3 });
  await tool(page, "delete_variable", { targetId: stage.id, variableId: variable.id });
  const list = await tool(page, "create_list", { targetId: cat.id, name: "items", items: [1, 2] });
  for (const change of [{ operation: "append", items: [3] }, { operation: "insert", index: 2, value: 9 }, { operation: "replace", index: 1, value: 7 }, { operation: "delete", index: 3 }]) await tool(page, "update_list", { targetId: cat.id, variableId: list.id, ...change });
  expect((await tool(page, "get_variables", { targetId: cat.id, variableId: list.id })).items).toEqual([7, 9, 3]);
  await tool(page, "set_monitor", { targetId: cat.id, variableId: list.id, visible: true });
  await tool(page, "set_monitor", { targetId: cat.id, variableId: list.id, visible: false });
  await tool(page, "update_list", { targetId: cat.id, variableId: list.id, operation: "clear" });
  expect((await tool(page, "assert_state", { targetId: cat.id, property: "listLength", variableId: list.id, expected: 0 })).passed).toBe(true);
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [[hat, { opcode: "control_repeat", inputs: { TIMES: 2, SUBSTACK: [number("motion_changexby", "DX", 1)] } }]] });
  const graph = await tool(page, "get_scripts", { targetId: cat.id });
  const repeat = Object.values(graph.blocks as Record<string, VmBlock>).find(b => b.opcode === "control_repeat")!;
  const childId = repeat.inputs.SUBSTACK.block!;
  const comment = await tool(page, "set_comment", { targetId: cat.id, blockId: childId, text: "keep me" });
  await tool(page, "update_block", { targetId: cat.id, blockId: repeat.id, inputs: { TIMES: 3 } });
  const after = await tool(page, "get_scripts", { targetId: cat.id });
  expect(after.blocks[repeat.id].inputs.SUBSTACK.block).toBe(childId);
  expect(after.blocks[childId].comment).toBe(comment.commentId);
  await tool(page, "set_comment", { targetId: cat.id, commentId: comment.commentId, text: "changed", blockId: null });
  expect((await tool(page, "get_comments", { targetId: cat.id })).items[0]).toMatchObject({ text: "changed", blockId: null });
  await tool(page, "delete_comment", { targetId: cat.id, commentId: comment.commentId });
  await tool(page, "delete_script", { targetId: cat.id, scriptId: graph.scripts[0] });
  await expect(tool(page, "load_extension", { extension: "https://evil.example/code.js" })).rejects.toThrow();
  await page.getByLabel("Tải tệp cho AI").setInputFiles({ name: "red.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>') });
  await expect(page.getByRole("status")).toContainText("Đã tải tệp");
  const file = (await tool(page, "list_files")).files[0];
  await tool(page, "import_file", { fileId: file.id, targetId: cat.id });
  expect((await tool(page, "get_assets", { targetId: cat.id })).items.some((asset: any) => asset.name === "red")).toBe(true);
  const downloaded = page.waitForEvent("download"); await tool(page, "export_sprite", { targetId: cat.id });
  const spriteFile = await downloaded;
  const bytes = await readFile((await spriteFile.path())!);
  await page.getByLabel("Tải tệp cho AI").setInputFiles({ name: "cat.sprite3", mimeType: "application/zip", buffer: bytes });
  await expect(page.getByRole("button", { name: "Tệp cho AI (2)" })).toBeVisible();
  const second = (await tool(page, "list_files")).files[1];
  await tool(page, "import_file", { fileId: second.id });
  expect((await tool(page, "get_project")).total).toBe(3);
  const snapshots = await tool(page, "list_snapshots"); expect(snapshots.snapshots).toEqual([]);
  // Rejected SVG import must restore the project; fetch fresh IDs after rollback.
  await page.getByLabel("Tải tệp cho AI").setInputFiles({ name: "unsafe.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
  await expect(page.getByRole("button", { name: "Tệp cho AI (3)" })).toBeVisible();
  const third = (await tool(page, "list_files")).files[2];
  await expect(tool(page, "import_file", { fileId: third.id, targetId: cat.id })).rejects.toThrow(/không an toàn/);
  ({ cat, stage } = await targets(page));
  expect((await tool(page, "get_project")).total).toBe(3);
  expect((await tool(page, "get_assets", { targetId: cat.id })).items.some((asset: any) => asset.name === "red")).toBe(true);
});

test("all catalog opcodes render and serialize with safe extensions and procedure context", async ({ page }) => {
  const { CATALOG } = await import("../../shared/catalog");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const { cat, stage } = await start(page);
  await tool(page, "load_extension", { extension: "pen" }); await tool(page, "load_extension", { extension: "music" });
  await tool(page, "create_variable", { targetId: stage.id, name: "v", value: 0 });
  await tool(page, "create_list", { targetId: stage.id, name: "l", items: [] });
  await tool(page, "create_broadcast", { name: "m" });
  const signature = await tool(page, "define_procedure", { targetId: cat.id, name: "Test", parameters: [{ name: "n", type: "string_number" }, { name: "yes", type: "boolean" }], body: [
    { opcode: "control_if", inputs: { CONDITION: { opcode: "argument_reporter_boolean", fields: { VALUE: "yes" } }, SUBSTACK: [{ opcode: "motion_movesteps", inputs: { STEPS: { opcode: "argument_reporter_string_number", fields: { VALUE: "n" } } } }] } },
  ] });
  const condition = { opcode: "operator_equals", inputs: { OPERAND1: 1, OPERAND2: 1 } };
  const scripts = [];
  for (const [opcode, spec] of Object.entries(CATALOG)) {
    if (opcode.startsWith("argument_reporter_")) continue;
    const fields = Object.fromEntries(Object.entries(spec.fields ?? {}).map(([key, values]) => [key, values?.[0] ?? (key === "VARIABLE" ? "v" : key === "LIST" ? "l" : key === "BROADCAST_OPTION" ? "m" : key === "PROCEDURE" ? signature.proccode : "name")]));
    const inputs = Object.fromEntries(Object.entries(spec.inputs ?? {}).map(([key, type]) => [key, typeof type === "object" ? type.variableType ? "m" : type.values?.[0] ?? (key === "COSTUME" ? cat.costumes[0] : key === "BACKDROP" ? stage.costumes[0] : key === "TOUCHINGOBJECTMENU" ? "_edge_" : "1") : type === "stack" ? [] : type === "boolean" ? condition : type === "color" ? "#123456" : type === "number" ? 1 : "hello"]));
    const node = { opcode, fields, inputs };
    if (opcode === "procedures_call") node.inputs = { n: 2, yes: condition };
    const script = spec.kind === "hat" ? [node] : spec.kind === "reporter" ? [hat, { opcode: "looks_switchbackdropto", inputs: { BACKDROP: node } }] : spec.kind === "boolean" ? [hat, { opcode: "control_if", inputs: { CONDITION: node, SUBSTACK: [] } }] : [hat, node];
    if (spec.stageOnly) await tool(page, "add_scripts", { targetId: stage.id, scripts: [script] }); else scripts.push(script);
  }
  for (let i = 0; i < scripts.length; i += 20) await tool(page, "add_scripts", { targetId: cat.id, scripts: scripts.slice(i, i + 20) });
  const opcodeCounts = async () => {
    const counts: Record<string, number> = {};
    for (const t of (await tool(page, "get_project")).targets) {
      let offset = 0;
      do { const g = await tool(page, "get_scripts", { targetId: t.id, offset }); for (const b of Object.values(g.blocks as Record<string, VmBlock>)) counts[b.opcode] = (counts[b.opcode] ?? 0) + 1; offset = g.nextOffset; } while (offset !== null);
    }
    return counts;
  };
  const beforeOpcodes = await opcodeCounts();
  const before = (await tool(page, "get_project")).targets.map((t: any) => ({ name: t.name, blockCount: t.blockCount, scriptCount: t.scriptCount }));
  const snapshot = await tool(page, "save_snapshot", { name: "all opcodes" });
  await tool(page, "restore_snapshot", { snapshotId: snapshot.snapshotId });
  const after = await tool(page, "get_project");
  const afterOpcodes = await opcodeCounts();
  expect(afterOpcodes).toEqual(beforeOpcodes);
  expect(after.targets.map((t: any) => ({ name: t.name, blockCount: t.blockCount, scriptCount: t.scriptCount }))).toEqual(before);
  const found = new Set();
  for (const target of after.targets) {
    let offset = 0;
    do { const graph = await tool(page, "get_scripts", { targetId: target.id, offset }); Object.values(graph.blocks as Record<string, VmBlock>).forEach(b => found.add(b.opcode)); offset = graph.nextOffset; } while (offset !== null);
  }
  expect(Object.keys(CATALOG).filter(op => !found.has(op))).toEqual([]);
  expect(errors).toEqual([]);
});

test("agent UI confirms destructive tools, displays captures and forwards vision safely", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("scratch_vibe_ai_settings", JSON.stringify({ baseUrl: "https://mock-provider.example/v1", model: "vision-test" }));
    sessionStorage.setItem("scratch_vibe_api_key", "mock-key");
  });
  let step = 0;
  await page.route("**/api/agent", async route => {
    const input = route.request().postDataJSON();
    const cat = input.project.targets.find((t: any) => !t.isStage);
    if (step++ === 0) return route.fulfill({ json: { content: null, tool_calls: [{ id: "capture", type: "function", function: { name: "capture_stage", arguments: "{}" } }] } });
    if (step === 2) {
      expect(input.messages.at(-1).content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
      expect(input.messages.find((m: any) => m.role === "tool").content).not.toContain("base64");
      return route.fulfill({ json: { content: null, tool_calls: [{ id: "delete", type: "function", function: { name: "delete_sprite", arguments: JSON.stringify({ targetId: cat.id }) } }] } });
    }
    expect(JSON.parse(input.messages.at(-1).content).error).toContain("chưa cho phép");
    return route.fulfill({ json: { content: "Đã chụp sân khấu. Giữ nguyên sprite vì bạn từ chối xóa." } });
  });
  await start(page);
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("Xóa sprite"); await dialog.dismiss(); });
  await page.getByLabel("Mô tả yêu cầu lập trình Scratch").fill("Chụp sân khấu và đề nghị xóa sprite.");
  await page.getByRole("button", { name: "Tạo với AI" }).click();
  await expect(page.getByText("Đã chụp sân khấu. Giữ nguyên sprite vì bạn từ chối xóa.", { exact: true })).toBeVisible();
  await page.locator(".tool-log summary").filter({ hasText: "Chụp sân khấu" }).click();
  await expect(page.getByAltText("Ảnh sân khấu do tool chụp")).toBeVisible();
  expect((await tool(page, "get_project")).total).toBe(2);
  await page.screenshot({ path: "test-results/full-tool-calling-ui.png", fullPage: true });
});

test("test inputs execute mouse/key hats and answer an actual ask block then release input", async ({ page }) => {
  const { cat, stage } = await start(page);
  const clicked = await tool(page, "create_variable", { targetId: stage.id, name: "clicked", value: 0 });
  const answer = await tool(page, "create_variable", { targetId: stage.id, name: "answer", value: "" });
  await tool(page, "add_scripts", { targetId: stage.id, scripts: [[{ opcode: "event_whenstageclicked" }, { opcode: "data_setvariableto", fields: { VARIABLE: clicked.id }, inputs: { VALUE: 1 } }]] });
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [
    [hat, { opcode: "sensing_askandwait", inputs: { QUESTION: "Tên của bạn?" } }, { opcode: "data_setvariableto", fields: { VARIABLE: answer.id }, inputs: { VALUE: { opcode: "sensing_answer" } } }],
    [{ opcode: "event_whenkeypressed", fields: { KEY_OPTION: "right arrow" } }, number("motion_setx", "X", 77)],
  ] });
  await tool(page, "test_input", { device: "mouse", x: 220, y: 150, durationMs: 100 });
  await expect.poll(async () => (await tool(page, "assert_state", { targetId: stage.id, property: "variable", variableId: clicked.id, expected: 1 })).passed).toBe(true);
  expect((await tool(page, "get_runtime")).mouse).toMatchObject({ x: 220, y: 150, isDown: false });
  await tool(page, "create_costume", { targetId: cat.id, name: "Click target", width: 40, height: 40, shapes: [{ type: "rect", x: 0, y: 0, width: 40, height: 40, fill: "#ff0000" }] });
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [[{ opcode: "event_whenthisspriteclicked" }, { opcode: "data_setvariableto", fields: { VARIABLE: clicked.id }, inputs: { VALUE: 2 } }]] });
  await tool(page, "test_input", { device: "mouse", x: 0, y: 0, durationMs: 100 });
  expect((await tool(page, "assert_state", { targetId: stage.id, property: "variable", variableId: clicked.id, expected: 2 })).passed).toBe(true);
  await tool(page, "test_input", { device: "keyboard", key: "ArrowRight", durationMs: 100 });
  expect((await tool(page, "assert_state", { targetId: cat.id, property: "x", expected: 77 })).passed).toBe(true);
  expect((await tool(page, "get_runtime")).pressedKeys).toEqual([]);
  await tool(page, "run_project");
  await tool(page, "wait_project", { durationMs: 200 });
  await tool(page, "test_input", { device: "answer", text: "Scratch Vibe" });
  await expect.poll(async () => (await tool(page, "assert_state", { targetId: stage.id, property: "variable", variableId: answer.id, expected: "Scratch Vibe" })).passed).toBe(true);
  await tool(page, "stop_project");
  expect((await tool(page, "get_runtime")).running).toBe(false);
});

test("get_costume_image renders real costume and backdrop pixels for vision", async ({ page }) => {
  const { cat, stage } = await start(page);
  const current = await tool(page, "get_costume_image", { targetId: cat.id });
  expect(current).toMatchObject({ index: 0, isCurrent: true, dataFormat: "svg" });
  expect(current.image).toMatch(/^data:image\/jpeg;base64,/);
  expect(Math.max(current.width, current.height)).toBe(360);
  // A known red vector costume must come back red, proving actual asset bytes were rendered.
  await tool(page, "create_costume", { targetId: cat.id, name: "red box", width: 40, height: 40, shapes: [{ type: "rect", x: 0, y: 0, width: 40, height: 40, fill: "#ff0000" }] });
  const assets = await tool(page, "get_assets", { targetId: cat.id });
  const red = await tool(page, "get_costume_image", { targetId: cat.id, index: assets.items.findIndex((a: any) => a.name === "red box") });
  expect(red.stageSize).toEqual({ width: 40, height: 40 });
  const pixel = await page.evaluate(async src => {
    const img = new Image(); img.src = src; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
    const context = canvas.getContext("2d")!; context.drawImage(img, 0, 0);
    return [...context.getImageData(img.width / 2, img.height / 2, 1, 1).data];
  }, red.image);
  expect(pixel[0]).toBeGreaterThan(200); expect(pixel[1]).toBeLessThan(60); expect(pixel[2]).toBeLessThan(60);
  const backdrop = await tool(page, "get_costume_image", { targetId: stage.id });
  expect(backdrop.image).toMatch(/^data:image\/jpeg;base64,/);
  await expect(tool(page, "get_costume_image", { targetId: cat.id, index: 99 })).rejects.toThrow(/index/);
});
