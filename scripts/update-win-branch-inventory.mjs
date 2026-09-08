/**
 * Windows 平台分支清单——基线更新入口（W0 防复发门禁，2026-09-08 Windows 测试约定 Task 1）。
 *
 * `npm run win:update` → spawn `vitest run tests/unit/winBranchInventory.test.ts`，env 带 WIN_UPDATE=1
 * （spawn 形式跨平台，不内联 `VAR=1 cmd`，与 scripts/update-api-surface.mjs 同构），透传退出码。
 * 新增无覆盖点位会被拒绝；确属不可单测面时：
 *   WIN_BREAK=1 WIN_BREAK_REASON=<原因> npm run win:update   （原因写入基线头注释）
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const testFile = 'tests/unit/winBranchInventory.test.ts'

const env = { ...process.env, WIN_UPDATE: '1' }
const child = spawn('npx', ['vitest', 'run', testFile], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

child.on('error', (err) => {
  console.error(`[win:update] 启动 vitest 失败：${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[win:update] vitest 被信号终止：${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
