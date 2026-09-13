/**
 * 复制反馈统一（v2.5.8 D19 / 体验批 B1）的单测。
 *
 * B1 的缺陷形状是「同一个复制动作三种反馈」：四处内联条、两处只在失败时出声、
 * 五处右键复制**成功失败全静默**。这里钉的就是新口径本身——
 * **成功与失败都必须出声，空选区必须不出声**，撤掉任何一半都得红。
 *
 * 分两层（同 `lib/previewNav` 那条分层）：
 *  - `lib/copyFeedback.ts` 纯文案：`已复制 N 个文件到剪贴板` 这句一字不能改
 *    （`tests/e2e/clipboard-guard.spec.ts:105/234` 靠它判定 Ctrl+C 走的是文件复制路径）；
 *  - `utils/copyAction.ts` 动作：复制函数注入，所以「弹了什么」在 node 环境里可读（`banner()`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COPY_ERROR_FALLBACK,
  COPY_ERROR_TITLE,
  COPY_NOUN,
  copyFeedbackTitle,
  copyFeedbackToast,
} from '../../src/renderer/src/lib/copyFeedback'
import { copyFilesWithFeedback, copyLedgerFiles } from '../../src/renderer/src/utils/copyAction'
import { banner, showToast } from '../../src/renderer/src/stores/notifyBanner'

describe('copyFeedbackTitle（文案单点）', () => {
  it('数量与量词拼成既有那句（e2e 靠这句定位，改词即断线索）', () => {
    expect(copyFeedbackTitle(1)).toBe('已复制 1 个文件到剪贴板')
    expect(copyFeedbackTitle(12)).toBe('已复制 12 个文件到剪贴板')
    expect(copyFeedbackTitle(2, COPY_NOUN.note)).toBe('已复制 2 篇笔记到剪贴板')
  })

  it('零或负数返回空串 = 不弹任何东西（空选区按 Ctrl+C 保持静默）', () => {
    expect(copyFeedbackTitle(0)).toBe('')
    expect(copyFeedbackTitle(-1)).toBe('')
  })
})

describe('copyFeedbackToast（成功失败都出声）', () => {
  it('成功 → success 档 + 计数文案', () => {
    expect(copyFeedbackToast(3, { success: true })).toEqual({
      tone: 'success',
      title: '已复制 3 个文件到剪贴板',
    })
  })

  it('失败 → error 档 + IPC 给的原因做 body', () => {
    expect(copyFeedbackToast(3, { success: false, error: 'xclip 不可用' })).toEqual({
      tone: 'error',
      title: COPY_ERROR_TITLE,
      body: 'xclip 不可用',
    })
  })

  it('失败且没给原因 → 兜底文案（不能显示 undefined）', () => {
    const t = copyFeedbackToast(1, { success: false })
    expect(t?.tone).toBe('error')
    expect(t?.body).toBe(COPY_ERROR_FALLBACK)
  })

  it('空选区返回 null（调用方不弹）', () => {
    expect(copyFeedbackToast(0, { success: true })).toBeNull()
  })

  it('IPC 整条没回（null）也按失败出声，不许静默', () => {
    const t = copyFeedbackToast(2, null)
    expect(t?.tone).toBe('error')
    expect(t?.title).toBe(COPY_ERROR_TITLE)
  })
})

describe('copyFilesWithFeedback（动作层真弹 toast）', () => {
  // `banner` 是**模块级信号**（全站单例），跨用例不会自己复位：上一条用例弹的 toast 会漏到下一条，
  // 于是「空选区不该弹」会被前一条的残留弹错成红。所以每例先把 banner 清成 null 再起跑——
  // 手法就是用一条哨兵 toast 顶掉旧状态、再按 3s 走完它的自动消失（store 没导出 reset，不为此加导出）。
  const resetBanner = (): void => {
    showToast('info', '__reset__')
    vi.advanceTimersByTime(3000)
    expect(banner()).toBeNull()
  }
  beforeEach(() => {
    vi.useFakeTimers()
    resetBanner()
  })
  afterEach(() => {
    // 作废未触发的自动消失定时器，别让它跨用例写 banner
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const copyOk = async (paths: string[]) => ({ success: true, data: paths.length })
  const copyFail = async () => ({ success: false, error: 'PowerShell 退出码 1' })

  it('成功：调复制函数一次并弹 success toast', async () => {
    const spy = vi.fn(copyOk)
    const ok = await copyFilesWithFeedback(spy, ['a.png', 'b.png'])
    expect(ok).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(banner()).toEqual({
      tone: 'success',
      title: '已复制 2 个文件到剪贴板',
      body: undefined,
    })
  })

  it('失败：弹 error toast 并把原因带进 body', async () => {
    const ok = await copyFilesWithFeedback(copyFail, ['a.png'])
    expect(ok).toBe(false)
    expect(banner()?.tone).toBe('error')
    expect(banner()?.title).toBe(COPY_ERROR_TITLE)
    expect(banner()?.body).toBe('PowerShell 退出码 1')
  })

  it('复制函数抛异常：不吞、转成失败反馈（旧写法这里既不出声也不报错）', async () => {
    const ok = await copyFilesWithFeedback(async () => {
      throw new Error('剪贴板被占用')
    }, ['a.png'])
    expect(ok).toBe(false)
    expect(banner()?.tone).toBe('error')
    expect(banner()?.body).toBe('剪贴板被占用')
  })

  it('空选区：一个字节都不碰剪贴板，也不弹', async () => {
    const spy = vi.fn(copyOk)
    const ok = await copyFilesWithFeedback(spy, [])
    expect(ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(banner()).toBeNull()
  })

  it('toast 默认 3s 自动消失（沿用全站反馈时长口径）', async () => {
    await copyFilesWithFeedback(copyOk, ['a.png'])
    expect(banner()).not.toBeNull()
    vi.advanceTimersByTime(3000)
    expect(banner()).toBeNull()
  })
})

/**
 * 台账（发票/入库/报价）批量条的复制面。与上面同一套复位手法：`banner` 是模块级单例信号。
 */
describe('copyLedgerFiles（台账行的复制，v2.5.8 D19 / B2②）', () => {
  interface Row {
    number: string
    file_path: string | null
  }
  const pick = (r: Row): string | undefined => r.file_path ?? undefined

  const resetBanner = (): void => {
    showToast('info', '__reset__')
    vi.advanceTimersByTime(3000)
    expect(banner()).toBeNull()
  }
  beforeEach(() => {
    vi.useFakeTimers()
    resetBanner()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('选中行都有归档文件 → 复制并弹全站同一句文案', async () => {
    const spy = vi.fn(async (paths: string[]) => ({ success: true, data: paths.length }))
    const ok = await copyLedgerFiles(spy, [{ number: 'A', file_path: '/x/a.pdf' }], pick)
    expect(ok).toBe(true)
    expect(spy).toHaveBeenCalledWith(['/x/a.pdf'])
    expect(banner()?.title).toBe('已复制 1 个文件到剪贴板')
  })

  it('部分行没有归档文件 → 只复制有的那些，数量按实际报（不拿 0 条目去弄挂整批）', async () => {
    const spy = vi.fn(async (paths: string[]) => ({ success: true, data: paths.length }))
    await copyLedgerFiles(spy, [{ number: 'A', file_path: null }, { number: 'B', file_path: '/x/b.pdf' }], pick)
    expect(spy).toHaveBeenCalledWith(['/x/b.pdf'])
    expect(banner()?.title).toBe('已复制 1 个文件到剪贴板')
  })

  it('选中行全都没有归档文件 → 如实说一句并且不碰剪贴板（静默按钮就是 B1 要清的那笔账）', async () => {
    const spy = vi.fn(async (paths: string[]) => ({ success: true, data: paths.length }))
    const ok = await copyLedgerFiles(spy, [{ number: 'A', file_path: null }], pick)
    expect(ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(banner()?.title).toBe('选中的 1 行都没有归档文件')
  })

  it('零选中 → 整条静默（批量条本身不显示，不该冒一句「选中的 0 行」）', async () => {
    const spy = vi.fn(async (paths: string[]) => ({ success: true, data: paths.length }))
    const ok = await copyLedgerFiles(spy, [], pick)
    expect(ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(banner()).toBeNull()
  })
})
