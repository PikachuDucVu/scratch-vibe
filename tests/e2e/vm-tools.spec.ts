import { test, expect, type Page } from "@playwright/test";

async function tool(page: Page, name: string, args: unknown): Promise<Record<string, unknown>> {
  return page.evaluate(async ({ name, args }) => {
    const frame = document.querySelector<HTMLIFrameElement>('.editor-host iframe')!;
    const id = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Timeout")); }, 60000);
      function receive(event: MessageEvent) {
        if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.requestId !== id) return;
        clearTimeout(timer); window.removeEventListener("message", receive);
        if (event.data.type === "scratch:error") reject(new Error(event.data.message));
        else resolve(event.data.result);
      }
      window.addEventListener("message", receive);
      frame.contentWindow!.postMessage({ type: "scratch:tool", requestId: id, name, args }, location.origin);
    });
  }, { name, args });
}

test("real VM supports global variables, reporter expressions, sprite properties and duplication", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Editor sẵn sàng", { exact: true })).toBeVisible();
  const initial = await tool(page, "get_project", {});
  const targets = initial.targets as { id: string; isStage: boolean }[];
  const stage = targets.find(target => target.isStage)!;
  const cat = targets.find(target => !target.isStage)!;
  const variable = await tool(page, "create_variable", { targetId: stage.id, name: "Điểm", value: 0 });
  expect(variable.name).toBe("Điểm");
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [[
    { opcode: "event_whenflagclicked" },
    { opcode: "data_setvariableto", fields: { VARIABLE: "Điểm" }, inputs: { VALUE: 0 } },
    { opcode: "control_repeat", inputs: { TIMES: 3, SUBSTACK: [
      { opcode: "data_changevariableby", fields: { VARIABLE: "Điểm" }, inputs: { VALUE: { opcode: "operator_add", inputs: { NUM1: 1, NUM2: 1 } } } },
    ] } },
    { opcode: "control_if", inputs: { CONDITION: { opcode: "operator_gt", inputs: { OPERAND1: { opcode: "data_variable", fields: { VARIABLE: "Điểm" } }, OPERAND2: 5 } }, SUBSTACK: [
      { opcode: "motion_setx", inputs: { X: 123 } },
    ] } },
  ]] });
  await tool(page, "run_project", {});
  await expect.poll(async () => {
    const live = await tool(page, "get_project", {});
    return (live.targets as { id: string; x: number }[]).find(target => target.id === cat.id)?.x;
  }).toBe(123);
  const live = await tool(page, "get_project", {});
  expect((live.targets as { id: string; variables: { name: string; value: number }[] }[]).find(target => target.id === stage.id)?.variables.find(variable => variable.name === "Điểm")?.value).toBe(6);
  const changed = await tool(page, "set_sprite", { targetId: cat.id, x: -50, y: 40, direction: 45, size: 75, visible: false, name: "Mèo thử nghiệm" });
  expect(changed).toMatchObject({ x: -50, y: 40, direction: 45, size: 75, visible: false, name: "Mèo thử nghiệm" });
  const copy = await tool(page, "duplicate_sprite", { targetId: cat.id, name: "Mèo thứ hai" });
  expect(copy.id).not.toBe(cat.id);
  expect(copy).toMatchObject({ name: "Mèo thứ hai", scriptCount: 1 });
  await tool(page, "replace_scripts", { targetId: copy.id, scripts: [[{ opcode: "event_whenflagclicked" }, { opcode: "looks_show" }]] });
  const scripts = await tool(page, "get_scripts", { targetId: copy.id });
  expect(Object.keys(scripts.blocks as object)).toHaveLength(2);
});
