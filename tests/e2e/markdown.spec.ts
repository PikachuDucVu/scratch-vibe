import { test, expect } from "@playwright/test";
import { routeAgent } from "./provider";

test("chat formats Vietnamese Scratch instructions with bold text and bullet lists", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("scratch_vibe_ai_settings", JSON.stringify({ baseUrl: "https://mock-provider.example/v1", model: "test-provider" }));
    sessionStorage.setItem("scratch_vibe_api_key", "test-browser-key");
  });
  await routeAgent(page, route => route.fulfill({ json: {
    content: "Đã thêm điều khiển cho mèo:\n- Bấm **cờ xanh**: mèo về giữa sân khấu tại **(0, 0)**.\n- Giữ **các phím mũi tên**: mèo di chuyển theo hướng tương ứng.\n\nBấm cờ xanh để bắt đầu chơi nhé!",
  } }));
  await page.goto("/");
  await expect(page.getByText("Editor sẵn sàng", { exact: true })).toBeVisible();
  await page.getByLabel("Mô tả yêu cầu lập trình Scratch").fill("Thêm điều khiển cho mèo.");
  await page.getByRole("button", { name: "Tạo với AI" }).click();
  const reply = page.locator(".message.assistant .markdown-body");
  await expect(reply.locator("ul > li")).toHaveCount(2);
  await expect(reply.locator("strong")).toHaveText(["cờ xanh", "(0, 0)", "các phím mũi tên"]);
  await expect(reply).not.toContainText("**");
  await expect(reply.locator("p").last()).toHaveText("Bấm cờ xanh để bắt đầu chơi nhé!");
});
