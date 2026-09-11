/**
 * 测试临时产物「名字前缀」的唯一解析器 + 清扫器（2026-09-10 卫生批）
 *
 * 为什么存在：全仓测试往 `os.tmpdir()` 里撒产物，命名有两类写法——
 *   A. `mkdtemp(os.tmpdir(), 'qihebox-files-')`（随机后缀）
 *   B. `` path.join(os.tmpdir(), `qihebox-outside-${Date.now()}.jpg`) ``（时间戳/自拼后缀，多为**散文件**）
 * 若把前缀手抄进清扫脚本，抄漏的那类就是残留（第一版只认 A 类且只扫 `tests/unit`，
 * 实测一轮全量 e2e 后 `/tmp` 仍剩 15 项：`qihebox-perf-e2e-*` / `qihebox-pv-img-*` /
 * `qihebox-outside-*.png` 全在口径外）。所以前缀**从测试源码现算**，两类写法都解析，
 * 单测侧（`tests/unit/setup/tmpGuard.ts`）与 e2e 侧（`tests/e2e/helpers/tmpTeardown.ts`）共用本文件。
 *
 * 所有权与安全性（清扫器的判定）：
 * - 本轮产物（mtime ≥ 开跑时刻）：前缀命中即删（目录、文件都算）。
 * - 更早的产物：只有**停更超过 `deadMs`（默认 10 分钟）**且名字带本仓所有权标记（`qihebox` / `qihe-` / `qbox`）才删——
 *   用于收掉崩溃/中断留下的死残（如 soak 跑一半被杀，userData 可上 G），同时把「误删并发在跑的别人的目录」
 *   压到不可能：真在用的目录 mtime 一直在动。通用名（`sel-inv-` / `mvx-` / `pdf-reg-` / `outside.txt`）
 *   无所有权标记 → 永远只按本轮窗口判，绝不越界删他人在用的。
 * - 不解析「无插值的纯字面量」（`'v257-shots'` / `'v258-time-fields'` 这类探针**给人看的**产物目录），
 *   故意留白：删了会把走查证据抹掉。已知残留类别，见 DEBUG-SOP §三 卫生批条末。
 */
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 本仓测试产物的所有权标记（用于「陈旧死残」分支的收紧判据） */
const OWNERSHIP = /^(qihebox|qihe-|qbox)/

/** A 类：mkdtemp 的 prefix 字面量（必须以 `-` 结尾，避免抓到普通字符串参数） */
const MKDTEMP_RE = /mkdtemp(?:Sync)?\s*\([\s\S{]*?['"]([a-z0-9][\w.-]*)['"]/g
/** B 类：`` path.join(os.tmpdir(), `<head>${...}`) `` 中 `${` 之前的静态头 */
const TEMPLATE_RE = /tmpdir\(\)\s*,\s*`([^`$]*)\$\{/g

/** 从给定目录下的测试源码解析全部临时产物前缀（去重、排序，纯字面量目录不在此列） */
export function collectTmpPrefixes(dirs: string[]): string[] {
  const prefixes = new Set<string>()
  const walk = (dir: string): void => {
    let entries: fsSync.Dirent[]
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(ts|mts)$/.test(e.name)) {
        const src = fsSync.readFileSync(full, 'utf8')
        for (const re of [MKDTEMP_RE, TEMPLATE_RE]) {
          re.lastIndex = 0
          for (const m of src.matchAll(re)) {
            const p = m[1]
            if (typeof p === 'string' && p.endsWith('-') && p.length > 1) prefixes.add(p)
          }
        }
      }
    }
  }
  for (const d of dirs) walk(d)
  return [...prefixes].sort()
}

export interface SweepOptions {
  /** 前缀集合（由 collectTmpPrefixes 现算）；额外固定项（如 e2e userData 前缀）由调用方并入 */
  prefixes: string[]
  /** 本轮开跑时刻（ms）：mtime ≥ 它即判为本轮产物，直接删。
   *  调用方需自带余量（`Date.now() - 1000`）——文件系统 mtime 向下取整，不留余量会漏判刚建的产物。 */
  runStartMs: number
  /** 陈旧死残的「停更」门槛，默认 10 分钟 */
  deadMs?: number
  /** 清扫根目录，默认 realpath 后的 os.tmpdir() */
  root?: string
}

export interface SweepResult {
  root: string
  dirs: number
  files: number
  stale: number
  failed: string[]
}

/**
 * 按前缀清扫 root（= tmpdir）下的临时产物。只删命中项，删除失败**不抛错**、计入 failed
 * （卫生工作不得把测试结果带崩，但必须出声——由调用方打印）。
 */
export function sweepTmpEntries(opts: SweepOptions): SweepResult {
  const root = opts.root ?? fsSync.realpathSync(os.tmpdir())
  const deadMs = opts.deadMs ?? 10 * 60 * 1000
  const now = Date.now()
  const res: SweepResult = { root, dirs: 0, files: 0, stale: 0, failed: [] }
  let names: string[]
  try {
    names = fsSync.readdirSync(root)
  } catch (err) {
    res.failed.push(`<无法读取 ${root}: ${(err as Error).message}>`)
    return res
  }
  for (const name of names) {
    const prefix = opts.prefixes.find((p) => name.startsWith(p))
    if (!prefix) continue
    const full = path.join(root, name)
    let st: fsSync.Stats
    try {
      st = fsSync.lstatSync(full)
    } catch {
      continue // 已经没了
    }
    const fresh = st.mtimeMs >= opts.runStartMs
    const dead = now - st.mtimeMs >= deadMs
    // 陈旧分支额外要求所有权标记：通用前缀（`sel-inv-` 等）不得越界删本轮之外的东西
    if (!fresh && !(dead && OWNERSHIP.test(prefix))) continue
    try {
      fsSync.rmSync(full, { recursive: st.isDirectory(), force: true })
      if (st.isDirectory()) res.dirs++
      else res.files++
      if (!fresh) res.stale++
    } catch (err) {
      res.failed.push(`${full} — ${(err as Error).message}`)
    }
  }
  return res
}
