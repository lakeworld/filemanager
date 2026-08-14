/**
 * 一致性套件夹具构建脚本（v2.5，PLAN-v2.5-测试.md §四 Task 4）：
 * `tests/e2e/conformance/fixtures/` 下两个夹具（bad / full）→ `out/plugins/<id>.qbox`。
 *
 * 夹具源码为纯 JS（无 esbuild / 无 TS 编译，主入口直接手写 main/index.js + manifest.json）——
 * 构建 = 直接 zip 打包（复用 scripts/build-hello-plugin.mjs 的 packQbox，与宿主 installer 的
 * extractZip 解压器格式对齐），零中间产物、零依赖。
 *
 * 用法：
 *   node scripts/build-conformance-fixtures.mjs                 # 默认 out=out/plugins
 *   node scripts/build-conformance-fixtures.mjs --out <dir>
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packQbox } from './build-hello-plugin.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 夹具源目录（tests/e2e/conformance/fixtures/<id>/） */
export const FIXTURES_DIR = path.join(ROOT, 'tests', 'e2e', 'conformance', 'fixtures')
export const DEFAULT_OUT_DIR = path.join(ROOT, 'out', 'plugins')

/** 递归收集目录下所有文件（跳过隐藏文件），返回 [{ name, data }]，name 为相对 srcDir 的正斜杠路径 */
async function collectFiles(srcDir) {
  const out = []
  async function walk(dir, relBase) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      const rel = relBase ? `${relBase}/${e.name}` : e.name
      if (e.isDirectory()) await walk(full, rel)
      else if (e.isFile()) out.push({ name: rel.replace(/\\/g, '/'), data: await fsp.readFile(full) })
    }
  }
  await walk(srcDir, '')
  return out
}

/**
 * 打包单个插件目录 → <manifest.id>.qbox。
 * 要求目录含 manifest.json（输出名依据其 id）；其余文件（main/index.js、renderer/** 等）按相对路径原样入包。
 * 完整 manifest 校验由宿主安装期执行（本脚本不校验，负路径夹具的坏 manifest 同样可打包）。
 * @returns {Promise<{ outPath: string; id: string; files: string[] }>}
 */
export async function packPluginDir(srcDir, outDir = DEFAULT_OUT_DIR) {
  const manifestPath = path.join(srcDir, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
  } catch (err) {
    throw new Error(`插件目录缺少合法 manifest.json：${manifestPath}（${err.message}）`)
  }
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new Error(`插件 manifest 缺少 id（.qbox 包名依据）：${manifestPath}`)
  }
  const files = await collectFiles(srcDir)
  if (!files.some((f) => f.name === 'manifest.json')) throw new Error(`插件目录缺 manifest.json 条目：${srcDir}`)

  await fsp.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${manifest.id}.qbox`)
  await fsp.writeFile(outPath, packQbox(files.map((f) => ({ name: f.name, data: f.data }))), { mode: 0o644 })
  return { outPath, id: manifest.id, files: files.map((f) => f.name) }
}

/** 构建全部夹具（fixtures/ 下每个子目录一个 .qbox）到 outDir。返回 [{ outPath, id, files }] */
export async function buildConformanceFixtures(outDir = DEFAULT_OUT_DIR) {
  const entries = await fsp.readdir(FIXTURES_DIR, { withFileTypes: true })
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  const built = []
  for (const dir of dirs) {
    built.push(await packPluginDir(path.join(FIXTURES_DIR, dir), outDir))
  }
  return built
}

// —— CLI ——
function isMain() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return import.meta.url === pathToFileURL(path.resolve(argv1)).href
  } catch {
    return false
  }
}

if (isMain()) {
  const args = process.argv.slice(2)
  let out
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = args[++i]
    else {
      console.error(`未知参数：${args[i]}（用法：--out <dir>）`)
      process.exit(2)
    }
  }
  buildConformanceFixtures(out)
    .then((built) => {
      for (const b of built) console.log(`✓ 夹具打包 → ${b.outPath}（${b.files.length} 条目）`)
    })
    .catch((err) => {
      console.error(`✗ 夹具构建失败：${err.message}`)
      process.exit(1)
    })
}
