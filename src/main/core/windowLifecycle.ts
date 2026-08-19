/**
 * 窗口生命周期状态机（v2.5.3 热修：删 FrameWitness 隐藏预检，改「先显示、后验证」）
 *
 * 纯 TS 状态机，不依赖 electron、无定时器：事件 → 动作列表返回给 Electron 适配层
 * （src/main/window.ts）执行。设计依据 `PLAN-v2.5.3-托盘冻结根治.md`。
 *
 * 状态：starting → visible → parking → parked → visible（隐藏/直接恢复）
 *                    ↘ recovering（崩溃 L4 / 无响应 L2 / blank L2）→ visible（收口直接 show）
 *   任意状态 → quitting（禁止恢复）
 *
 * 关键契约：
 * - 冷启动（starting）：ready-to-show 与初始 first-frame-ack 可任意顺序到达，
 *   两者齐备才首次 show+focus（初始 generation）。
 * - hide：visible → parking，发 prepare-hide + 立即 hide（不等待 ACK）；park-ack 匹配当前
 *   generation 才确认 parked；1s 未 ACK 由适配层 parkAckTimeout() 归 parked（不 reload）。
 * - show（v2.5.3 热修定案）：parked/parking → **直接 show+focus** → visible，递增 generation
 *   作废迟到的 park ACK。不再做隐藏态 FrameWitness 预检——「隐藏态必能抓到帧」前提被
 *   2026-08-19 事故证伪（软渲染长时隐藏合成器休眠，capturePage 永远超时 → 唤不醒）；
 *   白屏兜底改为显示后像素自检（适配层 capturePage + isBlankFrameLike），确认后喂
 *   blank-confirmed。动作 postShowCheck=true 仅用于 parked 恢复 show；recovering 收口
 *   show 不武装（新渲染进程 load 期间必绘帧，且收口后不再自检 → blank 链单发天然收口）。
 * - blank-confirmed：仅 visible 有效 → recovering + 可见态 reload（窗口本就白，不 hide）；
 *   其余状态一律忽略（迟到竞态守卫）。
 * - renderer-gone：visible → recovering + 直接 L4 销毁重建（崩溃后 reload 不可靠，探针实证）；
 *   renderer-unresponsive：visible → recovering + 先 hide 再 L2 reload。
 * - recovering 收口：L2 后 load-finished / L4 后 ready-to-show / 用户手动 show-requested
 *   → 直接 show(restore) → visible；恢复中再崩溃/无响应 → L4；连续升级 ≥2 次未回 visible
 *   封顶零动作（防 did-fail-load 类无限重建循环），用户仍可托盘手动收口。
 * - quit 任何状态 → quitting，禁止后续恢复（show 不再产生）。
 */

export type LifecycleState = 'starting' | 'visible' | 'parking' | 'parked' | 'recovering' | 'quitting'

export type HideSource = 'close' | 'minimize' | 'system-pause'
export type ShowSource = 'startup' | 'tray' | 'activate' | 'second-instance' | 'wake'

/** 事件（对象化 payload，类型安全；adapt 层由 Electron 事件映射而来） */
export type LifecycleEvent =
  | { type: 'ready-to-show' }
  | { type: 'hide-requested'; source: HideSource }
  | { type: 'parked-ack'; generation: number }
  | { type: 'show-requested'; source: Exclude<ShowSource, 'startup'> }
  | { type: 'first-frame-ack'; generation: number }
  /** L2 reload 完成（适配层 did-finish-load 映射）：recovering 收口 */
  | { type: 'load-finished' }
  /** 显示后白屏自检确认（适配层 invalidate 复检仍 blank）：仅 visible 有效 */
  | { type: 'blank-confirmed' }
  | { type: 'renderer-gone' }
  | { type: 'renderer-unresponsive' }
  | { type: 'quit' }

/** 动作：适配层执行（窗口操作 + 消息发送），状态机只决定何时执行什么 */
export type LifecycleAction =
  | {
      kind: 'show'
      source: 'startup' | 'restore'
      /** parked 恢复 show = true（适配层 300ms 后抓帧 blank 自检）；startup/recovering 收口 = false */
      postShowCheck: boolean
    }
  | { kind: 'hide' }
  | { kind: 'reload' }
  | { kind: 'destroyAndRebuild' }
  | {
      kind: 'send'
      channel: 'window:prepare-hide'
      generation: number
      source: HideSource
    }

const EMPTY: LifecycleAction[] = []

/** recovering 连续升级封顶：≥2 次未回 visible 不再动作（防无限重建），用户可托盘手动收口 */
const RECOVERY_STREAK_CAP = 2

export class WindowLifecycle {
  private _state: LifecycleState = 'starting'
  private _generation = 1
  /** starting 双闸门：各记录已见标志 */
  private rtsSeen = false
  private ackSeen = false
  /** recovering 连续升级计数（进入 recovering/再升级 +1；回到 visible 复位 0） */
  private _recoveryStreak = 0

  state(): LifecycleState {
    return this._state
  }

  generation(): number {
    return this._generation
  }

  /** recovering 连续升级次数（封顶观测日志用） */
  recoveryStreak(): number {
    return this._recoveryStreak
  }

  handle(event: LifecycleEvent): LifecycleAction[] {
    switch (this._state) {
      case 'quitting':
        return EMPTY
      case 'starting':
        return this.onStarting(event)
      case 'visible':
        return this.onVisible(event)
      case 'parking':
        return this.onParking(event)
      case 'parked':
        return this.onParked(event)
      case 'recovering':
        return this.onRecovering(event)
    }
  }

  // —— starting：冷启动双闸门 ——
  private onStarting(event: LifecycleEvent): LifecycleAction[] {
    switch (event.type) {
      case 'ready-to-show':
        this.rtsSeen = true
        if (this.ackSeen) return this.commitFirstShow()
        return EMPTY
      case 'first-frame-ack':
        // 仅接受当前初始 generation 的 ACK
        if (event.generation !== this._generation) return EMPTY
        this.ackSeen = true
        if (this.rtsSeen) return this.commitFirstShow()
        return EMPTY
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY // 冷启动中忽略 hide/show/blank/load-finished（窗口未就绪，无处理对象）
    }
  }

  private commitFirstShow(): LifecycleAction[] {
    this._state = 'visible'
    this.rtsSeen = false
    this.ackSeen = false
    // source=startup：适配层首次 show 后不得发 window:restored（冷启动无「恢复业务层」语义，
    // 渲染层初始业务层已挂载，由 v2.3.0 lastRoute 逻辑决定落点；发 restored 会触发 navigate('/') 回归）
    return [{ kind: 'show', source: 'startup', postShowCheck: false }]
  }

  // —— visible：正常显示态 ——
  private onVisible(event: LifecycleEvent): LifecycleAction[] {
    switch (event.type) {
      case 'hide-requested':
        this._state = 'parking'
        return [
          { kind: 'send', channel: 'window:prepare-hide', generation: this._generation, source: event.source },
          { kind: 'hide' },
        ]
      case 'blank-confirmed':
        // 显示后白屏确认（invalidate 复检仍 blank）：可见态 L2 reload（窗口本就白，不 hide 不遮羞）
        return this.enterRecovery([{ kind: 'reload' }])
      case 'renderer-unresponsive':
        // 假死：webContents 未崩溃，loadFile 可恢复 → 先隐藏（防假死画面露出）再隐藏态 L2 reload
        return this.enterRecovery([{ kind: 'hide' }, { kind: 'reload' }])
      case 'renderer-gone':
        // 崩溃：webContents 已损坏——loadFile 恢复不可靠（Electron 崩溃后渲染层不恢复，
        // 探针实证 reload 后渲染层再次崩溃）→ **直接 L4 销毁重建新窗口**（2026-08-18 定案沿用）
        return this.enterRecovery([{ kind: 'destroyAndRebuild' }])
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY // 已可见：show/load-finished/ready-to-show/park-ack 无意义，忽略
    }
  }

  // —— parking：已发 prepare-hide + hide，等 park-ack ——
  private onParking(event: LifecycleEvent): LifecycleAction[] {
    switch (event.type) {
      case 'parked-ack':
        if (event.generation !== this._generation) return EMPTY // 迟到/旧代 ACK 作废
        this._state = 'parked'
        return EMPTY
      case 'show-requested':
        // show 优先：递增 generation 作废迟到的 park ACK
        return this.directShow()
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY // 迟到 blank-confirmed 等一律忽略
    }
  }

  // —— parked：重资源已卸载，等 show ——
  private onParked(event: LifecycleEvent): LifecycleAction[] {
    switch (event.type) {
      case 'show-requested':
        return this.directShow()
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY
    }
  }

  /** parked 恢复：直接 show+focus（无预检），武装显示后白屏自检 */
  private directShow(): LifecycleAction[] {
    this._generation += 1
    this._recoveryStreak = 0
    this._state = 'visible'
    return [{ kind: 'show', source: 'restore', postShowCheck: true }]
  }

  // —— recovering：L2 reload / L4 重建后的收口 ——
  private onRecovering(event: LifecycleEvent): LifecycleAction[] {
    switch (event.type) {
      case 'load-finished':
        // L2 reload 完成（did-finish-load）→ 直接 show；不武装自检（新渲染进程 load 期间
        // 必绘帧；且收口后不再自检 → blank 链单发天然收口，无循环）
        return this.recoveredShow()
      case 'ready-to-show':
        // L4 重建后新窗口就绪 → 直接 show（ready-to-show 本身即首绘完成证据）
        return this.recoveredShow()
      case 'show-requested':
        // 恢复进行中用户点托盘：不等收口直接开窗（用户优先）
        return this.recoveredShow()
      case 'hide-requested':
        // 恢复进行中用户再次隐藏：取消恢复，归一化到 parking（发 prepare-hide 卸载业务层）
        this._state = 'parking'
        return [
          { kind: 'send', channel: 'window:prepare-hide', generation: this._generation, source: event.source },
        ]
      case 'renderer-gone':
      case 'renderer-unresponsive':
        // 恢复链中再次崩溃/假死 → L4（已达最大升级档）；连续 ≥2 次未回 visible 封顶零动作
        // （防 did-fail-load 类无限重建循环），用户仍可托盘手动 show-requested 收口
        if (this._recoveryStreak >= RECOVERY_STREAK_CAP) return EMPTY
        this._recoveryStreak += 1
        return [{ kind: 'destroyAndRebuild' }]
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY // 迟到 blank-confirmed/park-ack/first-frame-ack（L4 新渲染层挂载上报）忽略
    }
  }

  /** recovering → visible：直接 show(restore)，不武装显示后自检（见 directShow 注释） */
  private recoveredShow(): LifecycleAction[] {
    this._state = 'visible'
    this._recoveryStreak = 0
    return [{ kind: 'show', source: 'restore', postShowCheck: false }]
  }

  private enterRecovery(actions: LifecycleAction[]): LifecycleAction[] {
    this._state = 'recovering'
    this._recoveryStreak += 1
    return actions
  }
}
