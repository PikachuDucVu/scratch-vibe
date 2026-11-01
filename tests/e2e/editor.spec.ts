import { test, expect, type Page } from "@playwright/test";
import { routeAgent } from "./provider";
import { readFile } from "node:fs/promises";

async function rpc(page: Page, type: string, payload: Record<string, unknown> = {}) {
  return page.evaluate(async ({ type, payload }) => {
    const frame = document.querySelector<HTMLIFrameElement>('.editor-host iframe')!;
    const requestId = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", handler); reject(new Error("RPC timeout")); }, 90000);
      function handler(event: MessageEvent) {
        if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener("message", handler);
        if (event.data.type === "scratch:error") reject(new Error(event.data.message));
        else resolve(event.data.result);
      }
      window.addEventListener("message", handler);
      frame.contentWindow!.postMessage({ type, requestId, ...payload }, location.origin);
    });
  }, { type, payload });
}
async function project(page: Page) { return await rpc(page, "scratch:tool", { name: "get_project", args: {} }) as unknown as { targets: { id: string; isStage: boolean; scriptCount: number; x: number; y: number }[] }; }

test("real Scratch VM: demo, nested blocks, run, export/import and undo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Editor sẵn sàng", { exact: true })).toBeVisible();
  const initial = await project(page);
  expect(initial.targets).toHaveLength(2);
  expect(initial.targets.find(target => !target.isStage)?.scriptCount).toBe(0);
  await page.getByRole("button", { name: "Thêm & chạy demo không cần API key" }).click();
  await expect(page.getByText("Demo đã thêm block", { exact: false })).toBeVisible();
  const after = await project(page);
  const cat = after.targets.find(target => !target.isStage)!;
  expect(cat.scriptCount).toBe(1);
  const graph = await rpc(page, "scratch:tool", { name: "get_scripts", args: { targetId: cat.id } });
  const blocks = Object.values(graph.blocks as Record<string, { opcode: string; inputs: Record<string, unknown> }>);
  expect(blocks.some(block => block.opcode === "control_repeat")).toBe(true);
  expect(blocks.some(block => block.opcode === "motion_movesteps")).toBe(true);
  const frame = page.frameLocator('.editor-host iframe');
  await expect(frame.locator('.blocklyWorkspace .blocklyBlockCanvas').first()).toBeVisible();
  await expect(frame.locator('.blocklyWorkspace .blocklyBlockCanvas').first()).toContainText("Xin chào Scratch Vibe!");
  await rpc(page, "scratch:tool", { name: "stop_project", args: {} });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Lưu .sb3" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("scratch-vibe.sb3");
  const path = await download.path();
  expect(path).toBeTruthy();
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect(page.getByText("Đã khôi phục project", { exact: false })).toBeVisible();
  expect((await project(page)).targets.find(target => !target.isStage)?.scriptCount).toBe(0);
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("Mở project Scratch").setInputFiles({ name: "roundtrip.sb3", mimeType: "application/x.scratch.sb3", buffer: await readFile(path!) });
  await expect(page.getByText("Đã mở", { exact: false })).toBeVisible();
  expect((await project(page)).targets.find(target => !target.isStage)?.scriptCount).toBe(1);
  expect(errors).toEqual([]);
});

test("mock provider -> real agent loop -> real VM blocks; rollback invalid script", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("scratch_vibe_ai_settings", JSON.stringify({ baseUrl: "https://mock-provider.example/v1", model: "test-provider" }));
    sessionStorage.setItem("scratch_vibe_api_key", "test-browser-key");
  });
  let step = 0;
  await routeAgent(page, async route => {
    const input = route.request().postDataJSON();
    const target = input.project.targets.find((target: { isStage: boolean }) => !target.isStage);
    if (step++ === 0) return route.fulfill({ json: { content: null, tool_calls: [{ id: "tool-add", type: "function", function: { name: "add_scripts", arguments: JSON.stringify({ targetId: target.id, scripts: [[{ opcode: "event_whenflagclicked" }, { opcode: "looks_say", inputs: { MESSAGE: "Agent thật sự đã tạo block" } }]] }) } }] } });
    const result = input.messages.find((message: { role: string }) => message.role === "tool");
    expect(JSON.parse(result.content).scriptCount).toBe(1);
    return route.fulfill({ json: { content: "Đã thêm chương trình chào bằng tool call." } });
  });
  await page.goto("/");
  await expect(page.getByText("Editor sẵn sàng", { exact: true })).toBeVisible();
  await page.getByLabel("Mô tả yêu cầu lập trình Scratch").fill("Thêm chương trình chào.");
  await page.getByRole("button", { name: "Tạo với AI" }).click();
  await expect(page.getByText("Đã thêm chương trình chào bằng tool call.", { exact: true })).toBeVisible();
  const cat = (await project(page)).targets.find(target => !target.isStage)!;
  expect(cat.scriptCount).toBe(1);
  await expect(rpc(page, "scratch:tool", { name: "add_scripts", args: { targetId: cat.id, scripts: [[{ opcode: "event_whenflagclicked" }, { opcode: "eval" }]] } })).rejects.toThrow(/Opcode/);
  const restored = (await project(page)).targets.find(target => !target.isStage)!;
  expect(restored.scriptCount).toBe(1);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect(page.getByText("Đã khôi phục project", { exact: false })).toBeVisible();
  expect((await project(page)).targets.find(target => !target.isStage)?.scriptCount).toBe(0);
});
