import { describe, it, expect } from 'vitest'
import { WindowLifecycle } from '../../src/main/core/windowLifecycle'

/**
 * 窗口生命周期状态机（v2.5.3 热修：删 FrameWitness 隐藏预检，改「先显示、后验证」）
 * 设计依据 `docs/INTERNAL/PLAN-v2.5.3-托盘冻结根治.md`（2026-08-19 事故：隐藏 2.6h 后
 * 软渲染合成器休眠，隐藏态 capturePage 永远抓不到帧 → 预检永远 unknown → 无限弹框唤不醒）。
 *
 * 新语义：starting 双闸门 → visible ↔ parking/parked（show-requested 直接 show，无预检）；
 * 白屏兜底改为显示后像素自检（适配层），确认后喂 blank-confirmed → 可见态 reload 单发收口；
 * 崩溃 → L4 重建 / 无响应 → 隐藏态 L2 reload，收口（load-finished/ready-to-show）直接 show。
 * 全链无任何弹框路径；自检仅武装 parked 恢复 show，recovering 收口 show 不武装（天然收口防循环）。
 */

function toVisible(): WindowLifecycle {
  const ls = new WindowLifecycle()
  ls.handle({ type: 'ready-to-show' })
  ls.handle({ type: 'first-frame-ack', generation: 1 })
  return ls
}

function toParked(): WindowLifecycle {
  const ls = toVisible()
  ls.handle({ type: 'hide-requested', source: 'close' })
  ls.handle({ type: 'parked-ack', generation: 1 })
  return ls
}

describe('WindowLifecycle 冷启动双闸门（starting）', () => {
  it('ready-to-show 先到 → 不显示；首帧 ACK 后 → show(startup) → visible', () => {
    const ls = new WindowLifecycle()
    expect(ls.state()).toBe('starting')
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([])
    const acts = ls.handle({ type: 'first-frame-ack', generation: 1 })
    expect(acts).toEqual([{ kind: 'show', source: 'startup', postShowCheck: false }])
    expect(ls.state()).toBe('visible')
  })

  it('首帧 ACK 先到 → 不显示；ready-to-show 后 → show → visible', () => {
    const ls = new WindowLifecycle()
    expect(ls.handle({ type: 'first-frame-ack', generation: 1 })).toEqual([])
    const acts = ls.handle({ type: 'ready-to-show' })
    expect(acts).toEqual([{ kind: 'show', source: 'startup', postShowCheck: false }])
    expect(ls.state()).toBe('visible')
  })

  it('冷启动期间忽略 hide/show/blank-confirmed/load-finished（窗口未就绪，无处理对象）', () => {
    const ls = new WindowLifecycle()
    expect(ls.handle({ type: 'show-requested', source: 'tray' })).toEqual([])
    expect(ls.handle({ type: 'hide-requested', source: 'close' })).toEqual([])
    expect(ls.handle({ type: 'blank-confirmed' })).toEqual([])
    expect(ls.handle({ type: 'load-finished' })).toEqual([])
    expect(ls.state()).toBe('starting')
  })

  it('非当前 generation 的首帧 ACK 丢弃', () => {
    const ls = new WindowLifecycle()
    expect(ls.handle({ type: 'first-frame-ack', generation: 99 })).toEqual([])
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([])
    expect(ls.state()).toBe('starting')
  })

  it('starting + quit → quitting，后续事件全忽略', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'quit' })
    expect(ls.state()).toBe('quitting')
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([])
    expect(ls.handle({ type: 'show-requested', source: 'tray' })).toEqual([])
  })
})

describe('WindowLifecycle 隐藏链路（visible → parking → parked）', () => {
  it('visible + hide-requested → 发 prepare-hide + hide → parking', () => {
    const ls = toVisible()
    const acts = ls.handle({ type: 'hide-requested', source: 'close' })
    expect(acts).toEqual([
      { kind: 'send', channel: 'window:prepare-hide', generation: 1, source: 'close' },
      { kind: 'hide' },
    ])
    expect(ls.state()).toBe('parking')
  })

  it('parking + 匹配 generation 的 park-ack → parked', () => {
    const ls = toVisible()
    ls.handle({ type: 'hide-requested', source: 'minimize' })
    expect(ls.handle({ type: 'parked-ack', generation: 1 })).toEqual([])
    expect(ls.state()).toBe('parked')
  })

  it('parking + 迟到/旧代 park-ack → 作废（不进入 parked）', () => {
    const ls = toVisible()
    ls.handle({ type: 'hide-requested', source: 'close' })
    expect(ls.handle({ type: 'parked-ack', generation: 999 })).toEqual([])
    expect(ls.state()).toBe('parking')
  })

  it('visible + 非退出类事件（show-requested/load-finished/ready-to-show）→ 忽略', () => {
    const ls = toVisible()
    expect(ls.handle({ type: 'show-requested', source: 'tray' })).toEqual([])
    expect(ls.handle({ type: 'load-finished' })).toEqual([])
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([])
    expect(ls.state()).toBe('visible')
  })
})

describe('WindowLifecycle 恢复链路（直接 show，无预检）', () => {
  it('parked + show-requested → generation+1 → 直接 show(restore) 武装自检 → visible', () => {
    const ls = toParked()
    const acts = ls.handle({ type: 'show-requested', source: 'tray' })
    expect(ls.generation()).toBe(2)
    expect(acts).toEqual([{ kind: 'show', source: 'restore', postShowCheck: true }])
    expect(ls.state()).toBe('visible')
  })

  it('parking + show-requested → show 优先；迟到的旧代 park-ack 被作废', () => {
    const ls = toVisible()
    ls.handle({ type: 'hide-requested', source: 'close' })
    const acts = ls.handle({ type: 'show-requested', source: 'wake' })
    expect(acts).toEqual([{ kind: 'show', source: 'restore', postShowCheck: true }])
    expect(ls.state()).toBe('visible')
    expect(ls.handle({ type: 'parked-ack', generation: 1 })).toEqual([]) // 旧代迟到
    expect(ls.state()).toBe('visible')
  })

  it('连续 hide/show 循环：每次 show 递增 generation，park-ack 按新代匹配', () => {
    const ls = toVisible()
    for (let i = 0; i < 5; i++) {
      ls.handle({ type: 'hide-requested', source: 'close' })
      expect(ls.state()).toBe('parking')
      const acts = ls.handle({ type: 'show-requested', source: 'tray' })
      expect(acts).toEqual([{ kind: 'show', source: 'restore', postShowCheck: true }])
      expect(ls.state()).toBe('visible')
    }
    expect(ls.generation()).toBe(6)
  })
})

describe('WindowLifecycle 显示后白屏自检升级（blank-confirmed）', () => {
  it('visible + blank-confirmed → recovering + 可见态 reload（不 hide：窗口本就白）', () => {
    const ls = toVisible()
    const acts = ls.handle({ type: 'blank-confirmed' })
    expect(acts).toEqual([{ kind: 'reload' }])
    expect(ls.state()).toBe('recovering')
  })

  it('parking/parked + 迟到 blank-confirmed → 零动作（自检竞态守卫：300ms 内再隐藏不升级）', () => {
    const ls = toVisible()
    ls.handle({ type: 'hide-requested', source: 'close' })
    expect(ls.handle({ type: 'blank-confirmed' })).toEqual([])
    expect(ls.state()).toBe('parking')
    ls.handle({ type: 'parked-ack', generation: 1 })
    expect(ls.handle({ type: 'blank-confirmed' })).toEqual([])
    expect(ls.state()).toBe('parked')
  })

  it('quitting + blank-confirmed → 零动作', () => {
    const ls = toVisible()
    ls.handle({ type: 'quit' })
    expect(ls.handle({ type: 'blank-confirmed' })).toEqual([])
    expect(ls.state()).toBe('quitting')
  })

  it('recovering + blank-confirmed → 忽略（收口 show 不武装自检，单发收口防循环）', () => {
    const ls = toVisible()
    ls.handle({ type: 'blank-confirmed' }) // → recovering
    expect(ls.handle({ type: 'blank-confirmed' })).toEqual([])
    expect(ls.state()).toBe('recovering')
  })
})

describe('WindowLifecycle recovering 收口与升级封顶', () => {
  function toRecoveringViaBlank(): WindowLifecycle {
    const ls = toVisible()
    ls.handle({ type: 'blank-confirmed' })
    return ls
  }

  it('L2（blank reload）+ load-finished → 直接 show(restore) 不武装自检 → visible', () => {
    const ls = toRecoveringViaBlank()
    const acts = ls.handle({ type: 'load-finished' })
    expect(acts).toEqual([{ kind: 'show', source: 'restore', postShowCheck: false }])
    expect(ls.state()).toBe('visible')
  })

  it('visible + renderer-unresponsive → 先 hide 再 L2 reload；load-finished 收口 show', () => {
    const ls = toVisible()
    const acts = ls.handle({ type: 'renderer-unresponsive' })
    expect(acts).toEqual([{ kind: 'hide' }, { kind: 'reload' }])
    expect(ls.state()).toBe('recovering')
    expect(ls.handle({ type: 'load-finished' })).toEqual([
      { kind: 'show', source: 'restore', postShowCheck: false },
    ])
    expect(ls.state()).toBe('visible')
  })

  it('visible + renderer-gone → 直接 L4 重建；ready-to-show 收口 show', () => {
    const ls = toVisible()
    const acts = ls.handle({ type: 'renderer-gone' })
    expect(acts).toEqual([{ kind: 'destroyAndRebuild' }])
    expect(ls.state()).toBe('recovering')
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([
      { kind: 'show', source: 'restore', postShowCheck: false },
    ])
    expect(ls.state()).toBe('visible')
  })

  it('recovering + show-requested（用户点托盘）→ 不等收口直接 show → visible', () => {
    const ls = toRecoveringViaBlank()
    const acts = ls.handle({ type: 'show-requested', source: 'tray' })
    expect(acts).toEqual([{ kind: 'show', source: 'restore', postShowCheck: false }])
    expect(ls.state()).toBe('visible')
  })

  it('recovering + hide-requested → 取消恢复归 parking（发 prepare-hide 卸载业务层）', () => {
    const ls = toRecoveringViaBlank()
    const acts = ls.handle({ type: 'hide-requested', source: 'close' })
    expect(acts).toEqual([{ kind: 'send', channel: 'window:prepare-hide', generation: 1, source: 'close' }])
    expect(ls.state()).toBe('parking')
  })

  it('recovering + renderer-gone/unresponsive → 再升级 L4；连续 ≥2 次未回 visible → 封顶零动作', () => {
    const ls = toVisible()
    ls.handle({ type: 'blank-confirmed' }) // streak 1（reload）
    expect(ls.handle({ type: 'renderer-unresponsive' })).toEqual([{ kind: 'destroyAndRebuild' }]) // streak 2
    expect(ls.handle({ type: 'renderer-gone' })).toEqual([]) // 封顶：防无限重建循环
    expect(ls.handle({ type: 'renderer-unresponsive' })).toEqual([])
    expect(ls.state()).toBe('recovering')
    // 用户仍可手动收口：托盘点击直接 show
    expect(ls.handle({ type: 'show-requested', source: 'tray' })).toEqual([
      { kind: 'show', source: 'restore', postShowCheck: false },
    ])
    expect(ls.state()).toBe('visible')
  })

  it('回 visible 后升级计数复位：再次 blank-confirmed 正常出 reload', () => {
    const ls = toRecoveringViaBlank()
    ls.handle({ type: 'renderer-unresponsive' }) // streak 2（L4）
    ls.handle({ type: 'ready-to-show' }) // 收口 → visible，计数复位
    expect(ls.handle({ type: 'blank-confirmed' })).toEqual([{ kind: 'reload' }])
    expect(ls.state()).toBe('recovering')
  })

  it('recovering + quit → quitting', () => {
    const ls = toRecoveringViaBlank()
    ls.handle({ type: 'quit' })
    expect(ls.state()).toBe('quitting')
    expect(ls.handle({ type: 'load-finished' })).toEqual([])
  })
})

describe('WindowLifecycle quit 禁恢复', () => {
  it('visible + quit → quitting；show/hide/blank 全忽略', () => {
    const ls = toVisible()
    ls.handle({ type: 'quit' })
    expect(ls.handle({ type: 'show-requested', source: 'tray' })).toEqual([])
    expect(ls.handle({ type: 'hide-requested', source: 'close' })).toEqual([])
    expect(ls.handle({ type: 'blank-confirmed' })).toEqual([])
    expect(ls.state()).toBe('quitting')
  })

  it('parked + quit → quitting（托盘退出路径）', () => {
    const ls = toParked()
    ls.handle({ type: 'quit' })
    expect(ls.state()).toBe('quitting')
    expect(ls.handle({ type: 'show-requested', source: 'activate' })).toEqual([])
  })
})
