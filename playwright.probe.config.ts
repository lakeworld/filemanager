import { defineConfig } from '@playwright/test'

/**
 * probe-* 一次性度量/走查探针专用配置（2026-08-31 发布轮补）：
 * 主配置 playwright.config.ts 用 testIgnore 排除 probe-*.spec.ts（探针须人工判读，不入默认套件），
 * 但 testIgnore 在按文件名直跑时同样生效 → 探针无法执行。本配置只收集 probe-*，
 * 并关掉 trace/video/screenshot（与 memory-soak 配置同理：诊断产物不得占用被测进程内存）。
 * 用法：npx playwright test --config=playwright.probe.config.ts [探针文件名]
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 25 * 60 * 1000,
  workers: 1,
  reporter: [['list']],
  testMatch: ['**/probe-*.spec.ts'],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
})
