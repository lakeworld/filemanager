import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // CI（软件渲染首次启动较慢）放宽到 90s；本地不受影响
  timeout: 90000,
  workers: 1,
  // CI runner 资源/时序抖动（app 进程被环境性终止 → Target closed 型随机死亡，
  // 2026-08-19 发布轮两轮失败位置漂移取证）：允许 1 次重试，重试起新 app 实例环境重置；
  // 本地不重试，失败即失败，避免掩盖真实回归
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // 一致性与内存 soak 均独立运行，不混入默认全量 e2e：
  // 防 workers:1 串行多跑 + 与 plugins.spec 重复侧载 hello（PLAN-v2.5-测试 Task 4）。
  // preview-lifecycle-crash-diag 为 v2.5.7 线程B 阶段1 取证管道，独立配置跑（见 PLAN，验收后清理）
  testIgnore: ['**/conformance/**', '**/memory-soak.spec.ts', '**/preview-lifecycle-crash-diag.spec.ts'],
})
