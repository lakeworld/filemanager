/**
 * .qbox 安装器（v2.5，P0）：本地侧载安装/卸载（PLUGIN.md §2.1 / §4.1，PLAN §四）。
 * 安装：SHA-256 校验（对 .qbox 文件整体计算，记录防篡改）+ 清单 JSON Schema 校验（validateManifest）→
 * 解压到临时目录（复用 core/archive.ts extractZip，zip-slip/CRC 防护已有）→ 校验 manifest + 缺入口 →
 * 移入 userData/plugins/<id>/pkg/ → 重新登记（全局冲突 → 回滚拒绝）。
 * 卸载：删 pkg/ 与 state/（明示确认由 UI 层执行）；禁用不删（配置在 config.json）。
 * 官方索引下载分支：2.6（PLAN §二 排除项）。
 * 纯 TS：不 import electron，可在 node 环境直接测试（root 注入）。
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { validateManifest } from '../../plugins/types'
import type { PluginManifest } from '../../plugins/types'
import { extractZip } from '../core/archive'
import {
  PKG_DIR,
  MAIN_ENTRY,
  MANIFEST_FILE,
  type PluginRegistry,
} from './registry'

export interface InstallerOptions {
  /** userData/plugins 根 */
  root: string
  registry: PluginRegistry
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface InstallResult {
  /** 安装成功的插件 id */
  id: string
  /** .qbox 整体 SHA-256（完整性展示与防篡改记录，落盘 <id>/.qbox.sha256） */
  sha256: string
  /** .qbox 字节数 */
  size: number
}

export class PluginInstaller {
  private root: string
  private registry: PluginRegistry
  private log: (level: 'info' | 'warn' | 'error', msg: string) => void

  constructor(opts: InstallerOptions) {
    this.root = opts.root
    this.registry = opts.registry
    this.log = opts.log ?? (() => {})
  }

  /**
   * 侧载安装 .qbox：SHA-256 + 清单校验 + 解压到 pkg/ + 重新登记。
   * 已安装/全局冲突（id / ipcPrefix / 页面路径 / minHostVersion）→ 抛错并回滚（不残留目录）。
   */
  async install(filePathRaw: string): Promise<InstallResult> {
    const filePath = String(filePathRaw ?? '').trim()
    if (!filePath) throw new Error('缺少 .qbox 包路径')
    if (!/\.qbox$/i.test(filePath)) throw new Error('仅支持 .qbox 安装包（zip 格式）')
    const stat = await fsp.stat(filePath).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error('安装包不存在或不可读')

    const sha256 = await sha256OfFile(filePath)
    const size = stat.size

    // 解压到临时目录（zip-slip/CRC/GBK 防护复用 core/archive；manifest 校验通过前不写入插件目录）
    const tmpDir = path.join(this.root, `.tmp-install-${process.pid}-${Date.now()}`)
    try {
      await fsp.mkdir(tmpDir, { recursive: true })
      await extractZip(filePath, tmpDir)

      const manifestRaw = await fsp.readFile(path.join(tmpDir, MANIFEST_FILE), 'utf-8').catch(() => null)
      if (manifestRaw === null) throw new Error('安装包缺少 manifest.json')
      let parsed: unknown
      try {
        parsed = JSON.parse(manifestRaw)
      } catch (err) {
        throw new Error(`manifest.json 解析失败：${err instanceof Error ? err.message : String(err)}`)
      }
      const v = validateManifest(parsed)
      if (!v.ok) throw new Error(`清单校验失败：${v.errors.join('；')}`)
      const manifest = parsed as PluginManifest

      const pkgDir = path.join(this.root, manifest.id, PKG_DIR)
      if (fs.existsSync(pkgDir) || this.registry.get(manifest.id)) {
        throw new Error(`插件已安装：${manifest.id}`)
      }
      if (!fs.existsSync(path.join(tmpDir, MAIN_ENTRY))) {
        throw new Error('安装包缺少主进程入口 main/index.js')
      }

      // 移入 pkg/（同盘 rename，原子；state/ 由插件首次写入时创建）
      await fsp.mkdir(path.dirname(pkgDir), { recursive: true })
      await fsp.rename(tmpDir, pkgDir)
      // 防篡改记录：原始 .qbox 的 SHA-256（PLAN §4.1；官方索引比对 2.6）
      await fsp
        .writeFile(path.join(this.root, manifest.id, '.qbox.sha256'), sha256, { encoding: 'utf-8', mode: 0o644 })
        .catch(() => {})
      await this.reload()
      const entry = this.registry.get(manifest.id)
      if (!entry) throw new Error('安装后登记失败')
      if (entry.state === 'broken') {
        // 登记期全局冲突（id/ipcPrefix/页面路径/minHostVersion 等）→ 回滚安装
        await fsp.rm(path.join(this.root, manifest.id), { recursive: true, force: true })
        await this.reload()
        throw new Error(`安装被拒绝：${entry.brokenReason ?? '未知原因'}`)
      }
      this.log('info', `插件已安装：${manifest.id}@${manifest.version}（sha256=${sha256.slice(0, 12)}…）`)
      return { id: manifest.id, sha256, size }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 卸载：删除 userData/plugins/<id>/（pkg/ 与 state/ 一并清理，PLUGIN.md §2.1）+
   * 清除启停覆盖。已激活实例须由调用方先 loader.deactivate（ipc 层编排）。
   */
  async uninstall(id: string): Promise<void> {
    const entry = this.registry.get(id)
    if (!entry) throw new Error(`插件未安装：${id}`)
    await fsp.rm(path.join(this.root, id), { recursive: true, force: true })
    this.registry.forgetConfig(id)
    await this.reload()
    this.log('info', `插件已卸载：${id}`)
  }

  private async reload(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true })
    this.registry.scan()
  }
}

/** 对文件整体计算 SHA-256（流式，内存与文件大小无关） */
export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
