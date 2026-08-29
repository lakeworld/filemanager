import { defineConfig } from '@playwright/test'

/**
 * preview-lifecycle 崩溃取证专用配置（v2.5.7 线程B 阶段1）：
 * - 默认全量 e2e 通过 playwright.config.ts 的 testIgnore 排除诊断 spec（不污染 161 基线）；
 * - 本配置仅收集 preview-lifecycle-crash-diag.spec.ts，禁用 trace/video/screenshot（取证产物
 *   由 spec 自身落盘 crash-diag-results/，不额外消耗被测进程资源）；不设重试（诊断要原始失败）。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30 * 60 * 1000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  testMatch: ['**/preview-lifecycle-crash-diag.spec.ts'],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
})
