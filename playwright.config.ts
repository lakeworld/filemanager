import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // CI（软件渲染首次启动较慢）放宽到 90s；本地不受影响
  timeout: 90000,
  workers: 1,
  reporter: [['list']],
})
