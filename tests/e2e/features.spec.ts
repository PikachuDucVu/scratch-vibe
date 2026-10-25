import { test, expect, type Page, type Route } from "@playwright/test";

async function tool(page: Page, name: string, args: unknown = {}): Promise<any> {
  return page.evaluate(async ({ name, args }) => {
    const frame = document.querySelector<HTMLIFrameElement>(".editor-host iframe")!, requestId = crypto.randomUUID();
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
  await page.goto("/");
  await expect(page.locator(".status.online")).toBeVisible();
  const project = await tool(page, "get_project");
  return { cat: project.targets.find((t: any) => !t.isStage), stage: project.targets.find((t: any) => t.isStage) };
}
// Reads the RGB of a pixel of a JPEG/PNG data URL in the page.
const pixel = (page: Page, src: string, fx: number, fy: number) => page.evaluate(async ({ src, fx, fy }) => {
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0);
  return [...ctx.getImageData(Math.floor(img.width * fx), Math.floor(img.height * fy), 1, 1).data].slice(0, 3);
}, { src, fx, fy });
async function configureAi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("scratch_vibe_ai_settings", JSON.stringify({ baseUrl: "https://provider.example/v1", model: "test-model", imageModel: "gpt-image-2", imageQuality: "low", models: [] }));
    localStorage.setItem("scratch_vibe_api_key", "e2e-key");
  });
}
const json = (route: Route, body: unknown) => route.fulfill({ json: body });

test("edit_costume flips/tints real pixels; sounds are synthesized and edited", async ({ page }) => {
  const { cat } = await start(page);
  await tool(page, "create_costume", { targetId: cat.id, name: "two", width: 40, height: 20, shapes: [
    { type: "rect", x: 0, y: 0, width: 20, height: 20, fill: "#ff0000" }, { type: "rect", x: 20, y: 0, width: 20, height: 20, fill: "#0000ff" },
  ] });
  let assets = await tool(page, "get_assets", { targetId: cat.id });
  const two = assets.items.findIndex((a: any) => a.name === "two");
  const flipped = await tool(page, "edit_costume", { targetId: cat.id, index: two, operations: [{ type: "flip", axis: "horizontal" }], name: "flipped" });
  expect(flipped).toMatchObject({ name: "flipped", replaced: false, size: { width: 40, height: 20 } });
  const image = (await tool(page, "get_costume_image", { targetId: cat.id, index: flipped.index })).image;
  const left = await pixel(page, image, 0.2, 0.5), right = await pixel(page, image, 0.8, 0.5);
  expect(left[2]).toBeGreaterThan(200); expect(left[0]).toBeLessThan(60); // blue moved left
  expect(right[0]).toBeGreaterThan(200); expect(right[2]).toBeLessThan(60);
  const gray = await tool(page, "edit_costume", { targetId: cat.id, index: two, operations: [{ type: "grayscale" }], name: "gray" });
  const g = await pixel(page, (await tool(page, "get_costume_image", { targetId: cat.id, index: gray.index })).image, 0.25, 0.5);
  expect(Math.max(...g) - Math.min(...g)).toBeLessThan(12);

  const coin = await tool(page, "create_sound", { targetId: cat.id, name: "xu", preset: "coin" });
  expect(coin.name).toBe("xu");
  const trimmed = await tool(page, "edit_sound", { targetId: cat.id, index: coin.index, operations: [{ type: "trim", startMs: 0, endMs: 100 }, { type: "reverse" }], name: "xu ngắn" });
  expect(trimmed.durationMs).toBeGreaterThanOrEqual(95);
  expect(trimmed.durationMs).toBeLessThanOrEqual(105);
  assets = await tool(page, "get_assets", { targetId: cat.id, kind: "sound" });
  expect(assets.items.map((a: any) => a.name)).toEqual(expect.arrayContaining(["xu", "xu ngắn"]));
});

test("record_run samples real motion over time and returns a contact sheet", async ({ page }) => {
  const { cat } = await start(page);
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [[
    { opcode: "event_whenflagclicked" }, { opcode: "motion_gotoxy", inputs: { X: -100, Y: 0 } },
    { opcode: "control_repeat", inputs: { TIMES: 10, SUBSTACK: [{ opcode: "motion_changexby", inputs: { DX: 10 } }, { opcode: "control_wait", inputs: { DURATION: 0.05 } }] } },
  ]] });
  const run = await tool(page, "record_run", { durationMs: 1500, frames: 3, greenFlag: true });
  expect(run.frames).toHaveLength(3);
  expect(run.image).toMatch(/^data:image\/jpeg;base64,/);
  const track = run.targets.find((t: any) => t.id === cat.id);
  // Sampling every 100 ms may miss the first position right after "go to".
  expect(track.maxX - track.minX).toBeGreaterThanOrEqual(70);
  expect(track.distance).toBeGreaterThanOrEqual(70);
  expect(track.end.x).toBe(0);
  expect(run.timeline.length).toBeLessThanOrEqual(13);
});

test("AI costume generation: provider image → background removed, cropped, added, preview sent to the model", async ({ page }) => {
  await configureAi(page);
  const { cat } = await start(page);
  // 80x40 white image with a 20x20 red square: cropping proves the white background was removed.
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 80; c.height = 40;
    const ctx = c.getContext("2d")!; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 80, 40); ctx.fillStyle = "#ff0000"; ctx.fillRect(30, 10, 20, 20);
    return c.toDataURL("image/png").split(",")[1];
  });
  let mediaRequest: any;
  await page.route("**/api/media/images/generations", async route => {
    mediaRequest = { headers: route.request().headers(), body: route.request().postDataJSON() };
    return json(route, { data: [{ b64_json: png }] });
  });
  let step = 0, sawPreview = false;
  await page.route("**/api/agent", async route => {
    const input = route.request().postDataJSON();
    if (step++ === 0) return json(route, { content: null, tool_calls: [{ id: "gen", type: "function", function: { name: "generate_costume", arguments: JSON.stringify({ targetId: cat.id, prompt: "hộp đỏ", name: "hộp đỏ", size: 50 }) } }] });
    sawPreview = input.messages.some((m: any) => Array.isArray(m.content) && m.content[1]?.image_url?.url?.startsWith("data:image/jpeg"));
    return json(route, { content: "Đã vẽ hộp đỏ." });
  });
  await page.getByLabel("Mô tả yêu cầu lập trình Scratch").fill("Vẽ một hộp đỏ.");
  await page.getByRole("button", { name: "Tạo với AI" }).click();
  await expect(page.getByText("Đã vẽ hộp đỏ.", { exact: true })).toBeVisible();
  expect(mediaRequest.headers["x-provider-url"]).toBe("https://provider.example/v1");
  expect(mediaRequest.headers["x-provider-key"]).toBe("e2e-key");
  expect(mediaRequest.body).toMatchObject({ model: "gpt-image-2", quality: "low", background: "transparent" });
  expect(mediaRequest.body.prompt).toContain("hộp đỏ");
  expect(sawPreview).toBe(true);
  const assets = await tool(page, "get_assets", { targetId: cat.id });
  const index = assets.items.findIndex((a: any) => a.name === "hộp đỏ");
  expect(index).toBeGreaterThanOrEqual(0);
  const view = await tool(page, "get_costume_image", { targetId: cat.id, index });
  expect(view.stageSize).toEqual({ width: 50, height: 50 });
  const center = await pixel(page, view.image, 0.5, 0.5);
  expect(center[0]).toBeGreaterThan(200); expect(center[1]).toBeLessThan(60);
  await expect(page.locator(".changes-card")).toContainText("costume");
});

test("per-step undo, change summary and plan mode", async ({ page }) => {
  await configureAi(page);
  const { cat } = await start(page);
  let step = 0;
  const bodies: any[] = [];
  await page.route("**/api/agent", async route => {
    const input = route.request().postDataJSON(); bodies.push(input);
    const add = (id: string) => ({ id, type: "function", function: { name: "add_scripts", arguments: JSON.stringify({ targetId: input.project.targets.find((t: any) => !t.isStage).id, scripts: [[{ opcode: "event_whenflagclicked" }, { opcode: "looks_say", inputs: { MESSAGE: id } }]] }) } });
    const n = step++;
    if (n === 0) return json(route, { content: null, tool_calls: [add("bước-1")] });
    if (n === 1) return json(route, { content: null, tool_calls: [add("bước-2")] });
    if (n === 2) return json(route, { content: "Đã thêm 2 script." });
    // Plan mode turn: tries to edit (must be blocked), then answers with a plan.
    if (n === 3) return json(route, { content: null, tool_calls: [add("không-được")] });
    if (n === 4) return json(route, { content: "Kế hoạch: 1. Thêm script chào." });
    return json(route, { content: "Đã thực hiện kế hoạch." });
  });
  await page.getByLabel("Mô tả yêu cầu lập trình Scratch").fill("Thêm hai script.");
  await page.getByRole("button", { name: "Tạo với AI" }).click();
  await expect(page.getByText("Đã thêm 2 script.", { exact: true })).toBeVisible();
  const count = async () => (await tool(page, "get_project")).targets.find((t: any) => !t.isStage).scriptCount;
  expect(await count()).toBe(2);
  // Each script: hat + say + the say block's text shadow = 3 blocks.
  await expect(page.locator(".changes-card")).toContainText("+6 block");
  const undo = page.getByRole("button", { name: /Hoàn tác/ });
  await expect(undo).toHaveText("↶ Hoàn tác (2)");
  await undo.click();
  await expect(page.getByText("Đã khôi phục project", { exact: false })).toBeVisible();
  expect(await count()).toBe(1);
  await undo.click();
  await expect(undo).toBeDisabled();
  expect(await count()).toBe(0);

  await page.locator("#mode-select").selectOption("plan");
  await page.getByLabel("Mô tả yêu cầu lập trình Scratch").fill("Lập kế hoạch thêm script chào.");
  await page.getByRole("button", { name: "Tạo với AI" }).click();
  await expect(page.getByText("Kế hoạch: 1. Thêm script chào.", { exact: true })).toBeVisible();
  expect(bodies[3].mode).toBe("plan");
  expect(await count()).toBe(0); // the blocked edit never ran
  await page.getByRole("button", { name: "▶ Thực hiện kế hoạch này" }).click();
  await expect(page.getByText("Đã thực hiện kế hoạch.", { exact: true })).toBeVisible();
  expect(bodies.at(-1).mode).toBeUndefined();
  // The undo note keeps the conversation instead of wiping it.
  expect(bodies.at(-1).messages.some((m: any) => typeof m.content === "string" && m.content.includes("hoàn tác"))).toBe(true);
  void cat;
});

test("autosave survives a reload; conversations are kept; image attachments reach the model", async ({ page }) => {
  await configureAi(page);
  await start(page);
  let agentBody: any;
  await page.route("**/api/agent", async route => { agentBody = route.request().postDataJSON(); return json(route, { content: "Đã xem ảnh của bạn." }); });
  await page.locator('input[type="file"][accept^="image/"]').setInputFiles({ name: "sketch.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64") });
  await expect(page.locator(".attachment img")).toHaveCount(1);
  await page.getByLabel("Mô tả yêu cầu lập trình Scratch").fill("Làm giống ảnh này");
  await page.getByRole("button", { name: "Tạo với AI" }).click();
  await expect(page.getByText("Đã xem ảnh của bạn.", { exact: true })).toBeVisible();
  const promptMessage = agentBody.messages.at(-1);
  expect(promptMessage.content[0]).toEqual({ type: "text", text: "Làm giống ảnh này" });
  expect(promptMessage.content[1].image_url).toMatchObject({ detail: "high" });
  expect(promptMessage.content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);

  await tool(page, "add_scripts", { targetId: (await tool(page, "get_project")).targets.find((t: any) => !t.isStage).id, scripts: [[{ opcode: "event_whenflagclicked" }, { opcode: "looks_show" }]] });
  await page.waitForTimeout(4500); // change event (1 s throttle) + 2.5 s autosave debounce
  await page.reload();
  await expect(page.locator(".status.online")).toBeVisible();
  await expect(page.getByText("Đã xem ảnh của bạn.", { exact: true })).toBeVisible(); // conversation restored
  await page.getByRole("button", { name: "Khôi phục", exact: true }).click();
  await expect(page.getByText("Đã khôi phục bản tự lưu.", { exact: true })).toBeVisible();
  expect((await tool(page, "get_project")).targets.find((t: any) => !t.isStage).scriptCount).toBe(1);
  await page.getByRole("button", { name: "Lịch sử" }).click();
  await expect(page.locator(".history-item")).toHaveCount(1);
  await expect(page.locator(".history-item")).toContainText("Làm giống ảnh này");
});

test("English UI switch persists and the editor gets the locale", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.getByText("Editor ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save .sb3" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Editor ready", { exact: true })).toBeVisible();
  await expect(page.locator(".editor-host iframe")).toHaveAttribute("src", /locale=en/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("share link: upload the project and open it from ?share=", async ({ page }) => {
  await page.route("**/api/config", route => json(route, { configured: false, model: "gpt-4.1", share: true }));
  let shared: Buffer | undefined;
  const id = "AbCdEfGhIjKlMnOpQrStUv";
  await page.route("**/api/share", async route => {
    shared = route.request().postDataBuffer() ?? undefined;
    return json(route, { id, url: `http://127.0.0.1/?share=${id}`, expiresInDays: 30 });
  });
  await page.route(`**/api/share/${id}`, route => route.fulfill({ body: shared!, contentType: "application/x.scratch.sb3" }));
  const { cat } = await start(page);
  await tool(page, "add_scripts", { targetId: cat.id, scripts: [[{ opcode: "event_whenflagclicked" }, { opcode: "looks_hide" }]] });
  await page.getByRole("button", { name: "Chia sẻ" }).click();
  await expect(page.locator(".share-link input")).toHaveValue(`http://127.0.0.1/?share=${id}`);
  expect(shared!.subarray(0, 2).toString()).toBe("PK");
  await page.goto(`/?share=${id}`);
  await expect(page.getByText("Đã mở project được chia sẻ.", { exact: true })).toBeVisible();
  expect((await tool(page, "get_project")).targets.find((t: any) => !t.isStage).scriptCount).toBe(1);
  expect(page.url()).not.toContain("share=");
});
