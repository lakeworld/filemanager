/**
 * 证书到期通知去重单测（v2.4.0）：computeNotifiable 纯函数。
 * 同一天不重复通知、次日可再通知、空列表/已全通知边界。
 */
import { describe, expect, it } from 'vitest'
import { computeNotifiable, localDateString, type NotifyState } from '../../src/main/notify'

// 固定基准时刻（本地时区 2026-08-09 中午）
const base = new Date(2026, 7, 9, 12, 0, 0)

describe('证书到期通知去重（computeNotifiable）', () => {
  it('同一天已通知过的证书不重复，未通知的照常列出', () => {
    const state: NotifyState = { date: '2026-08-09', keys: ['系列A/a.jpg'] }
    const expiring: [string, string, string][] = [
      ['系列A', 'a.jpg', '2026-09-01'],
      ['系列B', 'b.jpg', '2026-09-02'],
    ]
    const r = computeNotifiable(expiring, state, base)
    expect(r.toNotify).toEqual([['系列B', 'b.jpg', '2026-09-02']])
    // nextState 保留当天已通知 keys（含本次新增），供落盘
    expect(r.nextState).toEqual({ date: '2026-08-09', keys: ['系列A/a.jpg', '系列B/b.jpg'] })
  })

  it('次日可再次通知（跨天状态复位）', () => {
    const state: NotifyState = { date: '2026-08-08', keys: ['系列A/a.jpg'] }
    const expiring: [string, string, string][] = [['系列A', 'a.jpg', '2026-09-01']]
    const r = computeNotifiable(expiring, state, base)
    expect(r.toNotify).toHaveLength(1)
    expect(r.toNotify[0][0]).toBe('系列A')
  })

  it('无到期证书 / 当天已全部通知 → 无可通知', () => {
    // 无到期证书
    expect(computeNotifiable([], null, base).toNotify).toHaveLength(0)
    // 当天已全部通知
    const state: NotifyState = { date: '2026-08-09', keys: ['系列A/a.jpg'] }
    const r = computeNotifiable([['系列A', 'a.jpg', 'x']], state, base)
    expect(r.toNotify).toHaveLength(0)
    expect(r.nextState.keys).toEqual(['系列A/a.jpg'])
  })

  it('state 为空（首次运行）→ 全部可通知', () => {
    const expiring: [string, string, string][] = [['系列A', 'a.jpg', '2026-09-01']]
    const r = computeNotifiable(expiring, null, base)
    expect(r.toNotify).toHaveLength(1)
    expect(r.nextState).toEqual({ date: '2026-08-09', keys: ['系列A/a.jpg'] })
  })

  it('localDateString 用本地日期（非 UTC）', () => {
    expect(localDateString(new Date(2026, 7, 9, 23, 59))).toBe('2026-08-09')
    expect(localDateString(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05')
  })
})
