/**
 * 空白帧判定（v2.4.7 F10 评审修复）
 * 休眠唤醒自愈的「画面像素检测」：判定截屏是否为「接近加载底色 / 纯白」的空窗。
 *
 * 设计要点（评审后收紧）：
 * - 不判「任意单色」：纯黑视频帧（暂停/黑场）、深色画面会被误判为白屏导致无端 reload。
 * - 只判「接近 #f8fafc 加载底色 或 纯白」：GPU 表面失效露出的正是窗口 backgroundColor
 *   （window.ts 创建时 #f8fafc），黑帧视频/深色页面天然排除。
 * - 正常界面含侧栏/文字/图标/预览遮罩（FilePreviewModal 全屏黑遮罩），不可能全采样点
 *   都落在底色容差内；全空白场景（真白屏）所有采样点 ≈ 底色 → 判空白。
 *
 * 纯逻辑模块：不依赖 electron（调用方传结构兼容的 NativeImage / 任何 {isEmpty,getSize,toBitmap}），
 * 可 node 直测（tests/unit/frame.test.ts）。
 */

/** 窗口加载底色 #f8fafc（window.ts createMainWindow backgroundColor） */
const BLANK_BG = { r: 248, g: 250, b: 252 }
/** 纯白（部分合成环境丢底色回退为纯白） */
const BLANK_WHITE = { r: 255, g: 255, b: 255 }
/** 深蓝空窗 #0f172a（v2.4.3 前的旧加载底色 / surface-900）：GPU 表面失效露出的另一种
 *  可能颜色——真机「蓝屏」残留即此；容差 12 下与纯黑视频帧 (0,0,0) 可区分，不误伤 */
const BLANK_DEEP = { r: 15, g: 23, b: 42 }
/** 采样点与目标色的容差（/255；底色 248-252 波动、JPEG 白底 245-255 均可覆盖） */
const TOL = 12
/** 采样点数（间隔采样，控制遍历成本） */
const SAMPLE_POINTS = 2000

/** 默认判定色：浅色系空窗（白屏） */
export const BLANK_TARGETS_DEFAULT = [BLANK_BG, BLANK_WHITE]
/** 休眠唤醒自愈复检的扩展判定色：浅色 + 深蓝空窗（覆盖真机「蓝白屏」两种残留） */
export const BLANK_TARGETS_WAKE = [BLANK_BG, BLANK_WHITE, BLANK_DEEP]

export interface FrameLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  /** BGRA 原始像素（NativeImage.toBitmap 返回） */
  toBitmap(): Buffer | Uint8Array
}

function near(color: { r: number; g: number; b: number }, target: { r: number; g: number; b: number }): boolean {
  return (
    Math.abs(color.r - target.r) <= TOL &&
    Math.abs(color.g - target.g) <= TOL &&
    Math.abs(color.b - target.b) <= TOL
  )
}

/** 截屏是否为「空白空窗」（接近加载底色/纯白，或扩展判定色）——是则休眠唤醒自愈应继续升级。
 *  targets 默认浅色系（保持既有语义）；自愈复检传 BLANK_TARGETS_WAKE（含深蓝空窗）。
 *  纯黑刻意不入任何判定集：黑帧视频/深色画面不得误判为空窗导致无端 reload（评审 P1 红线）。 */
export function isBlankFrameLike(img: FrameLike, targets = BLANK_TARGETS_DEFAULT): boolean {
  if (!img || img.isEmpty()) return true
  const { width, height } = img.getSize()
  if (width <= 0 || height <= 0) return true
  const buf = img.toBitmap()
  if (!buf || buf.length < 4) return true

  const pixelStride = 4
  const total = width * height
  const step = Math.max(1, Math.floor(total / SAMPLE_POINTS))
  for (let i = 0; i + 2 < buf.length; i += step * pixelStride) {
    const b = buf[i]
    const g = buf[i + 1]
    const r = buf[i + 2]
    // 任一点不命中任何目标色 → 有实际内容，判定非空白
    if (!targets.some((t) => near({ r, g, b }, t))) {
      return false
    }
  }
  return true
}
