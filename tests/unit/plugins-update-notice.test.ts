/**
 * 更新重启提示 + 目录行派生 单测（v2.6 批 2，渲染层纯函数 + 管理页源码级门禁）。
 *
 * 为什么这些用例必须存在：「插件更新后重启提示」的判定与措辞是**用户可见承诺**
 * （口径 = 内部版插件契约（不进公开仓）§七，2026-09-22 用户拍板），判据写在纯函数里才可能被逐条打；
 * 「可更新」标记与错误引导同理——管理页只是把它们画出来。
 *
 * 覆盖：
 * 1. buildRestartNotice 判定矩阵（新装不提 / 同版本「已重新安装」/ 版本变化「已更新：vA → vB」）；
 * 2. deriveCatalogRows（未装 / 同版本 / 旧版本可更新 / 不兼容无下载 / 禁用与 broken 也算已装）；
 * 3. catalogErrorGuidance（按错误码分流：需登录 / 未部署 / 可重试，不猜文案）；
 * 4. 体积与 permissions 摘要格式化；
 * 5. 管理页源码级门禁（无组件级单测基座：本仓既有做法 = 源码包含性断言，见 plugins-contract.test.ts）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginCatalogEntry, PluginInfo } from '../../src/shared/types'
import {
  buildRestartNotice,
  catalogErrorGuidance,
  deriveCatalogRows,
  formatPluginSize,
  summarizeCatalogPermissions,
} from '../../src/renderer/src/plugins/registry'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAGE = 'src/renderer/src/plugins/PluginManagerPage.tsx'

/** 已装插件夹具（必需字段齐全，可按需覆盖） */
function plugin(over: Partial<PluginInfo> & { id: string }): PluginInfo {
  return {
    name: '启禾云助手',
    version: '0.7.0',
    apiVersion: 1,
    kind: ['ipc'],
    enabled: true,
    state: 'enabled',
    callCount: 0,
    failCount: 0,
    installedAt: '2026-09-23T00:00:00.000Z',
    ...over,
  }
}

/** 目录条目夹具（宿主派生字段默认：兼容 + 选中 0.7.1） */
function entry(over: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
  return {
    id: 'com.qihe.cloud',
    name: '启禾云助手',
    versions: [
      {
        version: '0.7.1',
        apiCompat: [1, 1],
        sha256: 'a'.repeat(64),
        downloadUrl: 'https://example.com/pkgs/cloud-0.7.1.qbox',
        size: 1_500_000,
      },
    ],
    compatible: true,
    selected: {
      version: '0.7.1',
      apiCompat: [1, 1],
      sha256: 'a'.repeat(64),
      downloadUrl: 'https://example.com/pkgs/cloud-0.7.1.qbox',
      size: 1_500_000,
    },
    ...over,
  }
}

describe('buildRestartNotice：更新即重启提示（判定 = 安装前快照同 id 已存在）', () => {
  it('新装 → 不提（null）——没装过就没什么"旧版本"要交代', () => {
    expect(buildRestartNotice([], plugin({ id: 'com.qihe.cloud' }))).toBeNull()
    expect(
      buildRestartNotice([plugin({ id: 'com.qihe.lan' })], plugin({ id: 'com.qihe.cloud' })),
    ).toBeNull()
  })

  it('版本变化 →「插件已更新：vA → vB，重启应用后新版本完全生效」', () => {
    const notice = buildRestartNotice(
      [plugin({ id: 'com.qihe.cloud', version: '0.7.0' })],
      plugin({ id: 'com.qihe.cloud', version: '0.7.1' }),
    )
    expect(notice).not.toBeNull()
    expect(notice!.reinstalled).toBe(false)
    expect(notice!.title).toBe('插件已更新')
    expect(notice!.fromVersion).toBe('0.7.0')
    expect(notice!.toVersion).toBe('0.7.1')
    expect(notice!.message).toBe('插件已更新：v0.7.0 → v0.7.1，重启应用后新版本完全生效（启禾云助手）')
  })

  it('同版本重装 → 亦命中，措辞「已重新安装」（2026-09-22 拍板口径）', () => {
    const notice = buildRestartNotice(
      [plugin({ id: 'com.qihe.cloud', version: '0.7.0' })],
      plugin({ id: 'com.qihe.cloud', version: '0.7.0' }),
    )
    expect(notice!.reinstalled).toBe(true)
    expect(notice!.title).toBe('插件已重新安装')
    expect(notice!.message).toBe('插件已重新安装：v0.7.0，重启应用后新版本完全生效（启禾云助手）')
  })

  it('禁用 / broken 的已装插件同样命中（"已装"看清单，不看启停态）', () => {
    for (const state of ['disabled', 'broken'] as const) {
      const notice = buildRestartNotice(
        [plugin({ id: 'com.qihe.cloud', version: '0.7.0', state, enabled: false })],
        plugin({ id: 'com.qihe.cloud', version: '0.7.1' }),
      )
      expect(notice, `state=${state}`).not.toBeNull()
      expect(notice!.fromVersion).toBe('0.7.0')
    }
  })
})

describe('deriveCatalogRows：目录 × 已装清单（可更新标记的判据）', () => {
  it('未安装 → 无「可更新」、无可装版本时也不标记', () => {
    const rows = deriveCatalogRows([entry()], [])
    expect(rows[0].installedVersion).toBeUndefined()
    expect(rows[0].updateAvailable).toBe(false)
  })

  it('已装同版本 → 不标可更新；已装旧版本 → 标可更新（版本不同即算）', () => {
    const same = deriveCatalogRows([entry()], [plugin({ id: 'com.qihe.cloud', version: '0.7.1' })])
    expect(same[0].installedVersion).toBe('0.7.1')
    expect(same[0].updateAvailable).toBe(false)

    const older = deriveCatalogRows([entry()], [plugin({ id: 'com.qihe.cloud', version: '0.7.0' })])
    expect(older[0].installedVersion).toBe('0.7.0')
    expect(older[0].updateAvailable).toBe(true)
  })

  it('不兼容条目（宿主未派生 selected）→ 恒不标可更新（没有可下载版本）', () => {
    const incompatible = entry({ compatible: false, selected: undefined, reason: '无与当前宿主兼容的版本' })
    const rows = deriveCatalogRows([incompatible], [plugin({ id: 'com.qihe.cloud', version: '0.7.0' })])
    expect(rows[0].updateAvailable).toBe(false)
    expect(rows[0].installedVersion).toBe('0.7.0')
  })

  it('多条目各归各（id 对齐；清单里没有的条目不误标）', () => {
    const rows = deriveCatalogRows(
      [entry(), entry({ id: 'com.qihe.lan', name: '局域网共享', selected: undefined })],
      [plugin({ id: 'com.qihe.lan', name: '局域网共享', version: '0.3.0' })],
    )
    expect(rows[0].installedVersion).toBeUndefined()
    expect(rows[1].installedVersion).toBe('0.3.0')
  })
})

describe('catalogErrorGuidance：按错误码分流（不猜文案）', () => {
  it('NOT_LOGGED_IN → 引导登录、不给「重试」（重试也是同一个答案）', () => {
    const g = catalogErrorGuidance('NOT_LOGGED_IN：官方插件目录需要登录——请先在「我的 → 账号」登录启禾云账号后重试')
    expect(g.code).toBe('NOT_LOGGED_IN')
    expect(g.loginRequired).toBe(true)
    expect(g.retryable).toBe(false)
    expect(g.text).toBe('官方插件目录需要登录——请先在「我的 → 账号」登录启禾云账号后重试')
  })

  it('NOT_DEPLOYED → 标未就绪且可重试（服务端部署后手点一次即可）', () => {
    const g = catalogErrorGuidance('NOT_DEPLOYED：官方插件目录服务未就绪（HTTP 404）——服务端尚未部署该功能')
    expect(g.notDeployed).toBe(true)
    expect(g.loginRequired).toBe(false)
    expect(g.retryable).toBe(true)
  })

  it('NO_SERVER / CATALOG_UNAVAILABLE → 可重试；无码错误原样展示且可重试', () => {
    expect(catalogErrorGuidance('NO_SERVER：当前未配置云服务地址').retryable).toBe(true)
    expect(catalogErrorGuidance('CATALOG_UNAVAILABLE：官方插件目录获取失败（HTTP 500）').code).toBe(
      'CATALOG_UNAVAILABLE',
    )
    const bare = catalogErrorGuidance('未知错误')
    expect(bare.code).toBe('')
    expect(bare.text).toBe('未知错误')
    expect(bare.retryable).toBe(true)
  })
})

describe('formatPluginSize / summarizeCatalogPermissions', () => {
  it('体积：B / KB / MB 三档；服务端没给数 → —', () => {
    expect(formatPluginSize(undefined)).toBe('—')
    expect(formatPluginSize(512)).toBe('512 B')
    expect(formatPluginSize(2048)).toBe('2.0 KB')
    expect(formatPluginSize(1_572_864)).toBe('1.5 MB')
  })

  it('permissions 摘要：* 醒目、逐项列名、无声明给「未声明」', () => {
    expect(summarizeCatalogPermissions(undefined)).toBe('未声明')
    expect(summarizeCatalogPermissions({ network: ['*'] })).toContain('任意网络域名')
    expect(summarizeCatalogPermissions({ network: ['api.example.com'] })).toBe('网络 api.example.com')
    expect(
      summarizeCatalogPermissions({ clipboard: true, notification: true, account: true, customers: true, share: true }),
    ).toBe('剪贴板、系统通知、账号登录态、客户档案、局域网共享')
  })
})

describe('管理页接线（源码级门禁；本仓既有做法 = 源码包含性断言）', () => {
  const src = fs.readFileSync(path.join(ROOT, PAGE), 'utf-8')

  it('官方目录区块实装（不再是「即将上线」占位）', () => {
    expect(src).toContain('官方插件目录')
    expect(src).toContain('fetchPluginCatalog')
    expect(src).toContain('deriveCatalogRows')
    expect(src).toContain('可更新')
    expect(src).toContain('不兼容')
    expect(src).not.toContain('即将上线')
  })

  it('未登录 → 引导登录（去登录）；失败 → 重试入口', () => {
    expect(src).toContain('catalogGuidance')
    expect(src).toContain('去登录')
    expect(src).toContain('重试')
  })

  it('更新后重启提示接线：立即重启 → relaunchApp（qihebox:app:relaunch）/ 稍后', () => {
    expect(src).toContain('buildRestartNotice')
    expect(src).toContain('relaunchApp')
    expect(src).toContain('立即重启')
    expect(src).toContain('稍后')
    // 安装前快照（更新判定 = 同 id 已存在）：两条安装路径各自取快照
    expect(src.match(/const before = plugins\(\)/g)?.length).toBe(2)
  })

  it('目录安装走官方索引形态（downloadUrl + sha256），侧载仍走 filePath', () => {
    expect(src).toContain('installPlugin({ downloadUrl: selected.downloadUrl, sha256: selected.sha256 })')
    expect(src).toContain('installPlugin({ filePath })')
  })
})