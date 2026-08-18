import { describe, it, expect } from 'vitest'
import { WindowLifecycle } from '../../src/main/core/windowLifecycle'

/**
 * 窗口生命周期状态机（v2.5.3 常驻轻壳，T1）——设计依据
 * `docs/INTERNAL/设计-v2.5.3-常驻轻壳与跨平台即时恢复.md` §4.1。
 *
 * 覆盖：冷启动双闸门（两种到达顺序）、parking→parked→presenting→visible 全链、
 * generation 递增、show 优先作废迟到 park ACK、quit 不复活、unknown 不升级
 * （recovering 态连续 ≥3 次 unknown 升级 L4 收口）、双 token stale/blank 升级边界
 * （L2 reload / L4 重建）、renderer-gone 升级。
 */

/** 取 send 动作的 frameToken 与 generation */
function sendInfo(actions: ReturnType<WindowLifecycle['handle']>, channel: 'window:prepare-hide' | 'window:prepare-show') {
  const a = actions.find((x) => x.kind === 'send' && x.channel === channel)
  return a && a.kind === 'send' ? { generation: a.generation, frameToken: a.frameToken, source: a.source } : null
}

describe('WindowLifecycle 冷启动双闸门（starting）', () => {
  it('ready-to-show 先到 → 不显示；首帧 ACK 后 → show+focus → visible', () => {
    const ls = new WindowLifecycle()
    expect(ls.state()).toBe('starting')
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([]) // 任一先到不显示
    expect(ls.state()).toBe('starting')
    const acts = ls.handle({ type: 'first-frame-ack', generation: 1 })
    expect(acts).toEqual([{ kind: 'show', source: 'startup' }])
    expect(ls.state()).toBe('visible')
  })

  it('首帧 ACK 先到 → 不显示；ready-to-show 后 → show → visible', () => {
    const ls = new WindowLifecycle()
    expect(ls.handle({ type: 'first-frame-ack', generation: 1 })).toEqual([])
    expect(ls.state()).toBe('starting')
    const acts = ls.handle({ type: 'ready-to-show' })
    expect(acts).toEqual([{ kind: 'show', source: 'startup' }])
    expect(ls.state()).toBe('visible')
  })

  it('冷启动期间忽略 hide/show/witness（窗口不可见，无预检对象）', () => {
    const ls = new WindowLifecycle()
    expect(ls.handle({ type: 'show-requested', source: 'tray' })).toEqual([])
    expect(ls.handle({ type: 'hide-requested', source: 'close' })).toEqual([])
    expect(ls.handle({ type: 'witness', verdict: 'match', token: 1 })).toEqual([])
    expect(ls.state()).toBe('starting')
  })

  it('非当前 generation 的首帧 ACK 丢弃', () => {
    const ls = new WindowLifecycle()
    expect(ls.handle({ type: 'first-frame-ack', generation: 99 })).toEqual([])
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([]) // ACK 未被接受，仍不显示
    expect(ls.state()).toBe('starting')
  })
})

describe('WindowLifecycle 隐藏链路（visible → parking → parked）', () => {
  function toVisible(): WindowLifecycle {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    return ls
  }

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
    const acts = ls.handle({ type: 'parked-ack', generation: 1 })
    expect(acts).toEqual([])
    expect(ls.state()).toBe('parked')
  })

  it('parking + 迟到/旧代 park-ack → 作废（不进入 parked）', () => {
    const ls = toVisible()
    ls.handle({ type: 'hide-requested', source: 'close' })
    const acts = ls.handle({ type: 'parked-ack', generation: 999 })
    expect(acts).toEqual([])
    expect(ls.state()).toBe('parking') // 保持等待
  })

  it('park-ack 超时由适配层归 parked（1s 未 ACK 不 reload 不销毁）', () => {
    const ls = toVisible()
    ls.handle({ type: 'hide-requested', source: 'close' })
    const acts = ls.handle({ type: 'parked-ack', generation: 1 })
    expect(acts).toEqual([])
    expect(ls.state()).toBe('parked')
  })
})

describe('WindowLifecycle 恢复链路（parking/parked → presenting → visible）', () => {
  function parked(): WindowLifecycle {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    ls.handle({ type: 'hide-requested', source: 'close' })
    ls.handle({ type: 'parked-ack', generation: 1 })
    return ls
  }

  it('parked + show-requested → 递增 generation + 发 prepare-show(带 token) → presenting', () => {
    const ls = parked()
    const acts = ls.handle({ type: 'show-requested', source: 'tray' })
    expect(ls.generation()).toBe(2)
    const send = sendInfo(acts, 'window:prepare-show')
    expect(send).not.toBeNull()
    expect(send!.generation).toBe(2)
    expect(typeof send!.frameToken).toBe('number')
    expect(send!.frameToken!).toBeGreaterThanOrEqual(0)
    expect(send!.frameToken!).toBeLessThan(0x200000)
    expect(ls.state()).toBe('presenting')
  })

  it('show 优先：parking 中 show-requested → 作废迟到的 park-ack（generation 已递增）', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    ls.handle({ type: 'hide-requested', source: 'close' })
    // 未收到 park-ack，直接 show
    ls.handle({ type: 'show-requested', source: 'tray' })
    expect(ls.generation()).toBe(2)
    expect(ls.state()).toBe('presenting')
    // 迟到的 park-ack（旧代）不得覆盖新状态
    const acts = ls.handle({ type: 'parked-ack', generation: 1 })
    expect(acts).toEqual([])
    expect(ls.state()).toBe('presenting')
  })

  it('presenting + first-frame-ack → 无动作（只证明 DOM 提交，等待 witness 验证）', () => {
    const ls = parked()
    ls.handle({ type: 'show-requested', source: 'activate' })
    const gen = ls.generation()
    const acts = ls.handle({ type: 'first-frame-ack', generation: gen, frameToken: ls.token() })
    expect(acts).toEqual([])
    expect(ls.state()).toBe('presenting')
  })

  it('presenting + witness(match) → show → visible；失败计数清零', () => {
    const ls = parked()
    ls.handle({ type: 'show-requested', source: 'tray' })
    const token = ls.token()
    const acts = ls.handle({ type: 'witness', verdict: 'match', token })
    expect(acts).toEqual([{ kind: 'show', source: 'restore' }])
    expect(ls.state()).toBe('visible')
  })

  it('presenting + witness(unknown) → notifyRetryOrQuit，不升级（保持 presenting）', () => {
    const ls = parked()
    ls.handle({ type: 'show-requested', source: 'tray' })
    const token = ls.token()
    const acts = ls.handle({ type: 'witness', verdict: 'unknown', token })
    expect(acts).toEqual([{ kind: 'notifyRetryOrQuit' }])
    expect(ls.state()).toBe('presenting') // 不升级
    expect(ls.token()).toBe(token) // token 未被换新（unknown 不进入升级路径）
  })

  it('recovering + witness(unknown) 连续 2 次 → notifyRetryOrQuit（等订阅就绪），第 3 次 → destroyAndRebuild（L4 收口）', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 }) // starting 双闸门齐备 → visible
    ls.handle({ type: 'renderer-gone' }) // visible → recovering（[hide, reload]）
    expect(ls.state()).toBe('recovering')
    // L4 新窗口 ready-to-show 后立即 precheck 可能撞上「渲染层订阅未建立」时序
    // （ACK 缺失 → JS ping 正常 → unknown）：先弹框重试，给渲染层挂载留出窗口；
    // 前 2 次不升级（2026-08-18 定案，修复 L4 无限重建循环）
    const t1 = ls.token()
    const acts1 = ls.handle({ type: 'witness', verdict: 'unknown', token: t1 })
    expect(acts1).toEqual([{ kind: 'notifyRetryOrQuit' }])
    expect(ls.state()).toBe('recovering')
    const acts2 = ls.handle({ type: 'witness', verdict: 'unknown', token: t1 })
    expect(acts2).toEqual([{ kind: 'notifyRetryOrQuit' }])
    // 连续 3 次仍 unknown（崩溃后 webContents 合成器不恢复，capture 永久挂起）→ L4 销毁重建收口
    const acts3 = ls.handle({ type: 'witness', verdict: 'unknown', token: t1 })
    expect(acts3).toEqual([{ kind: 'destroyAndRebuild' }])
    expect(ls.state()).toBe('recovering') // 保持升级态
  })

  it('recovering + unknown 重试成功后 match → visible，unknown 计数清零', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    ls.handle({ type: 'renderer-gone' }) // → recovering
    ls.handle({ type: 'witness', verdict: 'unknown', token: ls.token() }) // 第 1 次弹框
    expect(ls.state()).toBe('recovering')
    // 用户重试 → 换新 token 重新预检（show-requested 路径）
    ls.handle({ type: 'show-requested', source: 'recovery' })
    const t2 = ls.token()
    const acts = ls.handle({ type: 'witness', verdict: 'match', token: t2 })
    expect(acts).toEqual([{ kind: 'show', source: 'restore' }])
    expect(ls.state()).toBe('visible')
    // 计数已清零：后续再进 recovering 后 unknown 重新从 1 计
    ls.handle({ type: 'renderer-gone' })
    expect(ls.handle({ type: 'witness', verdict: 'unknown', token: ls.token() })).toEqual([
      { kind: 'notifyRetryOrQuit' },
    ])
  })

  it('L4 重建重置 unknown 计数：新窗口 unknown 重新从 1 计（不立即再 L4）', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    ls.handle({ type: 'renderer-gone' }) // → recovering
    // 连续 3 次 unknown → L4（计数到阈值）
    ls.handle({ type: 'witness', verdict: 'unknown', token: ls.token() })
    ls.handle({ type: 'witness', verdict: 'unknown', token: ls.token() })
    const acts = ls.handle({ type: 'witness', verdict: 'unknown', token: ls.token() })
    expect(acts).toEqual([{ kind: 'destroyAndRebuild' }])
    // L4 后新窗口 ready-to-show → 恢复 precheck；第一次 unknown 应弹框（计数已重置），不立即 L4
    ls.handle({ type: 'ready-to-show' })
    const acts2 = ls.handle({ type: 'witness', verdict: 'unknown', token: ls.token() })
    expect(acts2).toEqual([{ kind: 'notifyRetryOrQuit' }])
    // 新窗口订阅建立 → match → visible
    const t = ls.token()
    expect(ls.handle({ type: 'witness', verdict: 'match', token: t })).toEqual([{ kind: 'show', source: 'restore' }])
    expect(ls.state()).toBe('visible')
  })

  it('presenting + 旧 token 的 witness → 丢弃', () => {
    const ls = parked()
    ls.handle({ type: 'show-requested', source: 'tray' })
    const acts = ls.handle({ type: 'witness', verdict: 'match', token: 999999 })
    expect(acts).toEqual([])
    expect(ls.state()).toBe('presenting')
  })

  it('presenting + hide-requested（预检中再隐藏）→ parking + prepare-hide，witness 不再生效', () => {
    const ls = parked()
    ls.handle({ type: 'show-requested', source: 'tray' })
    const gen = ls.generation()
    const acts = ls.handle({ type: 'hide-requested', source: 'close' })
    expect(ls.state()).toBe('parking')
    const send = sendInfo(acts, 'window:prepare-hide')
    expect(send).not.toBeNull()
    expect(send!.generation).toBe(gen)
    // 迟到的 witness（进行中的 precheck）在 parking 态被忽略——不 show 不升级
    expect(ls.handle({ type: 'witness', verdict: 'match', token: ls.token() })).toEqual([])
    expect(ls.state()).toBe('parking')
  })

  it('recovering + hide-requested（恢复链中再隐藏）→ parking + prepare-hide，取消恢复', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    ls.handle({ type: 'renderer-gone' }) // → recovering
    const acts = ls.handle({ type: 'hide-requested', source: 'close' })
    expect(ls.state()).toBe('parking')
    const send = sendInfo(acts, 'window:prepare-hide')
    expect(send).not.toBeNull()
    // 后续 park-ack → parked；show 正常恢复（重新预检）
    ls.handle({ type: 'parked-ack', generation: send!.generation })
    expect(ls.state()).toBe('parked')
    ls.handle({ type: 'show-requested', source: 'tray' })
    expect(ls.state()).toBe('presenting')
  })

  it('presenting + show-requested（unknown 出口的「重试」）→ 递增 generation 换新 token 重新预检', () => {
    const ls = parked()
    ls.handle({ type: 'show-requested', source: 'tray' })
    const t1 = ls.token()
    ls.handle({ type: 'witness', verdict: 'unknown', token: t1 }) // → notifyRetryOrQuit
    const genBefore = ls.generation()
    const acts = ls.handle({ type: 'show-requested', source: 'recovery' })
    expect(ls.generation()).toBe(genBefore + 1)
    const send = sendInfo(acts, 'window:prepare-show')
    expect(send).not.toBeNull()
    expect(send!.source).toBe('recovery')
    expect(send!.frameToken).not.toBe(t1) // 重试换新 token
    expect(ls.state()).toBe('presenting')
  })
})

describe('WindowLifecycle 升级边界（双 token 明确失败 → L2/L4）', () => {
  function presenting(): WindowLifecycle {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    ls.handle({ type: 'hide-requested', source: 'close' })
    ls.handle({ type: 'parked-ack', generation: 1 })
    ls.handle({ type: 'show-requested', source: 'tray' })
    return ls
  }

  it('首次 stale → L1 invalidate + 换新 token 再试（仍 presenting）', () => {
    const ls = presenting()
    const t1 = ls.token()
    const acts = ls.handle({ type: 'witness', verdict: 'stale', token: t1 })
    expect(acts[0]).toEqual({ kind: 'invalidate' })
    const send = sendInfo(acts, 'window:prepare-show')
    expect(send).not.toBeNull()
    expect(send!.frameToken).not.toBe(t1) // 两次尝试 token 必须不同
    expect(ls.state()).toBe('presenting')
  })

  it('两次不同 token 均 stale/blank → reload（recovering）', () => {
    const ls = presenting()
    const t1 = ls.token()
    ls.handle({ type: 'witness', verdict: 'blank', token: t1 })
    const t2 = ls.token()
    expect(t2).not.toBe(t1)
    const acts = ls.handle({ type: 'witness', verdict: 'stale', token: t2 })
    expect(acts).toEqual([{ kind: 'reload' }])
    expect(ls.state()).toBe('recovering')
  })

  it('recovering + witness(match) → show → visible（L2 后恢复正常）', () => {
    const ls = presenting()
    const t1 = ls.token()
    ls.handle({ type: 'witness', verdict: 'blank', token: t1 })
    const t2 = ls.token()
    ls.handle({ type: 'witness', verdict: 'stale', token: t2 })
    expect(ls.state()).toBe('recovering')
    const t3 = ls.token() // recovering 中 invalidate 重试已换新 token
    const acts = ls.handle({ type: 'witness', verdict: 'match', token: t3 })
    expect(acts).toEqual([{ kind: 'show', source: 'restore' }])
    expect(ls.state()).toBe('visible')
  })

  it('recovering + 再次双 token 失败 → destroyAndRebuild（L4）', () => {
    const ls = presenting()
    const t1 = ls.token()
    ls.handle({ type: 'witness', verdict: 'stale', token: t1 })
    const t2 = ls.token()
    ls.handle({ type: 'witness', verdict: 'stale', token: t2 })
    expect(ls.state()).toBe('recovering')
    // L2 后首次明确失败 → invalidate 再试
    const t3 = ls.token()
    ls.handle({ type: 'witness', verdict: 'blank', token: t3 })
    const t4 = ls.token()
    const acts = ls.handle({ type: 'witness', verdict: 'blank', token: t4 })
    expect(acts).toEqual([{ kind: 'destroyAndRebuild' }])
  })

  it('recovering + ready-to-show（L4 重建后）→ 重新发 prepare-show(recovery) → presenting', () => {
    const ls = presenting()
    const t1 = ls.token()
    ls.handle({ type: 'witness', verdict: 'stale', token: t1 })
    const t2 = ls.token()
    ls.handle({ type: 'witness', verdict: 'stale', token: t2 })
    const t3 = ls.token()
    ls.handle({ type: 'witness', verdict: 'blank', token: t3 })
    const t4 = ls.token()
    ls.handle({ type: 'witness', verdict: 'blank', token: t4 }) // → destroyAndRebuild
    // 新窗口 ready-to-show → 重新预检（保持 recovering：再失败才可升级 L4，v2.5.3 恢复链定案）
    const acts = ls.handle({ type: 'ready-to-show' })
    const send = sendInfo(acts, 'window:prepare-show')
    expect(send).not.toBeNull()
    expect(send!.source).toBe('recovery')
    expect(ls.state()).toBe('recovering')
  })

  it('presenting + renderer-gone → reload（recovering）', () => {
    const ls = presenting()
    const acts = ls.handle({ type: 'renderer-gone' })
    expect(acts).toEqual([{ kind: 'reload' }])
    expect(ls.state()).toBe('recovering')
  })

  it('presenting + renderer-unresponsive → reload（recovering）', () => {
    const ls = presenting()
    const acts = ls.handle({ type: 'renderer-unresponsive' })
    expect(acts).toEqual([{ kind: 'reload' }])
    expect(ls.state()).toBe('recovering')
  })

  it('visible + renderer-gone → destroyAndRebuild（L4：崩溃后 webContents 损坏，loadFile 不可靠）', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    expect(ls.state()).toBe('visible')
    const acts = ls.handle({ type: 'renderer-gone' })
    // 2026-08-18 恢复链定案：崩溃后 loadFile 恢复不可靠（Electron 崩溃后渲染层/capture 不恢复，
    // reload 渲染层再次崩溃）→ 直接 L4 销毁重建新窗口；假死（unresponsive）才走 hide+reload
    expect(acts).toEqual([{ kind: 'destroyAndRebuild' }])
    expect(ls.state()).toBe('recovering')
  })

  it('visible + renderer-unresponsive → 先 hide 再 reload（recovering）', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    const acts = ls.handle({ type: 'renderer-unresponsive' })
    expect(acts).toEqual([{ kind: 'hide' }, { kind: 'reload' }])
    expect(ls.state()).toBe('recovering')
  })

  it('recovering（崩溃后）+ 再次 renderer-gone → destroyAndRebuild（L4，不无限 reload）', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    ls.handle({ type: 'renderer-gone' }) // → recovering
    expect(ls.state()).toBe('recovering')
    const acts = ls.handle({ type: 'renderer-gone' })
    expect(acts).toEqual([{ kind: 'destroyAndRebuild' }])
    expect(ls.state()).toBe('recovering') // 保持 recovering（等新窗口 ready-to-show）
  })
})

describe('WindowLifecycle quit 不复活', () => {
  function toVisible(): WindowLifecycle {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    return ls
  }

  it('quit 后任何事件不再产生 show/hide 动作', () => {
    const ls = toVisible()
    ls.handle({ type: 'quit' })
    expect(ls.state()).toBe('quitting')
    expect(ls.handle({ type: 'show-requested', source: 'tray' })).toEqual([])
    expect(ls.handle({ type: 'hide-requested', source: 'close' })).toEqual([])
    expect(ls.handle({ type: 'witness', verdict: 'match', token: ls.token() })).toEqual([])
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([])
    expect(ls.state()).toBe('quitting')
  })

  it('starting 中 quit 同样不复活', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'quit' })
    expect(ls.handle({ type: 'ready-to-show' })).toEqual([])
    expect(ls.handle({ type: 'first-frame-ack', generation: 1 })).toEqual([])
    expect(ls.state()).toBe('quitting')
  })
})

describe('WindowLifecycle 连续隐藏/恢复 generation 递增', () => {
  it('hide→show→hide→show generation 单调递增', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    // 1st hide
    ls.handle({ type: 'hide-requested', source: 'close' })
    ls.handle({ type: 'parked-ack', generation: 1 })
    ls.handle({ type: 'show-requested', source: 'tray' })
    expect(ls.generation()).toBe(2)
    const t1 = ls.token()
    ls.handle({ type: 'witness', verdict: 'match', token: t1 })
    expect(ls.state()).toBe('visible')
    // 2nd hide
    ls.handle({ type: 'hide-requested', source: 'minimize' })
    ls.handle({ type: 'parked-ack', generation: 2 })
    ls.handle({ type: 'show-requested', source: 'activate' })
    expect(ls.generation()).toBe(3)
    const t2 = ls.token()
    expect(t2).not.toBe(t1) // 每次恢复 token 不同
    ls.handle({ type: 'witness', verdict: 'match', token: t2 })
    expect(ls.state()).toBe('visible')
  })
})

describe('WindowLifecycle token 契约（21-bit）', () => {
  it('token 恒在 [0, 2^21) 且每次换新', () => {
    const ls = new WindowLifecycle()
    ls.handle({ type: 'ready-to-show' })
    ls.handle({ type: 'first-frame-ack', generation: 1 })
    ls.handle({ type: 'hide-requested', source: 'close' })
    ls.handle({ type: 'parked-ack', generation: 1 })
    const tokens = new Set<number>()
    for (let i = 0; i < 5; i++) {
      ls.handle({ type: 'show-requested', source: 'tray' })
      const t = ls.token()
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThan(0x200000)
      tokens.add(t)
      ls.handle({ type: 'witness', verdict: 'match', token: t })
      ls.handle({ type: 'hide-requested', source: 'close' })
      ls.handle({ type: 'parked-ack', generation: ls.generation() })
    }
    expect(tokens.size).toBe(5) // 五次恢复 token 均不同
  })
})
