/**
 * 官方插件预装（v2.6 批 3，PLAN-2026-09-23-批3-插件正式化 §四 与 §六 验收第 3 条）。
 *
 * 分发形态：发行方把官方 `.qbox` 放进安装包内预装目录随包分发（打包态 `resources/official-plugins/`；
 * 开发/未打包态回退仓库内 `build/official-plugins/`）。宿主首启扫描该目录，对每个包走**既有标准安装管线**
 * `PluginInstaller.install`（整包 SHA-256 + 清单 Schema 校验 + zip-slip 防护 + 解压到 `pkg/` + re-scan +
 * 覆盖回滚）——**不另写第二套解压/校验**；落位与语义同手动安装（预装包同样可停用/卸载/被更高版覆盖）。
 *
 * 四条纪律：
 * ① 目录缺失或不是目录（开源自建构建不带预装目录）→ **优雅跳过**：空报告，不抛错、不写日志噪音；
 * ② 单包失败（坏 zip / 缺清单 / 清单校验失败 / 覆盖被拒 / 登记冲突）→ 只 warn + 收进报告，
 *    **整函数吞异常**（逐包与扫描两级），不阻断启动；
 * ③ 不覆盖用户已有版本：已装同 id 且版本 ≥ 预装版本 → 跳过；
 * ④ 启停两态分开：「显式 false」（config.json 有覆盖）一律不动，只有**无配置的新条目**才置 enabled。
 *
 * 纯 TS：不 import electron（目录由装配层解析后注入），可在 node 环境直接测试。
 */
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { validateManifest } from '../../plugins/types'
import type { PluginManifest } from '../../plugins/types'
import { extractZip } from '../core/archive'
import { writeJsonAtomic } from '../core/paths'
import { MANIFEST_FILE, versionAtLeast, type PluginRegistry } from './registry'
import type { PluginInstaller } from './installer'

/** 打包态预装目录名（`process.resourcesPath` 下，由 electron-builder `extraResources` 注入） */
export const OFFICIAL_PLUGINS_RES_DIR = 'official-plugins'
/** 预装诊断报告文件名（落在 `userData/plugins/` 根：该目录下的**文件**不参与 registry.scan 登记） */
export const PREINSTALL_REPORT_FILE = 'preinstall-report.json'

/** 单个预装包的处理结果（`file` 只记文件名——报告可能被用户贴出来，不落本机绝对路径） */
export interface PreinstallEntryResult {
  /** 预装目录内的包文件名 */
  file: string
  /** 包清单声明的 id（读不出/未登记时缺省） */
  id?: string
  /** 包清单声明的版本（读不出时缺省） */
  version?: string
  /** installed=新装 / updated=覆盖升级 / skipped=按判据跳过 / failed=失败（不抛，原因进 reason） */
  action: 'installed' | 'updated' | 'skipped' | 'failed'
  /** 人话原因（skipped / failed 必有；installed / updated 可缺省） */
  reason?: string
}

export interface PreinstallReport {
  /** 本次扫描的预装目录（打包态 resources 路径 / 开发态仓库内回退路径） */
  dir: string
  /** 目录存在且是目录（开源自建构建不带预装目录 → false，此时 entries 为空） */
  dirUsable: boolean
  /** 扫描期整体异常（readdir 失败等）；有值即视为「本轮零处理」，仍不阻断启动 */
  scanError?: string
  /** 目录内命中的 .qbox 个数（仅顶层，非递归） */
  total: number
  installed: number
  updated: number
  skipped: number
  failed: number
  /** 逐包结果（按文件名排序，稳定可断言） */
  entries: PreinstallEntryResult[]
  /** 报告落盘路径（实际写入时有值） */
  reportPath?: string
}

export interface PreinstallOptions {
  /** 预装源目录（由装配层解析；见 resolveOfficialPluginsDir） */
  dir: string
  /** userData/plugins 根（报告落盘位置） */
  root: string
  registry: PluginRegistry
  /** 标准安装管线（预装必须复用它，见文件头） */
  installer: Pick<PluginInstaller, 'install'>
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
  /** 测试注入：模拟扫描期 IO 异常（缺省 fsp.readdir） */
  readdir?: (dir: string) => Promise<string[]>
}

/**
 * 预装源目录解析：打包态 = `resources/official-plugins`；开发/未打包态回退仓库内 `build/official-plugins`。
 * 两态都由装配层把环境参数传进来（本模块不 import electron，便于单测）。
 */
export function resolveOfficialPluginsDir(opts: {
  isPackaged: boolean
  resourcesPath: string
  devFallbackDir: string
}): string {
  if (opts.isPackaged && opts.resourcesPath) return path.join(opts.resourcesPath, OFFICIAL_PLUGINS_RES_DIR)
  return opts.devFallbackDir
}

/**
 * 执行一轮预装（首启装配期调用一次；重复启动时命中「已装 ≥ 预装」判据 → 全跳过，幂等）。
 * **本函数不抛错**：任何失败只进报告 + warn 日志。
 */
export async function runOfficialPreinstall(opts: PreinstallOptions): Promise<PreinstallReport> {
  const log = opts.log ?? (() => {})
  const readdir = opts.readdir ?? ((dir: string) => fsp.readdir(dir))
  const report: PreinstallReport = {
    dir: opts.dir,
    dirUsable: false,
    total: 0,
    installed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    entries: [],
  }

  let files: string[] = []
  try {
    const st = await fsp.stat(opts.dir).catch(() => null)
    // ① 目录缺失 / 不是目录 → 优雅跳过（不抛、不写日志：开源自建构建走的就是这条）
    if (!st || !st.isDirectory()) return report
    report.dirUsable = true
    files = (await readdir(opts.dir)).filter((name) => /\.qbox$/i.test(name)).sort()
  } catch (err) {
    // ② 扫描本身异常（权限/IO/注入的抛错）→ 记 scanError，本轮零处理，仍不阻断启动
    report.scanError = message(err)
    log('warn', `[plugins] 官方插件预装：预装目录扫描失败，本轮跳过（${report.scanError}）`)
    return report
  }
  report.total = files.length

  /** 同批次内已处理过的 id（两个包声明同一 id 时后一个不重复装） */
  const seen = new Set<string>()
  for (const file of files) {
    const filePath = path.join(opts.dir, file)
    try {
      // 先读包内声明的 id/version 决定「跳过 / 覆盖」；读不出（缺清单 / 清单非法 / 坏 zip）
      // 一律不在这里下结论——交给标准管线去报错（保持安装失败原因的单一出处）
      const declared = await peekDeclaredIdentity(filePath)
      if (declared) {
        if (seen.has(declared.id)) {
          report.entries.push({ file, id: declared.id, version: declared.version, action: 'skipped', reason: '同批次内 id 重复（前一个包已处理）' })
          continue
        }
        const installed = opts.registry.get(declared.id)
        const installedVersion = installed?.manifest?.version
        // ③ 不覆盖用户已有版本：已装同 id 且版本 ≥ 预装版本 → 跳过
        //（已装但清单损坏/版本不可读时不下"跳过"结论，改走覆盖安装尝试修复；被拒则回滚并记 failed）
        if (installedVersion && versionAtLeast(installedVersion, declared.version)) {
          report.entries.push({
            file,
            id: declared.id,
            version: declared.version,
            action: 'skipped',
            reason: `已装 ${declared.id}@${installedVersion} ≥ 预装 ${declared.version}（不覆盖用户已有版本）`,
          })
          log('info', `[plugins] 预装跳过：${file}（已装 ${declared.id}@${installedVersion}）`)
          continue
        }
      }

      const r = await opts.installer.install(filePath)
      const action: PreinstallEntryResult['action'] = r.replaced ? 'updated' : 'installed'
      // ④ 新建条目置默认启用；既有 config.json 覆盖（含「显式 false」）一律不动。
      //    registry 语义：enabled = config.json 覆盖 ?? manifest.enabled —— 此处只在「无覆盖且当前为禁用」时补一次。
      const entry = opts.registry.get(r.id)
      if (entry && entry.state !== 'broken' && !entry.enabled && !opts.registry.hasConfigOverride(r.id)) {
        await opts.registry.setEnabled(r.id, true)
      }
      seen.add(r.id)
      report.entries.push({ file, id: r.id, version: entry?.manifest?.version ?? declared?.version, action })
    } catch (err) {
      // ② 单包失败：只 warn + 进报告，绝不外抛
      const reason = message(err)
      report.entries.push({ file, action: 'failed', reason })
      log('warn', `[plugins] 官方插件预装失败：${file} — ${reason}`)
    }
  }

  report.installed = report.entries.filter((e) => e.action === 'installed').length
  report.updated = report.entries.filter((e) => e.action === 'updated').length
  report.skipped = report.entries.filter((e) => e.action === 'skipped').length
  report.failed = report.entries.filter((e) => e.action === 'failed').length

  // 报告落盘（管理页/日志「可见原因」通道的载体；写失败不影响启动，只多一条 warn）
  if (report.dirUsable && report.total > 0) {
    const reportPath = path.join(opts.root, PREINSTALL_REPORT_FILE)
    try {
      await writeJsonAtomic(reportPath, report)
      report.reportPath = reportPath
      if (report.failed > 0) {
        log('warn', `[plugins] 官方插件预装：${report.failed}/${report.total} 个失败，详见 ${reportPath}`)
      }
    } catch (err) {
      report.reportPath = undefined
      log('warn', `[plugins] 官方插件预装报告写入失败：${message(err)}`)
    }
  }
  return report
}

/** 读包内 manifest 声明的 id/version（校验通过才算数）；读不出返回 null（由标准管线给出失败原因） */
async function peekDeclaredIdentity(pkgPath: string): Promise<{ id: string; version: string } | null> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-preinstall-'))
  try {
    await extractZip(pkgPath, tmpDir)
    const raw = await fsp.readFile(path.join(tmpDir, MANIFEST_FILE), 'utf-8').catch(() => null)
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!validateManifest(parsed).ok) return null
    const manifest = parsed as PluginManifest
    return { id: manifest.id, version: manifest.version }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}