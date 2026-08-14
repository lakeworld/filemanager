/**
 * 一致性套件 CLI 入口（v2.5，PLAN-v2.5-测试.md §四 Task 4）：
 *
 *   node tests/e2e/conformance/run-conformance.mjs [<插件路径>]
 *   （npm run conformance -- [<插件路径>]；preconformance 钩子已先构建 hello）
 *
 * - <插件路径>：`.qbox` 或插件目录（目录需含 manifest.json → 现场打包为临时 .qbox，复用 build-hello-plugin.mjs
 *   的 packQbox zip 逻辑）
 * - 未传参 → 默认 out/plugins/com.qihe.hello.qbox（不存在则报错提示先构建 hello）
 * - 前置构建：夹具（tests/e2e/conformance/fixtures/）先打包到 out/plugins/（conformance spec 依赖夹具就位）
 * - 设 CONFORMANCE_PLUGIN=<绝对路径> → spawn `npx playwright test tests/e2e/conformance` → 透传 exit code
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildConformanceFixtures, packPluginDir } from '../../../scripts/build-conformance-fixtures.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULT_QBOX = path.join(ROOT, 'out', 'plugins', 'com.qihe.hello.qbox')

async function main() {
  // 1. 前置构建夹具（spec 依赖夹具就位；幂等，KB 级）
  try {
    const built = await buildConformanceFixtures()
    for (const b of built) console.log(`[conformance] 夹具就位：${b.outPath}`)
  } catch (err) {
    console.error(`[conformance] 夹具构建失败：${err.message}`)
    process.exit(1)
  }

  // 2. 解析目标插件路径
  const arg = process.argv[2]
  let target = arg ? path.resolve(arg) : DEFAULT_QBOX

  const stat = await fsp.stat(target).catch(() => null)
  if (!stat) {
    if (!arg) {
      console.error(`✗ 默认插件不存在：${target}`)
      console.error('  请先构建 hello 示例插件：node scripts/build-hello-plugin.mjs')
    } else {
      console.error(`✗ 插件路径不存在：${target}`)
    }
    process.exit(2)
  }

  let pluginPath = target
  if (stat.isDirectory()) {
    // 目录 → 现场打包为临时 .qbox（复用 hello 的 packQbox zip 逻辑）
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'conformance-dir-'))
    try {
      const r = await packPluginDir(target, tmpDir)
      pluginPath = r.outPath
      console.log(`[conformance] 目录已打包为临时 .qbox：${pluginPath}`)
    } catch (err) {
      console.error(`✗ 目录打包失败：${err.message}`)
      process.exit(2)
    }
  } else if (!/\.qbox$/i.test(target)) {
    console.error(`✗ 仅支持 .qbox 或插件目录（目录需含 manifest.json）：${target}`)
    process.exit(2)
  }

  // 3. spawn playwright（透传 exit code）。
  // 注意：须用独立配置（无 testIgnore），否则根 playwright.config.ts 的 testIgnore 会连本套件一起过滤。
  const env = { ...process.env, CONFORMANCE_PLUGIN: pluginPath }
  const child = spawn('npx', ['playwright', 'test', '--config', 'tests/e2e/conformance/playwright.config.ts'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  child.on('error', (err) => {
    console.error(`[conformance] 启动 playwright 失败：${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[conformance] playwright 被信号终止：${signal}`)
      process.exit(1)
    }
    process.exit(code ?? 1)
  })
}

main().catch((err) => {
  console.error(`[conformance] 执行失败：${err.message}`)
  process.exit(1)
})
