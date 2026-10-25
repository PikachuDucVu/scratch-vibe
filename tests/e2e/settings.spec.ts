import { test, expect } from "@playwright/test";

test("configure URL/key on the web, select a model below chat, persist and reset", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/models", async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().url()).not.toContain("web-test-key");
    expect(route.request().postDataJSON()).toMatchObject({ baseUrl: "https://custom.example/v1", apiKey: "web-test-key" });
    return route.fulfill({ json: { models: ["custom-small", "custom-large"] } });
  });
  let chatRequests = 0;
  await page.route("**/api/agent", async route => {
    expect(route.request().postDataJSON()).toMatchObject({
      baseUrl: "https://custom.example/v1", apiKey: "web-test-key", model: "custom-large", reasoningEffort: "high",
    });
    chatRequests++;
    return route.fulfill({ json: { content: "Đã dùng đúng cấu hình web." } });
  });
  await page.goto("/");
  await expect(page.getByText("Editor sẵn sàng", { exact: true })).toBeVisible();
  await page.getByLabel("Mô tả yêu cầu lập trình Scratch").fill("Kiểm tra cấu hình.");
  await expect(page.getByRole("button", { name: "Tạo với AI" })).toBeDisabled();
  await page.getByRole("button", { name: "Cài đặt AI", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Custom URL (API Base URL)", { exact: true }).fill("https://custom.example/v1///");
  await dialog.getByLabel("API key", { exact: true }).fill("web-test-key");
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Hiện API key", exact: true }).click();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
  await dialog.getByRole("button", { name: "Ẩn API key", exact: true }).click();
  await dialog.getByRole("button", { name: "Tải danh sách model", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Đã tải thành công 2 model.");
  await dialog.getByLabel("Level Thinking (Mức độ suy nghĩ)", { exact: true }).selectOption("high");
  await dialog.getByRole("button", { name: "Lưu & Áp dụng", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const picker = page.locator("#chat-model-select");
  await expect(picker).toHaveValue("custom-small");
  const bounds = await picker.boundingBox();
  const inputBounds = await page.locator("#prompt").boundingBox();
  expect(bounds!.y).toBeGreaterThan(inputBounds!.y + inputBounds!.height);
  await picker.selectOption("custom-large");
  expect(await page.evaluate(() => localStorage.getItem("scratch_vibe_api_key"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("scratch_vibe_api_key"))).toBe("web-test-key");
  await page.getByRole("button", { name: "Tạo với AI" }).click();
  await expect(page.getByText("Đã dùng đúng cấu hình web.", { exact: true })).toBeVisible();
  expect(chatRequests).toBe(1);
  await page.screenshot({ path: "test-results/web-ai-settings.png", fullPage: true });
  await page.reload();
  await expect(picker).toHaveValue("custom-large");
  await page.getByRole("button", { name: "Cài đặt AI", exact: true }).first().click();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("web-test-key");
  await dialog.getByLabel("Ghi nhớ API key trên trình duyệt này", { exact: true }).check();
  await dialog.getByRole("button", { name: "Lưu & Áp dụng", exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem("scratch_vibe_api_key"))).toBe("web-test-key");
  expect(await page.evaluate(() => sessionStorage.getItem("scratch_vibe_api_key"))).toBeNull();
  await page.getByRole("button", { name: "Cài đặt AI", exact: true }).first().click();
  await page.screenshot({ path: "test-results/ai-settings-dialog.png", fullPage: true });
  await dialog.getByRole("button", { name: "Xóa cấu hình", exact: true }).click();
  await expect(picker).toHaveValue("gpt-4.1");
  expect(await page.evaluate(() => localStorage.getItem("scratch_vibe_api_key"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("scratch_vibe_api_key"))).toBeNull();
  await expect(picker.locator("option")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("invalid settings are rejected; closing a draft never applies it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Cài đặt AI", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Lưu & Áp dụng" }).click();
  await expect(dialog.getByRole("alert")).toContainText("API key");
  await dialog.getByLabel("Custom URL (API Base URL)", { exact: true }).fill("http://untrusted.example/v1");
  await dialog.getByLabel("API key", { exact: true }).fill("draft-key");
  await dialog.getByRole("button", { name: "Lưu & Áp dụng" }).click();
  await expect(dialog.getByRole("alert")).toContainText("HTTPS");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("scratch_vibe_api_key"))).toBeNull();
  await page.getByRole("button", { name: "Cài đặt AI", exact: true }).first().click();
  await expect(dialog.getByLabel("API key", { exact: true })).toHaveValue("");
});
