/**
 * 应用级设置扩充单测（v2.5.8 D11 / W7）。
 *
 * 三层各钉一件事：
 *  - `shared/appSettings.ts` 纯函数：默认值 = 现行行为、脏数据回落、补丁白名单与档位校验；
 *  - `main/settings.ts` 落盘：改 → 写盘 → **重开实例读到新值**（= 「重启生效」的最小组合，
 *    覆盖旧 devMode 形状与新键共存）；
 *  - `notify.withinReminderWindow`：30 天原样、14/7 对称收窄、非法日期不误伤、发票待办不受影响。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  APP_SETTINGS_DEFAULTS,
  CERT_REMINDER_DAY_CHOICES,
  isAppSettingsKey,
  mergeAppSettings,
  resolveAppSettings,
} from '../../src/shared/appSettings'
import { createSettings } from '../../src/main/settings'
import { composeDailyNotification, withinReminderWindow } from '../../src/main/notify'

describe('应用级设置默认值表（W7：默认 = 现行行为）', () => {
  it('每个开关的默认值都是「开关化之前」的行为档位', () => {
    // 关窗驻留托盘 / 自动检查更新 / 悬浮浮条 / 剪贴板守卫 / 证书提醒：历史上都是「开着」的
    expect(APP_SETTINGS_DEFAULTS).toMatchObject({
      devMode: false,
      closeToTray: true,
      autoUpdateCheck: true,
      selectionBar: true,
      clipboardGuard: true,
      certReminder: true,
      certReminderDays: 30,
    })
  })

  it('老文件（只有 devMode）读出来其余全是默认值', () => {
    expect(resolveAppSettings({ devMode: true })).toEqual({ ...APP_SETTINGS_DEFAULTS, devMode: true })
  })

  it('脏数据逐键回落默认，不整体失效也不抛', () => {
    const dirty = { closeToTray: 'yes', selectionBar: 1, certReminderDays: 0, devMode: null }
    expect(resolveAppSettings(dirty as never)).toEqual(APP_SETTINGS_DEFAULTS)
    expect(resolveAppSettings(null)).toEqual(APP_SETTINGS_DEFAULTS)
    expect(resolveAppSettings([] as never)).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('档位外天数回落 30（防手改 json 把提醒窗口调成 0 天）', () => {
    for (const bad of [0, 1, 15, 31, -7, Number.NaN, '30']) {
      expect(resolveAppSettings({ certReminderDays: bad as never }).certReminderDays).toBe(30)
    }
    for (const ok of CERT_REMINDER_DAY_CHOICES) {
      expect(resolveAppSettings({ certReminderDays: ok }).certReminderDays).toBe(ok)
    }
  })

  it('通道是任意键写入口的闸门：只认表内键', () => {
    expect(isAppSettingsKey('selectionBar')).toBe(true)
    expect(isAppSettingsKey('certReminderDays')).toBe(true)
    for (const evil of ['__proto__', 'workspacePath', 'constructor', 'devmode', '']) {
      expect(isAppSettingsKey(evil), evil).toBe(false)
    }
  })
})

describe('mergeAppSettings：只落差异、按类型闸门收补丁', () => {
  it('写默认值 = 删键（json 精简，回滚只需删键）', () => {
    const next = mergeAppSettings({ devMode: true }, { closeToTray: true, selectionBar: false })
    expect(next).toEqual({ devMode: true, selectionBar: false }) // closeToTray 与默认同 → 不落盘
  })

  it('未知键与类型不符的值整键忽略', () => {
    const next = mergeAppSettings(
      {},
      { selectionBar: 'no', certReminderDays: 5, nope: true } as never,
    )
    expect(next).toEqual({})
  })

  it('补丁只动指定键，其余保留原落盘值', () => {
    const next = mergeAppSettings({ certReminder: false, devMode: true }, { autoUpdateCheck: false })
    expect(next).toEqual({ devMode: true, certReminder: false, autoUpdateCheck: false })
  })
})

describe('createSettings 落盘：改 → 持久化 → 重开实例读到新值', () => {
  let dir: string
  it('新键写入后新建实例（= 重启）仍读到；写默认值等于删键', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-settings-w7-'))
    const s = createSettings(dir)
    expect(s.getAll()).toEqual(APP_SETTINGS_DEFAULTS) // 空目录 = 全默认

    const after = await s.set({ selectionBar: false, certReminderDays: 7 })
    expect(after.selectionBar).toBe(false)
    expect(after.certReminderDays).toBe(7)
    // 磁盘上确实落盘（不是内存信号）
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')) as Record<string, unknown>
    expect(raw).toEqual({ selectionBar: false, certReminderDays: 7 })
    // 重开实例 = 重启生效
    expect(createSettings(dir).getAll()).toMatchObject({ selectionBar: false, certReminderDays: 7 })

    // 改回默认值 → 键被删掉（回滚语义）
    await s.set({ selectionBar: true, certReminderDays: 30 })
    expect(createSettings(dir).getAll()).toEqual(APP_SETTINGS_DEFAULTS)
  })

  it('与既有 devMode 共存：两条写路径互不抹键', async () => {
    const s = createSettings(dir)
    await s.setDevMode(true)
    expect(s.getAll().devMode).toBe(true)
    await s.set({ clipboardGuard: false })
    expect(s.getDevMode()).toBe(true) // set 通道没碰 devMode
    expect(s.getAll().clipboardGuard).toBe(false)
  })

  it('坏 json 不炸启动路径：读回落默认，写拒绝覆盖并备份留证（隔离后重试可恢复）', async () => {
    const corrupt = '{ 这不是 json'
    fs.writeFileSync(path.join(dir, 'settings.json'), corrupt)
    const s = createSettings(dir)
    // —— 读侧：回落默认，且**不动原文件**（只读不破坏现场，与 paths.readJsonFile 同口径）
    expect(s.getAll()).toEqual(APP_SETTINGS_DEFAULTS)
    expect(s.getDevMode()).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe(corrupt)
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.corrupt-'))).toEqual([])
    // —— 写侧：不再拿默认值静默整体覆盖，而是隔离备份 + 抛错（渲染层经 ApiResult 拿到 error）
    await expect(s.set({ certReminder: false })).rejects.toThrow(/损坏|覆盖/)
    const backups = fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf-8')).toBe(corrupt)
    // —— 恢复路径：损坏文件已被隔离，重试即落新值（用户偏好不再是无声丢失）
    await s.set({ certReminder: false })
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'))).toEqual({ certReminder: false })
    expect(createSettings(dir).getAll().certReminder).toBe(false)
  })
})

describe('createSettings 写盘纪律：按路径串行 + 形态闸门（v2.5.8 复审 A-5 修复）', () => {
  it('并发写不丢更新：同一路径多路 set / setDevMode 各自基于最新落盘值合并', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-settings-race-'))
    const s = createSettings(dir)
    await Promise.all([
      s.set({ selectionBar: false }),
      s.setDevMode(true),
      s.set({ clipboardGuard: false }),
      s.set({ certReminderDays: 7 }),
      s.set({ certReminder: false }),
    ])
    // 修复前：五路都在第一个 await 前同步读到同一份旧快照，最终只剩最后一次 rename 的那个键
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'))).toEqual({
      selectionBar: false,
      devMode: true,
      clipboardGuard: false,
      certReminderDays: 7,
      certReminder: false,
    })
    const after = createSettings(dir).getAll()
    expect(after).toEqual({
      ...APP_SETTINGS_DEFAULTS,
      devMode: true,
      selectionBar: false,
      clipboardGuard: false,
      certReminder: false,
      certReminderDays: 7,
    })
  })

  it('合法 json 但不是设置形状（数组）也按损坏处理：留证 + 拒绝覆盖，不写出半截结构', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-settings-array-'))
    fs.writeFileSync(path.join(dir, 'settings.json'), '["devMode"]')
    const s = createSettings(dir)
    expect(s.getAll()).toEqual(APP_SETTINGS_DEFAULTS) // 读侧仍按空设置兜默认
    await expect(s.set({ certReminder: false })).rejects.toThrow(/结构非法|损坏|覆盖/)
    const backups = fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf-8')).toBe('["devMode"]')
  })
})

describe('withinReminderWindow / 通知文案（W7 提前天数）', () => {
  const now = new Date(2026, 7, 9, 12, 0, 0)
  const expiring: [string, string, string][] = [
    ['近', 'a.jpg', '2026-08-12'], // +3d
    ['中', 'b.jpg', '2026-08-20'], // +11d
    ['远', 'c.jpg', '2026-09-05'], // +27d
    ['已过期三天', 'd.jpg', '2026-08-06'], // -3d
    ['过期四十天', 'e.jpg', '2026-07-01'], // 脏窗口外
    ['日期坏', 'f.jpg', '不是日期'],
  ]

  it('30 天 = 原样返回（默认零行为变更）', () => {
    expect(withinReminderWindow(expiring, 30, now)).toBe(expiring)
  })

  it('14 / 7 天对称收窄：已过期但未超同样天数的仍提醒，坏日期不误伤', () => {
    expect(withinReminderWindow(expiring, 7, now).map((r) => r[0])).toEqual([
      '近',
      '已过期三天',
      '日期坏',
    ])
    expect(withinReminderWindow(expiring, 14, now).map((r) => r[0])).toEqual([
      '近',
      '中',
      '已过期三天',
      '日期坏',
    ])
  })

  it('摘要文案的天数跟随设置（默认 30 与旧文案逐字一致）', () => {
    const two: [string, string, string][] = expiring.slice(0, 2)
    expect(composeDailyNotification(two, [])?.body).toContain('另有 1 张将在 30 天内到期')
    expect(composeDailyNotification(two, [], 7)?.body).toContain('另有 1 张将在 7 天内到期')
    // 单张时走另一条文案分支，不出现天数措辞 → 传天数也不变
    expect(composeDailyNotification([two[0]], [])?.body).toContain('将于 2026-08-12 到期')
  })
})
