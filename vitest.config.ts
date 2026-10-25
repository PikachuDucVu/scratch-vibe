import { defineConfig } from "vitest/config";
// CPU-heavy tests (10k-block graphs, schema compilation, workerd startup) need headroom on busy machines and CI.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], environment: "node", restoreMocks: true, testTimeout: 30000, hookTimeout: 60000 } });
