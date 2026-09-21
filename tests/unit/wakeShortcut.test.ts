import { describe, it, expect, vi } from 'vitest'
import { WAKE_SEARCH_ACCELERATOR, applyWakeShortcut, reconcileWakeShortcut, type WakeShortcutPort } from '../../src/main/core/wakeShortcut'

/**
 * 全局唤醒快捷键（v2.5.9 A6-1）纯逻辑单测——不起 Electron。
 *
 * 反向实验口径（`DEBUG-SOP.md` §三）：每条分支都要能被打动——包括"注册失败"这条**最容易被
 * 写成静默通过**的路径（真实场景 = 键被别的程序占了）。
 */
function port(overrides: Partial<WakeShortcutPort> = {}): WakeShortcutPort & {
  register: ReturnType<typeof vi.fn>
  unregister: ReturnType<typeof vi.fn>
  isRegistered: ReturnType<typeof vi.fn>
} {
  const registered = new Set<string>()
  const base = {
    isRegistered: vi.fn((a: string) => registered.has(a)),
    register: vi.fn((a: string) => {
      registered.add(a)
      return true
    }),
    unregister: vi.fn((a: string) => {
      registered.delete(a)
    }),
  }
  return Object.assign(base, overrides) as never
}

describe('全局唤醒快捷键 applyWakeShortcut（v2.5.9 A6-1）', () => {
  it('开关开 + 未注册 ⇒ 注册，返回 registered', () => {
    const p = port()
    expect(applyWakeShortcut(true, p)).toBe('registered')
    expect(p.register).toHaveBeenCalledWith(WAKE_SEARCH_ACCELERATOR)
    expect(p.isRegistered(WAKE_SEARCH_ACCELERATOR)).toBe(true)
  })

  it('反向实验：注册失败（被别的程序占用）⇒ 返回 unsupported，不假装成功', () => {
    const p = port({ register: vi.fn(() => false) as never })
    expect(applyWakeShortcut(true, p)).toBe('unsupported')
  })

  it('开关关 + 已注册 ⇒ 注销，返回 disabled', () => {
    const p = port()
    applyWakeShortcut(true, p)
    expect(applyWakeShortcut(false, p)).toBe('disabled')
    expect(p.unregister).toHaveBeenCalledWith(WAKE_SEARCH_ACCELERATOR)
    expect(p.isRegistered(WAKE_SEARCH_ACCELERATOR)).toBe(false)
  })

  it('开关关 + 未注册 ⇒ disabled 且不调用 unregister（幂等，不碰系统）', () => {
    const p = port()
    expect(applyWakeShortcut(false, p)).toBe('disabled')
    expect(p.unregister).not.toHaveBeenCalled()
    expect(p.register).not.toHaveBeenCalled()
  })

  it('开关开 + 已注册 ⇒ registered 且不重复注册（幂等）', () => {
    const p = port()
    applyWakeShortcut(true, p)
    p.register.mockClear()
    expect(applyWakeShortcut(true, p)).toBe('registered')
    expect(p.register).not.toHaveBeenCalled()
  })

  it('加速键常量与设置页展示同源（唯一真相在 shared/appSettings.ts）', () => {
    // 展示形态是人读的 `Ctrl+Alt+S`，注册形态是 Electron 的 `Control+Alt+S`：两者
    // v2.5.9：键位从 K 换到 S（用户拍板"K 换别的吧"）。这里**两处都钉**：
    //   ① 常量值本身（换键必须显式改这里，逼你看见）② LABEL 与 ACCELERATOR 的对应关系（防漂移）必须指同一个键
    expect(WAKE_SEARCH_ACCELERATOR).toBe('Control+Alt+S')
  })
})

describe('reconcileWakeShortcut：只有开关真翻转才动系统注册（v2.5.9 A6-1）', () => {
  it('关 → 开 ⇒ 注册', () => {
    const p = port()
    expect(reconcileWakeShortcut(false, true, p)).toBe('registered')
  })

  it('开 → 关 ⇒ 注销', () => {
    const p = port()
    applyWakeShortcut(true, p)
    expect(reconcileWakeShortcut(true, false, p)).toBe('disabled')
  })

  it('反向实验：开着再保存一次（true → true）⇒ 返回 null，既不注销也不重注册', () => {
    const p = port()
    applyWakeShortcut(true, p)
    p.register.mockClear()
    p.unregister.mockClear()
    expect(reconcileWakeShortcut(true, true, p)).toBeNull()
    expect(p.register).not.toHaveBeenCalled()
    expect(p.unregister).not.toHaveBeenCalled()
  })

  it('关着再保存一次（false → false）⇒ 返回 null', () => {
    const p = port()
    expect(reconcileWakeShortcut(false, false, p)).toBeNull()
    expect(p.register).not.toHaveBeenCalled()
  })
})