import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/bench/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    // v2.5.x 卫生批：单测临时目录统一兜底清理（setup = 每测试文件收尾；globalSetup = 终局补扫 + 清清单）
    // 口径与理由见 tests/unit/setup/tmpTracker.ts 头注释。新增用例无需自写 mkdtemp 清理。
    setupFiles: ['tests/unit/setup/tmpTracker.ts'],
    globalSetup: ['tests/unit/setup/tmpGuard.ts'],
  },
})
