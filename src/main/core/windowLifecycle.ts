/**
 * 窗口生命周期状态机（v2.5.3 常驻轻壳，T1）
 *
 * 纯 TS 状态机，不依赖 electron、无定时器：事件 → 动作列表返回给 Electron 适配层
 * （src/main/window.ts）执行。语义依据 `设计-v2.5.3-常驻轻壳与跨平台即时恢复.md` §4.1：
 *
 * 状态：starting → visible → parking → parked → presenting → visible（隐藏/恢复）
 *                    ↘ recovering（升级自愈：L2 reload / L4 重建）→ presenting → visible
 *   任意状态 → quitting（禁止恢复）
 *
 * 关键契约：
 * - 冷启动（starting）：ready-to-show 与初始 first-frame-ack 可任意顺序到达，
 *   两者齐备才首次 show+focus（初始 generation）。
 * - hide：visible → parking，发 prepare-hide + 立即 hide（不等待 ACK）；park-ack 匹配当前
 *   generation 才确认 parked；1s 未 ACK 由适配层 parkAckTimeout() 归 parked（不 reload）。
 * - show：parked/parking → presenting，递增 generation 并发 prepare-show（带新 token）；
 *   show 优先，以新 generation 作废迟到的 hide/park ACK。
 * - presenting：first-frame-ack 只证明 DOM 提交；主进程 capturePage(stayHidden) 验证后
 *   注入 witness 事件。match → show+focus → visible；stale/blank 首次 → invalidate + 换新
 *   token 再试，两次不同 token 均失败 → VISUAL_FAILURE_CONFIRMED → reload（recovering）；
 *   recovering 后再失败 → destroyAndRebuild（L4）；unknown 不升级 → notifyRetryOrQuit
 *   （recovering 态连续 unknown ≥3 次才 L4，先弹框重试等渲染层订阅就绪，2026-08-18 定案）。
 * - 仅 renderer-gone / renderer-unresponsive / 双 token 明确失败进入 recovering。
 * - quit 任何状态 → quitting，禁止后续恢复（show 不再产生）。
 */

import { encodeWitnessToken, type WitnessVerdict } from './frame'

/** recovering 态连续 unknown 升级 L4 的阈值：L4 新窗口订阅时序的临时 unknown 先弹框重试
 * （重试时渲染层订阅通常已建立），≥3 次仍 unknown 才视为真故障销毁重建（2026-08-18 定案） */
export const UNKNOWN_RECOVERY_L4_THRESHOLD = 3

export type LifecycleState = 'starting' | 'visible' | 'parking' | 'parked' | 'presenting' | 'recovering' | 'quitting'

export type HideSource = 'close' | 'minimize' | 'system-pause'
export type ShowSource = 'startup' | 'tray' | 'activate' | 'second-instance' | 'wake' | 'recovery'

/** 事件（对象化 payload，类型安全；adapt 层由 Electron 事件映射而来） */
export type LifecycleEvent =
  | { type: 'ready-to-show' }
  | { type: 'hide-requested'; source: HideSource }
  | { type: 'parked-ack'; generation: number }
  | { type: 'show-requested'; source: Exclude<ShowSource, 'startup'> }
  | { type: 'first-frame-ack'; generation: number; frameToken?: number }
  | { type: 'witness'; verdict: WitnessVerdict; token: number }
  | { type: 'renderer-gone' }
  | { type: 'renderer-unresponsive' }
  | { type: 'quit' }

/** 动作：适配层执行（窗口操作 + 消息发送），状态机只决定何时执行什么 */
export type LifecycleAction =
  | { kind: 'show'; source: 'startup' | 'restore' }
  | { kind: 'hide' }
  | { kind: 'invalidate' }
  | { kind: 'reload' }
  | { kind: 'destroyAndRebuild' }
  | { kind: 'notifyRetryOrQuit' }
  | {
      kind: 'send'
      channel: 'window:prepare-hide' | 'window:prepare-show'
      generation: number
      source: HideSource | Exclude<ShowSource, 'startup'>
      frameToken?: number
    }

const EMPTY: LifecycleAction[] = []

export class WindowLifecycle {
  private _state: LifecycleState = 'starting'
  private _generation = 1
  /** starting 双闸门：各记录已见标志 */
  private rtsSeen = false
  private ackSeen = false
  /** presenting/recovering 升级计数：连续明确失败次数（match 清零） */
  private _failedStreak = 0
  /** recovering 态 unknown 连续计数（L4 新窗口订阅时序的临时 unknown 先重试，≥3 次才 L4 收口） */
  private _unknownStreak = 0
  /** 当前 FrameWitness token（21-bit，每次换新） */
  private _token = 0
  private tokenSeq = 0

  state(): LifecycleState {
    return this._state
  }

  generation(): number {
    return this._generation
  }

  /** 当前预期 FrameWitness token（presenting/recovering 时有效） */
  token(): number {
    return this._token
  }

  /** 连续明确失败次数（witness stale/blank 或崩溃；match 清零）——升级日志用（设计 §4.4 第 5 条） */
  failedStreak(): number {
    return this._failedStreak
  }

  /** 下一次 21-bit token（连续调用必然不同，供「两次尝试不同 token」契约） */
  private nextToken(): number {
    this.tokenSeq = (this.tokenSeq + 1) & 0x1fffff
    return this.tokenSeq
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
      case 'presenting':
        return this.onPresenting(event)
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
        return EMPTY // 冷启动中忽略 hide/show/witness（窗口不可见，无预检对象）
    }
  }

  private commitFirstShow(): LifecycleAction[] {
    this._state = 'visible'
    this.rtsSeen = false
    this.ackSeen = false
    // source=startup：适配层首次 show 后不得发 window:restored（冷启动无「恢复业务层」语义，
    // 渲染层初始业务层已挂载，由 v2.3.0 lastRoute 逻辑决定落点；发 restored 会触发 navigate('/') 回归）
    return [{ kind: 'show', source: 'startup' }]
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
      case 'renderer-gone':
        // 崩溃：webContents 已损坏——loadFile 恢复不可靠（Electron 崩溃后渲染层/capture 不恢复，
        // 探针实证 reload 后渲染层再次崩溃、capturePage 永久挂起）→ **直接 L4 销毁重建新窗口**
        // （新窗口全新 webContents；2026-08-18 恢复链定案，替代旧 L2 reload 死路）
        this._state = 'recovering'
        return this.l4Rebuild()
      case 'renderer-unresponsive':
        // 假死：webContents 未崩溃，loadFile 可恢复 → 先隐藏（防白屏露出）再隐藏态 L2 reload，
        // 加载完成经 FrameWitness 预检通过才重新显示（设计 §4.4 故障升级）
        this._state = 'recovering'
        return [{ kind: 'hide' }, { kind: 'reload' }]
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY // 已可见：show/witness 无意义；hide 之外事件忽略
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
        // show 优先：递增 generation 作废迟到的 hide/park ACK
        return this.beginShow(event.source)
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY
    }
  }

  // —— parked：重资源已卸载，等 show ——
  private onParked(event: LifecycleEvent): LifecycleAction[] {
    switch (event.type) {
      case 'show-requested':
        return this.beginShow(event.source)
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY
    }
  }

  /** 进入 presenting：递增 generation、生成新 token、发 prepare-show（窗口仍隐藏） */
  private beginShow(source: Exclude<ShowSource, 'startup'>): LifecycleAction[] {
    this._generation += 1
    this._token = this.nextToken()
    this._failedStreak = 0
    this._state = 'presenting'
    return [
      {
        kind: 'send',
        channel: 'window:prepare-show',
        generation: this._generation,
        source,
        frameToken: this._token,
      },
    ]
  }

  // —— presenting：隐藏预检（等 first-frame-ack + witness 验证）——
  private onPresenting(event: LifecycleEvent): LifecycleAction[] {
    switch (event.type) {
      case 'first-frame-ack':
        // 只证明 DOM 已提交；token 由主进程 capturePage 验证（witness 事件）
        return EMPTY
      case 'witness':
        if (event.token !== this._token) return EMPTY // 旧 token 迟到 → 丢弃
        return this.onWitness(event.verdict)
      case 'renderer-gone':
      case 'renderer-unresponsive':
        return this.upgradeToRecovery()
      case 'show-requested':
        // unknown 出口的「重试」：递增 generation、换新 token 重新预检（旧预检结果被新代作废）
        return this.beginShow(event.source)
      case 'hide-requested':
        // 预检进行中用户再次隐藏：取消恢复，归一化到 parking（发 prepare-hide 卸载业务层；
        // 窗口本就隐藏；进行中的 precheck 由 parking 态忽略——witness/show 不再生效，
        // 2026-08-18 批量实证：忽略 hide 会让 e2e 卸载等待卡死、真实用户恢复中再隐藏无反应）
        this._state = 'parking'
        return [
          { kind: 'send', channel: 'window:prepare-hide', generation: this._generation, source: event.source },
        ]
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY
    }
  }

  // —— recovering：L2 reload / L4 重建后的恢复重试 ——
  private onRecovering(event: LifecycleEvent): LifecycleAction[] {
    switch (event.type) {
      case 'witness':
        if (event.token !== this._token) return EMPTY
        return this.onWitness(event.verdict)
      case 'ready-to-show':
        // L4 重建后：新窗口 ready-to-show → 重新发 prepare-show（FrameWitness 预检）
        // 新 generation（新窗口即新会话），保留 failedStreak（已升级过 → 再失败即可 L4）。
        // 注意：保持 state='recovering'——若改回 presenting，recovering 中再失败会走
        // upgradeToRecovery（再次 reload）而非 L4 销毁重建，升级链永远到不了 L4
        // （v2.5.3 恢复链定案，2026-08-18）。
        this._generation += 1
        this._token = this.nextToken()
        return [
          {
            kind: 'send',
            channel: 'window:prepare-show',
            generation: this._generation,
            source: 'recovery',
            frameToken: this._token,
          },
        ]
      case 'show-requested':
        // L2/L4 后手动重试（unknown 出口）：换新 token 重新预检，保持 recovering 升级语义
        this._generation += 1
        this._token = this.nextToken()
        return [
          {
            kind: 'send',
            channel: 'window:prepare-show',
            generation: this._generation,
            source: event.source,
            frameToken: this._token,
          },
        ]
      case 'hide-requested':
        // 恢复链进行中用户再次隐藏：取消恢复 → parking（同 onPresenting；进行中的
        // precheck/witness 由 parking 态忽略，2026-08-18 批量实证修复——recovering 忽略
        // hide 会让 e2e 卸载等待卡死、真实用户恢复中再隐藏无反应）
        this._state = 'parking'
        return [
          { kind: 'send', channel: 'window:prepare-hide', generation: this._generation, source: event.source },
        ]
      case 'renderer-gone':
      case 'renderer-unresponsive':
        // L2/L4 后再次崩溃 → 直接 L4（已达最大升级档）
        this._failedStreak += 1
        return this.l4Rebuild()
      case 'quit':
        this._state = 'quitting'
        return EMPTY
      default:
        return EMPTY
    }
  }

  /**
   * witness 判定（presenting/recovering 共用）：
   * - match → show+focus → visible（失败计数清零）
   * - stale/blank：首次 → L1 invalidate + 换新 token 再试（仍 presenting）；
   *   连续两次不同 token 均失败 → VISUAL_FAILURE_CONFIRMED：presenting 中 → reload（recovering），
   *   recovering 中 → destroyAndRebuild（L4）。
   * - unknown → notifyRetryOrQuit（不升级，保持 presenting）。
   */
  private onWitness(verdict: WitnessVerdict): LifecycleAction[] {
    switch (verdict) {
      case 'match':
        this._failedStreak = 0
        this._unknownStreak = 0
        this._state = 'visible'
        return [{ kind: 'show', source: 'restore' }]
      case 'stale':
      case 'blank': {
        this._failedStreak += 1
        if (this._failedStreak <= 1) {
          // 首次明确失败：L1 invalidate + 换新 token 再试一次（仍 presenting）
          this._token = this.nextToken()
          return [
            { kind: 'invalidate' },
            {
              kind: 'send',
              channel: 'window:prepare-show',
              generation: this._generation,
              source: this._state === 'recovering' ? 'recovery' : 'tray',
              frameToken: this._token,
            },
          ]
        }
        // 两次不同 token 均明确失败
        if (this._state === 'recovering') {
          // L2 后再失败 → L4 销毁重建
          return this.l4Rebuild()
        }
        return this.upgradeToRecovery()
      }
      case 'unknown':
        // recovering 态（崩溃/故障 reload 后）：Electron 崩溃后的 webContents 合成器不恢复，
        // capturePage(stayHidden) 永久挂起（探针实证 8s 内 10 次全超时）→ 预检永远 unknown →
        // 弹框重试无限循环、窗口永不恢复。升级 L4 销毁重建（新窗口合成器正常，428 实证）——
        // 崩溃恢复以 L4 收口，不无限弹框。
        // 但 L4 新窗口 ready-to-show 后立即 precheck 会撞上「渲染层订阅未建立」时序
        // （ACK 缺失 → JS ping 正常 → unknown），直接 L4 将无限重建循环（实测日志两次 L4）。
        // 定案（2026-08-18）：recovering 态 unknown 先计数——连续 <3 次弹「重试/退出」，
        // 重试时渲染层订阅通常已建立（上轮 precheck 期间完成挂载），预检即通过；
        // 连续 ≥3 次仍 unknown 才是合成器/渲染层真故障 → L4 销毁重建收口。
        // presenting 态（健康/托盘恢复）unknown 保持不升级（截图临时故障，弹重试/退出，设计 §4.4）。
        if (this._state === 'recovering') {
          this._unknownStreak += 1
          if (this._unknownStreak >= UNKNOWN_RECOVERY_L4_THRESHOLD) {
            return this.l4Rebuild()
          }
          return [{ kind: 'notifyRetryOrQuit' }]
        }
        return [{ kind: 'notifyRetryOrQuit' }]
    }
  }

  private upgradeToRecovery(): LifecycleAction[] {
    this._state = 'recovering'
    return [{ kind: 'reload' }]
  }

  /** L4 销毁重建（升级链触顶）：重置 unknown 计数——新窗口是全新会话，订阅时序需重新容忍
   *  （否则新窗口第一次 unknown 就再 L4 → 无限重建循环，2026-08-18 批量日志实证 gen=9 立即 L4） */
  private l4Rebuild(): LifecycleAction[] {
    this._unknownStreak = 0
    return [{ kind: 'destroyAndRebuild' }]
  }
}
