import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("E2E_PORT không hợp lệ.");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120000,
  expect: { timeout: 45000 },
  workers: 1,
  use: { baseURL, viewport: { width: 1500, height: 950 }, trace: "retain-on-failure", screenshot: "only-on-failure", launchOptions: { args: ["--enable-unsafe-swiftshader"] } },
  webServer: { command: `PORT=${port} npm start`, url: `${baseURL}/api/config`, reuseExistingServer: false, timeout: 30000 },
});
