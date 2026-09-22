/**
 * 官方插件预装单测（v2.6 批 3，PLAN-2026-09-23-批3-插件正式化 §四 / §六 验收第 3 条）。
 *
 * 覆盖：目录缺失/非目录优雅跳过（含「不写日志噪音」）· 空目录 · 非 .qbox 与子目录包被忽略 ·
 * 有效包走标准管线安装 + 新建条目默认启用 · 已装同版/更高版跳过（不覆盖用户版本）· 预装版本更高走覆盖升级
 * （state/ 保留）· 用户显式禁用不被强行打开 · 坏包（缺 manifest / 非 zip）失败但不抛且报告可读 ·
 * 单包失败不影响其他包 · 扫描整体异常不阻断 · 重复启动幂等 · 报告落盘 · 目录解析两态。
 *
 * 夹具用本仓既有的 compressToZip 拼真 .qbox（与 plugins-host.test.ts 同风格），安装走真 PluginInstaller
 * ——本文件不注入任何"假安装器"，判据全落在真实落盘与登记状态上。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { PluginRegistry, PKG_DIR, SHA256_FILE } from '../../src/main/plugins/registry'
import { PluginInstaller } from '../../src/main/plugins/installer'
import {
  OFFICIAL_PLUGINS_RES_DIR,
  PREINSTALL_REPORT_FILE,
  resolveOfficialPluginsDir,
  runOfficialPreinstall,
  type PreinstallReport,
} from '../../src/main/plugins/preinstall'
import { compressToZip } from '../../src/main/core/archive'

/** userData/plugins 根 */
let root = ''
/** 预装源目录（模拟安装包内 resources/official-plugins） */
let preDir = ''

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-preinstall-root-'))
  preDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-preinstall-src-'))
})

const OK_MAIN = 'module.exports = { activate: async () => ({ ipc: {} }) }'

function manifestFor(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: '预装夹具插件',
    version: '0.1.0',
    apiVersion: 1,
    enabled: true,
    kind: ['ipc'],
    ipcPrefix: id.split('.').pop() ?? id,
    ...overrides,
  }
}

/** 组装 .qbox（manifest.json 平铺 + main/index.js；可选附加文件用于标识包版本） */
async function buildQbox(
  qboxPath: string,
  manifest: Record<string, unknown> | null,
  extra: Record<string, string> = {},
): Promise<void> {
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'qbox-preinstall-staging-'))
  const sources: string[] = []
  if (manifest) {
    const mPath = path.join(staging, 'manifest.json')
    await fsp.writeFile(mPath, JSON.stringify(manifest))
    sources.push(mPath)
  }
  const mainDir = path.join(staging, 'main')
  await fsp.mkdir(mainDir, { recursive: true })
  await fsp.writeFile(path.join(mainDir, 'index.js'), OK_MAIN)
  sources.push(mainDir)
  for (const [rel, content] of Object.entries(extra)) {
    const p = path.join(staging, rel)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, content)
  }
  // 附加文件所在顶层目录也要进压缩源（否则只写在 staging、不进包）
  for (const top of new Set(Object.keys(extra).map((rel) => rel.split('/')[0]))) {
    const p = path.join(staging, top)
    if (!sources.includes(p)) sources.push(p)
  }
  await compressToZip(sources, qboxPath)
  await fsp.rm(staging, { recursive: true, force: true })
}

/** 登记表 + 标准安装器（真件；日志收集起来供断言） */
function makeCtx(): { registry: PluginRegistry; installer: PluginInstaller; logs: [string, string][] } {
  const logs: [string, string][] = []
  const log = (level: string, msg: string): void => {
    logs.push([level, msg])
  }
  const registry = new PluginRegistry({ root, hostVersion: '2.6.0', log: log as never })
  registry.scan()
  const installer = new PluginInstaller({ root, registry, log: log as never })
  return { registry, installer, logs }
}

function run(
  ctx: { registry: PluginRegistry; installer: PluginInstaller; logs: [string, string][] },
  overrides: Partial<Parameters<typeof runOfficialPreinstall>[0]> = {},
): Promise<PreinstallReport> {
  return runOfficialPreinstall({
    dir: preDir,
    root,
    registry: ctx.registry,
    installer: ctx.installer,
    log: (level, msg) => ctx.logs.push([level, msg]),
    ...overrides,
  })
}

const pkgText = (id: string, rel = 'main/index.js'): string =>
  fs.readFileSync(path.join(root, id, PKG_DIR, rel), 'utf-8')

// ───────────────────────── 目录与扫描面 ─────────────────────────

describe('官方插件预装：目录解析与优雅跳过', () => {
  it('resolveOfficialPluginsDir：打包态取 resources/official-plugins；开发态回退仓库内目录', () => {
    expect(
      resolveOfficialPluginsDir({ isPackaged: true, resourcesPath: '/opt/app/resources', devFallbackDir: '/repo/build/official-plugins' }),
    ).toBe(path.join('/opt/app/resources', OFFICIAL_PLUGINS_RES_DIR))
    expect(
      resolveOfficialPluginsDir({ isPackaged: false, resourcesPath: '/tmp/electron/resources', devFallbackDir: '/repo/build/official-plugins' }),
    ).toBe('/repo/build/official-plugins')
    // 打包态但 resourcesPath 不可得（极端）→ 仍回退，不返回坏路径
    expect(resolveOfficialPluginsDir({ isPackaged: true, resourcesPath: '', devFallbackDir: '/repo/build/official-plugins' })).toBe(
      '/repo/build/official-plugins',
    )
  })

  it('目录不存在 → 空报告、不抛、零日志（开源自建构建：无预装目录）', async () => {
    const ctx = makeCtx()
    const report = await run(ctx, { dir: path.join(root, 'no-such-dir') })
    expect(report.dirUsable).toBe(false)
    expect(report.total).toBe(0)
    expect(report.entries).toEqual([])
    expect(report.installed + report.updated + report.skipped + report.failed).toBe(0)
    expect(report.reportPath).toBeUndefined()
    expect(ctx.logs).toEqual([]) // 不写日志噪音
    expect(fs.existsSync(path.join(root, PREINSTALL_REPORT_FILE))).toBe(false)
  })

  it('路径存在但不是目录（同名文件）→ 同样优雅跳过', async () => {
    const notDir = path.join(root, 'not-a-dir')
    await fsp.writeFile(notDir, 'x')
    const ctx = makeCtx()
    const report = await run(ctx, { dir: notDir })
    expect(report.dirUsable).toBe(false)
    expect(report.total).toBe(0)
    expect(ctx.logs).toEqual([])
  })

  it('空目录 → dirUsable、零条目、不落报告文件', async () => {
    const ctx = makeCtx()
    const report = await run(ctx)
    expect(report.dirUsable).toBe(true)
    expect(report.total).toBe(0)
    expect(report.entries).toEqual([])
    expect(ctx.logs).toEqual([])
    expect(fs.existsSync(path.join(root, PREINSTALL_REPORT_FILE))).toBe(false)
  })

  it('仅顶层 *.qbox：非包文件与子目录内的包被忽略（大小写不敏感，与安装器同口径）', async () => {
    await fsp.writeFile(path.join(preDir, '说明.txt'), '不是插件包')
    await fsp.mkdir(path.join(preDir, 'sub'))
    await buildQbox(path.join(preDir, 'sub', 'com.qihe.nested.qbox'), manifestFor('com.qihe.nested'))
    await buildQbox(path.join(preDir, 'com.qihe.upper.QBOX'), manifestFor('com.qihe.upper'))
    const ctx = makeCtx()
    const report = await run(ctx)
    expect(report.total).toBe(1)
    expect(report.installed).toBe(1)
    expect(report.entries.map((e) => e.file)).toEqual(['com.qihe.upper.QBOX'])
    expect(ctx.registry.get('com.qihe.nested')).toBeUndefined()
    expect(ctx.registry.get('com.qihe.upper')?.state).toBe('enabled')
  })
})

// ───────────────────────── 安装语义 ─────────────────────────

describe('官方插件预装：安装与启停语义', () => {
  it('有效包 → 走标准安装管线（pkg/ 落盘 + .qbox.sha256 + 登记启用），报告 action=installed', async () => {
    await buildQbox(path.join(preDir, 'com.qihe.pre.qbox'), manifestFor('com.qihe.pre'), { 'renderer/pages/Main.js': 'export default () => null' })
    const ctx = makeCtx()
    const report = await run(ctx)
    expect(report.installed).toBe(1)
    expect(report.entries[0]).toMatchObject({ file: 'com.qihe.pre.qbox', id: 'com.qihe.pre', version: '0.1.0', action: 'installed' })
    // 标准管线三件套落位：pkg/ + 防篡改 sha256 记录 + 登记启用
    expect(fs.existsSync(path.join(root, 'com.qihe.pre', PKG_DIR, 'renderer', 'pages', 'Main.js'))).toBe(true)
    expect(fs.readFileSync(path.join(root, 'com.qihe.pre', SHA256_FILE), 'utf-8')).toMatch(/^[0-9a-f]{64}$/)
    expect(ctx.registry.get('com.qihe.pre')?.state).toBe('enabled')
  })

  it('清单 enabled:false 且无启停覆盖 → 装完仍置启用（新建条目默认启用）', async () => {
    await buildQbox(path.join(preDir, 'com.qihe.off.qbox'), manifestFor('com.qihe.off', { enabled: false }))
    const ctx = makeCtx()
    const report = await run(ctx)
    expect(report.installed).toBe(1)
    expect(ctx.registry.get('com.qihe.off')?.enabled).toBe(true)
    // 覆写落进 config.json（与手动「启用」同一条路，不是内存态）
    expect(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8'))).toEqual({ 'com.qihe.off': true })
  })

  it('已装同版 / 更高版 → 跳过且不触碰用户 pkg（不覆盖用户已有版本）', async () => {
    const ctx = makeCtx()
    // 用户已装 v2.0.0（标记 USER-V2）
    await buildQbox(path.join(preDir, 'user.qbox'), manifestFor('com.qihe.pre', { version: '2.0.0' }), { 'renderer/user.txt': 'USER-V2' })
    await ctx.installer.install(path.join(preDir, 'user.qbox'))
    await fsp.rm(path.join(preDir, 'user.qbox'))
    // 预装同版 v2.0.0 → 跳过
    await buildQbox(path.join(preDir, 'same.qbox'), manifestFor('com.qihe.pre', { version: '2.0.0' }), { 'renderer/user.txt': 'PREINSTALL-SAME' })
    let report = await run(ctx)
    expect(report.skipped).toBe(1)
    expect(report.installed + report.updated).toBe(0)
    expect(report.entries[0].reason).toContain('已装 com.qihe.pre@2.0.0')
    expect(pkgText('com.qihe.pre', 'renderer/user.txt')).toBe('USER-V2')
    // 预装更低版 v1.0.0 → 仍跳过
    await fsp.rm(path.join(preDir, 'same.qbox'))
    await buildQbox(path.join(preDir, 'older.qbox'), manifestFor('com.qihe.pre', { version: '1.0.0' }), { 'renderer/user.txt': 'PREINSTALL-OLDER' })
    report = await run(ctx)
    expect(report.skipped).toBe(1)
    expect(pkgText('com.qihe.pre', 'renderer/user.txt')).toBe('USER-V2')
    expect(ctx.logs.some(([lv, m]) => lv === 'info' && m.includes('预装跳过'))).toBe(true)
  })

  it('预装版本更高 → 覆盖安装（pkg 换新、state/ 保留、action=updated）', async () => {
    const ctx = makeCtx()
    await buildQbox(path.join(preDir, 'user.qbox'), manifestFor('com.qihe.pre', { version: '0.1.0' }), { 'renderer/user.txt': 'USER-V1' })
    await ctx.installer.install(path.join(preDir, 'user.qbox'))
    await fsp.rm(path.join(preDir, 'user.qbox'))
    // 用户业务状态（覆盖安装必须保留）
    await fsp.mkdir(path.join(root, 'com.qihe.pre', 'state'), { recursive: true })
    await fsp.writeFile(path.join(root, 'com.qihe.pre', 'state', 'data.json'), '{"keep":true}')
    // 预装 v0.2.0（且清单默认禁用——覆盖升级不得改变既有启停）
    await buildQbox(path.join(preDir, 'newer.qbox'), manifestFor('com.qihe.pre', { version: '0.2.0' }), { 'renderer/user.txt': 'PRE-V2' })
    const report = await run(ctx)
    expect(report.updated).toBe(1)
    expect(report.entries[0]).toMatchObject({ id: 'com.qihe.pre', version: '0.2.0', action: 'updated' })
    expect(pkgText('com.qihe.pre', 'renderer/user.txt')).toBe('PRE-V2')
    expect(fs.readFileSync(path.join(root, 'com.qihe.pre', 'state', 'data.json'), 'utf-8')).toBe('{"keep":true}')
    expect(ctx.registry.get('com.qihe.pre')?.enabled).toBe(true) // 用户未关过 → 保持启用
  })

  it('用户显式禁用（config.json=false）→ 覆盖升级不强行打开', async () => {
    const ctx = makeCtx()
    await buildQbox(path.join(preDir, 'user.qbox'), manifestFor('com.qihe.pre', { version: '0.1.0' }))
    await ctx.installer.install(path.join(preDir, 'user.qbox'))
    await ctx.registry.setEnabled('com.qihe.pre', false) // 用户显式关闭 → config.json { id: false }
    await buildQbox(path.join(preDir, 'newer.qbox'), manifestFor('com.qihe.pre', { version: '0.2.0', enabled: true }))
    const report = await run(ctx)
    expect(report.updated).toBe(1)
    expect(ctx.registry.get('com.qihe.pre')?.enabled).toBe(false)
    expect(ctx.registry.get('com.qihe.pre')?.state).toBe('disabled')
    expect(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8'))).toEqual({ 'com.qihe.pre': false })
  })

  it('重复启动幂等：第二次全跳过，无重复安装', async () => {
    await buildQbox(path.join(preDir, 'com.qihe.pre.qbox'), manifestFor('com.qihe.pre'))
    const ctx = makeCtx()
    expect((await run(ctx)).installed).toBe(1)
    const second = await run(ctx)
    expect(second.installed + second.updated).toBe(0)
    expect(second.skipped).toBe(1)
    expect(second.entries[0].reason).toContain('不覆盖用户已有版本')
  })
})

// ───────────────────────── 失败不阻断 ─────────────────────────

describe('官方插件预装：失败与异常一律不阻断', () => {
  it('坏包（缺 manifest）→ failed 且不抛、原因可读；同批好包照常安装', async () => {
    await buildQbox(path.join(preDir, 'a-bad.qbox'), null) // 无 manifest.json
    await buildQbox(path.join(preDir, 'b-good.qbox'), manifestFor('com.qihe.good'))
    const ctx = makeCtx()
    const report = await run(ctx)
    expect(report.total).toBe(2)
    expect(report.failed).toBe(1)
    expect(report.installed).toBe(1)
    const bad = report.entries.find((e) => e.file === 'a-bad.qbox')
    expect(bad?.action).toBe('failed')
    expect(bad?.reason).toContain('缺少 manifest.json')
    expect(ctx.logs.some(([lv, m]) => lv === 'warn' && m.includes('a-bad.qbox'))).toBe(true)
    expect(ctx.registry.get('com.qihe.good')?.state).toBe('enabled')
  })

  it('坏包（非 zip 字节）→ failed 且不抛', async () => {
    await fsp.writeFile(path.join(preDir, 'broken.qbox'), Buffer.from('这不是一个 zip 包'))
    const ctx = makeCtx()
    const report = await run(ctx)
    expect(report.total).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.entries[0].action).toBe('failed')
    expect(report.entries[0].reason).toBeTruthy()
    expect(ctx.registry.list()).toEqual([])
  })

  it('清单非法（apiCompat 不相交）→ failed 且原因来自标准管线', async () => {
    await buildQbox(path.join(preDir, 'com.qihe.bad.qbox'), manifestFor('com.qihe.bad', { apiCompat: [2, 3] }))
    const ctx = makeCtx()
    const report = await run(ctx)
    expect(report.failed).toBe(1)
    expect(report.entries[0].reason).toContain('apiCompat')
    // 失败不残留：无安装目录、无临时目录
    expect(fs.existsSync(path.join(root, 'com.qihe.bad'))).toBe(false)
    expect(fs.readdirSync(root).filter((n) => n.startsWith('.tmp-install-'))).toEqual([])
  })

  it('扫描整体异常（readdir 抛错）→ 不抛、零处理、scanError 可读', async () => {
    await buildQbox(path.join(preDir, 'com.qihe.pre.qbox'), manifestFor('com.qihe.pre'))
    const ctx = makeCtx()
    const report = await run(ctx, {
      readdir: async () => {
        throw new Error('EACCES: 注入的扫描异常')
      },
    })
    expect(report.scanError).toContain('EACCES')
    expect(report.total).toBe(0)
    expect(report.entries).toEqual([])
    expect(ctx.registry.list()).toEqual([])
    expect(ctx.logs.some(([lv, m]) => lv === 'warn' && m.includes('扫描失败'))).toBe(true)
  })

  it('安装器抛错（登记冲突：ipcPrefix 撞已装插件）→ failed 不抛，已装插件不受影响', async () => {
    const ctx = makeCtx()
    // 已装插件占用 ipcPrefix 'clash'（目录名排序在前 ⇒ 登记期先占前缀）
    await buildQbox(path.join(preDir, 'user.qbox'), manifestFor('com.qihe.owner', { ipcPrefix: 'clash' }))
    await ctx.installer.install(path.join(preDir, 'user.qbox'))
    // 预装包声明同前缀（不同 id，目录名排序在后）→ 登记期冲突 → 覆盖安装回滚并抛错
    await buildQbox(path.join(preDir, 'zclash.qbox'), manifestFor('com.qihe.zclash', { ipcPrefix: 'clash' }))
    const report = await run(ctx)
    expect(report.failed).toBe(1)
    const clash = report.entries.find((e) => e.file === 'zclash.qbox')
    expect(clash?.action).toBe('failed')
    expect(clash?.reason).toContain('ipcPrefix')
    expect(ctx.registry.get('com.qihe.owner')?.state).toBe('enabled')
    expect(ctx.registry.get('com.qihe.zclash')).toBeUndefined()
    expect(fs.existsSync(path.join(root, 'com.qihe.zclash'))).toBe(false)
  })
})

// ───────────────────────── 报告 ─────────────────────────

describe('官方插件预装：诊断报告', () => {
  it('报告落盘 userData/plugins/preinstall-report.json，内容与返回值一致（逐包动作与原因）', async () => {
    await buildQbox(path.join(preDir, 'b-good.qbox'), manifestFor('com.qihe.good'))
    await buildQbox(path.join(preDir, 'a-bad.qbox'), null)
    const ctx = makeCtx()
    const report = await run(ctx)
    const reportPath = path.join(root, PREINSTALL_REPORT_FILE)
    expect(report.reportPath).toBe(reportPath)
    const written = JSON.parse(await fsp.readFile(reportPath, 'utf-8')) as PreinstallReport
    expect(written.dirUsable).toBe(true)
    expect(written.dir).toBe(preDir)
    expect(written.total).toBe(2)
    expect(written.installed).toBe(1)
    expect(written.failed).toBe(1)
    expect(written.entries).toEqual(report.entries)
    // 报告文件本身不是插件候选：registry.scan() 不会把它登记成幽灵条目
    ctx.registry.scan()
    expect(ctx.registry.list().map((p) => p.id)).toEqual(['com.qihe.good'])
  })

  it('有失败时多一条 warn 汇总（指向报告路径）', async () => {
    await buildQbox(path.join(preDir, 'a-bad.qbox'), null)
    const ctx = makeCtx()
    await run(ctx)
    expect(
      ctx.logs.some(([lv, m]) => lv === 'warn' && m.includes('1/1 个失败') && m.includes(PREINSTALL_REPORT_FILE)),
    ).toBe(true)
  })
})