import { defineConfig } from '@playwright/test'

// 一致性套件独立 Playwright 配置（v2.5，PLAN-v2.5-测试.md Task 4）。
// 根 playwright.config.ts 的 testIgnore 会把本套件一起过滤，故 conformance 经独立配置启动
// （run-conformance.mjs：npx playwright test --config tests/e2e/conformance/playwright.config.ts），与全量 e2e 隔离。
// timeout / workers / reporter 与根配置保持一致。
export default defineConfig({
  testDir: '.',
  timeout: 90000,
  workers: 1,
  reporter: [['list']],
})
