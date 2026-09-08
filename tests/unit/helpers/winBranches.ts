/**
 * Windows 平台分支清单提取器（W0 防复发门禁，2026-09-08 Windows 测试约定 Task 1）。
 *
 * 目的：win32 分支在 Linux 宿主上永不执行（CI 全链 Linux-only），历史上全靠「发版后真机挂账」。
 * 本清单把「源码里每一处平台判定」钉成基线，并强制每处都有测试引用其模块——
 * 新增 win32 分支而不带测试 ⇒ 门禁直接红（机制与 plugins-api-surface 同构）。
 *
 * 三类点位：
 *   win32-branch   `=== 'win32'` / `!== 'win32'` 比较（含注入型 `platform === 'win32'`）—— **必须被覆盖**
 *   path-win32     `path.win32` 显式 win32 语义 —— **必须被覆盖**
 *   platform-read  仅读取 `process.platform` 值（上报/日志/默认参数），不构成行为分叉 —— 只登记不强制
 *
 * 覆盖判定：tests/unit 下任一 .test.ts 文本引用该模块（`src/main/〈模块〉` 子串）即算覆盖。
 * 含源码文本锚定型测试（如 window.ts 的 WM_POWERBROADCAST 静态锚），因其确为该类点位的合理守护形式。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（helpers → unit → tests → 根） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const BASELINE_PATH = path.join(ROOT, 'tests', 'unit', '__baselines__', 'win32-branches.md')

export type WinSiteKind = 'win32-branch' | 'path-win32' | 'platform-read'

export interface WinSite {
  /** 相对仓库根的正斜杠路径 */
  file: string
  line: number
  kind: WinSiteKind
  /** 去空白后的源码行（供人工核对，不参与比较稳定性之外的判断） */
  text: string
  /** 引用该模块的测试文件（相对根，升序，最多列 3 个） */
  coveredBy: string[]
}

const SCAN_ROOT = 'src'
const TEST_ROOT = 'tests/unit'
const FILE_RE = /\.(ts|tsx)$/
/** 平台分叉：与 'win32' 字面量比较（等/不等，含 `platform === 'win32'` 注入型） */
const BRANCH_RE = /[!=]==\s*['"]win32['"]|['"]win32['"]\s*[!=]==/
/** 显式 win32 路径语义 */
const PATH_WIN32_RE = /\bpath\.win32\b/
/** 平台值读取 */
const PLATFORM_READ_RE = /\bprocess\.platform\b/

function walk(dirAbs: string, relPrefix: string, out: string[]): void {
  for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, ent.name)
    const rel = `${relPrefix}/${ent.name}`
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '__snapshots__') continue
      walk(abs, rel, out)
    } else if (FILE_RE.test(ent.name) && !ent.name.endsWith('.d.ts')) {
      out.push(rel)
    }
  }
}

/** 全部候选测试文本（一次读入，供覆盖判定用） */
function readTests(root: string): Array<{ rel: string; text: string }> {
  const files: string[] = []
  walk(path.join(root, TEST_ROOT), TEST_ROOT, files)
  return files
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => ({ rel: f, text: fs.readFileSync(path.join(root, f), 'utf8') }))
}

/** 点位所属模块（去扩展名）⇒ 覆盖判定的引用锚：`src/main/window.ts` → `src/main/window` */
function moduleAnchor(file: string): string {
  return file.replace(/\.tsx?$/, '')
}

function coverageFor(file: string, tests: Array<{ rel: string; text: string }>): string[] {
  const anchor = moduleAnchor(file)
  return tests
    .filter((t) => t.text.includes(anchor))
    .map((t) => t.rel)
    .sort()
    .slice(0, 3)
}

/** 扫描源码树，产出按「文件 → 行号」升序排列的平台点位清单 */
export function collectWinSites(root: string = ROOT): WinSite[] {
  const relFiles: string[] = []
  walk(path.join(root, SCAN_ROOT), SCAN_ROOT, relFiles)
  const tests = readTests(root)
  const sites: WinSite[] = []
  for (const rel of relFiles.sort()) {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n')
    lines.forEach((raw, i) => {
      const text = raw.trim()
      // 注释行不计（文档里讨论平台判定是常态，不是点位）
      if (!text || text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) return
      let kind: WinSiteKind | null = null
      if (BRANCH_RE.test(text)) kind = 'win32-branch'
      else if (PATH_WIN32_RE.test(text)) kind = 'path-win32'
      else if (PLATFORM_READ_RE.test(text)) kind = 'platform-read'
      if (!kind) return
      sites.push({ file: rel, line: i + 1, kind, text, coveredBy: coverageFor(rel, tests) })
    })
  }
  return sites
}

/** 行首需强制覆盖（新增这两类点位必须带测试） */
export function isEnforced(kind: WinSiteKind): boolean {
  return kind === 'win32-branch' || kind === 'path-win32'
}

/** 序列化基线（确定性：不含时间戳；变更只能经 npm run win:update 落盘） */
export function serializeSites(sites: WinSite[]): string {
  const head = [
    '<!-- Windows 平台分支清单基线（W0 防复发门禁） -->',
    '<!-- 由 npm run win:update 生成；tests/unit/winBranchInventory.test.ts 逐行比对 -->',
    '<!-- 列：file:line | kind | 覆盖测试（UNCOVERED = 该类点位无测试引用，门禁红） -->',
    `count: ${sites.length}`,
    '',
  ]
  const rows = sites.map((s) => {
    const cov = s.coveredBy.length ? s.coveredBy.join(' ') : 'UNCOVERED'
    return `- ${s.file}:${s.line} | ${s.kind} | ${cov} | ${s.text}`
  })
  return [...head, ...rows, ''].join('\n')
}

/** 从基线文本取点位标识（file:line|kind），供增删 diff 摘要 */
export function siteKeys(sites: WinSite[]): string[] {
  return sites.map((s) => `${s.file}:${s.kind}`) // 不含行号：代码上下挪行不算增删
}
