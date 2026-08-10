/**
 * 通知横幅 store 单测（v2.4.3 F7）：showToast 设置/顶替/自动消失、tone 与时长、证书提醒保持红色 15s。
 * 纯信号 + 定时器逻辑，不依赖 Electron / DOM。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { banner, showToast, showCertReminder } from '../../src/renderer/src/stores/notifyBanner'

describe('通知横幅（notifyBanner）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('showToast 显示指定 tone / title / body', () => {
    showToast('success', '元数据已保存')
    expect(banner()).toEqual({ tone: 'success', title: '元数据已保存', body: undefined })

    showToast('error', '保存失败', '磁盘错误')
    expect(banner()).toEqual({ tone: 'error', title: '保存失败', body: '磁盘错误' })
  })

  it('新 toast 顶掉旧 toast（旧定时器作废）', () => {
    showToast('success', '先到的提示', undefined, 3000)
    showToast('error', '后到的提示')
    expect(banner()?.title).toBe('后到的提示')
    // 旧 toast 的 3s 定时器已被作废，新 toast 的 3s 到时后才消失
    vi.advanceTimersByTime(3000)
    expect(banner()).toBeNull()
  })

  it('默认 3s 自动消失；自定义时长生效', () => {
    showToast('success', 'x', undefined, 3000)
    vi.advanceTimersByTime(2999)
    expect(banner()).not.toBeNull()
    vi.advanceTimersByTime(2)
    expect(banner()).toBeNull()

    showToast('error', 'y', undefined, 15000)
    vi.advanceTimersByTime(15000)
    expect(banner()).toBeNull()
  })

  it('证书提醒：error 红色 15s（原行为不变）', () => {
    showCertReminder([['产品A', '证书.pdf', '2026-09-01']])
    expect(banner()).toEqual({
      tone: 'error',
      title: '证书到期提醒（1 张）',
      body: '证书.pdf 于 2026-09-01 到期',
    })
    vi.advanceTimersByTime(15000)
    expect(banner()).toBeNull()
  })
})
