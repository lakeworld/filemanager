/**
 * 证书到期提醒天数（v2.5.8 D11 / W7 `certReminderDays`）——**边界**与**非法值回退**的常驻断言。
 *
 * 与既有覆盖的分工（刻意不重复，先看这三处再回来看本文件）：
 *  - `appSettings.test.ts` 钉 `resolveAppSettings` 纯函数（档位外 → 30）与 `withinReminderWindow`
 *    在 +3 / +11 / +27 / -3 上的对称收窄；
 *  - `dashboard.test.ts` 钉 `checkExpiringCerts` 自己的 ±30 天硬窗口；
 *  - `tests/e2e/app-settings.spec.ts` 钉设置页选「7 天」→ 落盘 → 真重启读回。
 *
 * 本文件补它们之间没连起来的三件事：
 *  ① **恰好等于档位那天**的边界（实现是闭区间 `<=`）：既有 fixture 的偏移量从没落在 ±7 / ±14 / ±30 上，
 *    把 `<=` 误写成 `<` 时它们全绿；
 *  ② **非法值走真实读盘路径**（`createSettings` 而非直接调纯函数）回落到默认档，并且**反证**
 *    「回落 30」与「原样透传 0」在提醒结果上不是一回事——0 会把窗口塌成只剩今天到期 + 坏日期，
 *    等于事实上的永不提醒；
 *  ③ **回落后的行为 ≡ 30 档行为**：脏值不只是"读出来是 30"，而是提醒清单与 30 档逐条相同。
 *
 * 可复现性：日期用 2026 年 8 月的**固定**日期（不用「今天 + N 天」），`now` 取本地 00:00，
 * 到期日经 `parseExpiryDate` 同为本地 00:00 → 差值恰为 N×86400000ms；8 月不落在任何主要时区的
 * 夏令时切换周，故 ±N 天边界的断言跨机、跨 TZ 都成立。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveAppSettings } from '../../src/shared/appSettings'
import { createSettings } from '../../src/main/settings'
import { withinReminderWindow } from '../../src/main/notify'

const DAY = 24 * 60 * 60 * 1000
/** 固定的「今天」：本地 00:00，与 parseExpiryDate 的解析口径同型 */
const NOW = new Date(2026, 7, 9)

/** NOW 之后 n 天的本地日期（n 为负 = 已过期） */
function dateInDays(n: number): string {
  const d = new Date(NOW.getTime() + n * DAY)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 边界样本：三档的 ±边界当天与边界外一天，外加「今天到期」与一个坏日期 */
const OFFSETS = [-31, -30, -15, -14, -8, -7, 0, 7, 8, 14, 15, 30, 31] as const

type Row = [string, string, string]
const ROWS: Row[] = [
  ...OFFSETS.map((n): Row => [`档${n >= 0 ? '后' : '前'}${Math.abs(n)}天`, `${n}.jpg`, dateInDays(n)]),
  ['坏日期', 'bad.jpg', '不是日期'],
]

/** 名单只取文件名槽位，红了才好读 */
const names = (rows: Row[]): string[] => rows.map((r) => r[1])

/**
 * 闭区间的期望清单（**硬编码**，不用实现里的同一条规则现算，否则等于自证）。
 * 注意 30 档是**透传档**：`withinReminderWindow` 对 `days >= 30` 直接返回原清单，
 * ±30 的裁剪住在上游 `checkExpiringCerts`（见 dashboard.test.ts），所以这里 30 档期望 = 全量。
 */
function expectWithin(days: number): string[] {
  if (days >= 30) return [...OFFSETS.map((n) => `${n}.jpg`), 'bad.jpg']
  const kept = OFFSETS.filter((n) => Math.abs(n) <= days).map((n) => `${n}.jpg`)
  return [...kept, 'bad.jpg'] // 解析失败的按现行宽松策略保留（不误伤）
}

/** 写一份 settings.json 到临时 userData 目录，返回该目录（tmpTracker 统一兜底清理） */
function userDataWith(raw: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-certdays-'))
  fs.writeFileSync(path.join(dir, 'settings.json'), raw)
  return dir
}

describe('certReminderDays：三档各自的边界（恰等于档位的当天必须提醒）', () => {
  // 30 档这一行是「全量透传」，与 appSettings.test.ts 的 `30 = 原样返回` 同向（刻意保留：
  // 本文件下方「脏值回落后的清单 ≡ 30 档清单」要用它做等值比较的右端，缺了就比不成）。
  for (const days of [7, 14, 30] as const) {
    it(`${days} 天档：|偏移| <= ${days} 的全部保留、> ${days} 天的不保留、坏日期不误伤`, () => {
      expect(names(withinReminderWindow(ROWS, days, NOW))).toEqual(expectWithin(days))
    })
  }

  it('7 与 14 档确实在边界处收窄（±8 天被剔出、±7 天仍在——不是整档失效）', () => {
    const d7 = names(withinReminderWindow(ROWS, 7, NOW))
    const d14 = names(withinReminderWindow(ROWS, 14, NOW))
    expect(d7).toContain('-7.jpg')
    expect(d7).toContain('7.jpg')
    expect(d7).not.toContain('-8.jpg')
    expect(d7).not.toContain('8.jpg')
    expect(d14).toContain('-14.jpg')
    expect(d14).toContain('14.jpg')
    expect(d14).not.toContain('-15.jpg')
    expect(d14).not.toContain('15.jpg')
  })

  it('比 30 更宽的档位外值也走"不收窄"分支（>= 30 短路），不出现空清单', () => {
    expect(names(withinReminderWindow(ROWS, 90, NOW))).toEqual(names(ROWS))
  })
})

describe('certReminderDays：配置文件里的非法值端到端回落默认档', () => {
  // 0 / 负数 / 非数字 / 三档之外的值：JSON 里怎么写都算脏
  const DIRTY = ['0', '-7', '-0.5', '15', '31', '"30"', '"14"', 'true', 'false', 'null', '[]', '{}', '1e309']

  for (const json of DIRTY) {
    it(`settings.json 写 certReminderDays: ${json} → 读回默认 30，且不因脏数据改变行为`, () => {
      const dir = userDataWith(`{"certReminderDays":${json}}`)
      const all = createSettings(dir).getAll()
      expect(all.certReminderDays).toBe(30)
      // 脏值不污染其余键（同一份文件里的其它键照常按默认读）
      expect(all).toEqual(resolveAppSettings({ certReminderDays: JSON.parse(json) as never }))
    })
  }

  it('回落后的**提醒结果** ≡ 30 档：脏值既不塌成"永不提醒"，也不原样透传', () => {
    const dir = userDataWith('{"certReminderDays":0}')
    const days = createSettings(dir).getAll().certReminderDays
    expect(names(withinReminderWindow(ROWS, days, NOW))).toEqual(expectWithin(30))
  })

  it('反证（本文件自带的判别力）：0 天真会被当成"几乎永不提醒"——所以回落必须是 30 而不是 0', () => {
    const collapsed = names(withinReminderWindow(ROWS, 0, NOW))
    expect(collapsed).toEqual(['0.jpg', 'bad.jpg'])
    expect(collapsed).not.toContain('7.jpg') // 7 天后到期的证书在 0 档下静默漏提醒
    expect(collapsed.length).toBeLessThan(ROWS.length)
  })

  it('写通道也拒收脏值：set(0) 返回 30 且磁盘上不留脏键', async () => {
    const dir = userDataWith('{}')
    const after = await createSettings(dir).set({ certReminderDays: 0 })
    expect(after.certReminderDays).toBe(30)
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')) as Record<string, unknown>
    expect('certReminderDays' in raw).toBe(false)
  })

  it('三档合法值各自落盘并读回（0 之外的档位不被误判为脏）', async () => {
    for (const days of [30, 14, 7] as const) {
      const dir = userDataWith('{}')
      const after = await createSettings(dir).set({ certReminderDays: days })
      expect(after.certReminderDays).toBe(days)
      expect(names(withinReminderWindow(ROWS, after.certReminderDays, NOW))).toEqual(expectWithin(days))
    }
  })
})
