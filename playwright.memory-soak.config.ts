import { defineConfig } from '@playwright/test'

/**
 * T8 memory-soak 独立配置（v2.5.3）：
 * - 默认全量 e2e 通过 playwright.config.ts 的 testIgnore 排除内存 soak（避免 trace/video 污染被测内存）；
 * - 本配置仅收集 memory-soak.spec.ts，并禁用 trace/video/screenshot——诊断产物不占用被测进程内存；
 * - 单轮 soak 耗时较长，超时放宽到 30 分钟/测试。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30 * 60 * 1000,
  workers: 1,
  reporter: [['list']],
  testMatch: ['**/memory-soak.spec.ts'],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
})