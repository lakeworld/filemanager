import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // CI（软件渲染首次启动较慢）放宽到 90s；本地不受影响
  timeout: 90000,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // 一致性与内存 soak 均独立运行，不混入默认全量 e2e：
  // 防 workers:1 串行多跑 + 与 plugins.spec 重复侧载 hello（PLAN-v2.5-测试 Task 4）。
  testIgnore: ['**/conformance/**', '**/memory-soak.spec.ts'],
})
