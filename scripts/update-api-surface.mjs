/**
 * API 兼容性守护——基线更新入口（v2.5，Task 1 / PLAN-v2.5-测试.md §三.A）。
 *
 * `npm run api:update` → 本脚本 spawn `vitest run tests/unit/plugins-api-surface.test.ts`，
 * env 带 API_UPDATE=1（spawn 形式跨平台，不内联 `VAR=1 cmd` 前缀），透传退出码。
 * 破坏性变更：API_FORCE_BREAK=1 BREAK_REASON=<原因> npm run api:update。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const testFile = 'tests/unit/plugins-api-surface.test.ts'

const env = { ...process.env, API_UPDATE: '1' }
const child = spawn('npx', ['vitest', 'run', testFile], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

child.on('error', (err) => {
  console.error(`[api:update] 启动 vitest 失败：${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[api:update] vitest 被信号终止：${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
