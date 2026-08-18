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

// —— v2.5.3 常驻轻壳：FrameWitness 新鲜帧见证（T1）——
// 渲染层在隐藏状态绘制 5×5 品牌蓝网格（四角定位格恒品牌蓝，中间 21 格编码 token bit）；
// 主进程 capturePage(rect,{stayHidden}) 后 toBitmap() BGRA 逐格采样解码，分类判定
// 「本次 generation 的新鲜帧」后才允许 show（match/stale/blank/unknown）。
// 纯逻辑模块：不依赖 electron（调用方传 FrameLike），可 node 直测。

/** 见证网格规格：5×5，四角定位格恒品牌蓝，中间 21 格编码 token（21-bit） */
export const WITNESS_GRID_N = 5
/** 中间 21 个数据格的 cell 序号（行优先，跳过四角 0/4/20/24）——渲染与解码共用同一映射 */
export const WITNESS_DATA_IDX: number[] = (() => {
  const idx: number[] = []
  for (let i = 0; i < WITNESS_GRID_N * WITNESS_GRID_N; i++) {
    const r = Math.floor(i / WITNESS_GRID_N)
    const c = i % WITNESS_GRID_N
    const isCorner =
      (r === 0 && c === 0) ||
      (r === 0 && c === WITNESS_GRID_N - 1) ||
      (r === WITNESS_GRID_N - 1 && c === 0) ||
      (r === WITNESS_GRID_N - 1 && c === WITNESS_GRID_N - 1)
    if (!isCorner) idx.push(i)
  }
  return idx
})()
/** 品牌蓝（Fluent 主色 #2f6fed）；避开 BLANK_TARGETS_WAKE（248,250,252 浅色与深蓝 #0f172a） */
const WITNESS_BRAND = { r: 0x2f, g: 0x6f, b: 0xed }
/** 品牌蓝容差（解码抗 JPEG/色差；e2e 探针同款 ±24） */
const WITNESS_TOL = 24
/** token 位数（21-bit，[0, 2^21)） */
const WITNESS_BITS = 21
/** DPI 候选缩放（Electron 常见 scaleFactor；含 100/125/150/200%） */
const WITNESS_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
/** 单格采样：中心 ±4px 小区域多数投票（容差内品牌蓝=1 / 近白=0 / 其他=-1） */
const WITNESS_SAMPLE_HALF = 4

export type WitnessVerdict = 'match' | 'stale' | 'blank' | 'unknown'

/** 见证网格布局（DIP 坐标）：capturePage(rect) 的 rect 与渲染层网格几何 */
export interface WitnessGridLayout {
  rect: { x: number; y: number; width: number; height: number }
  n: number
  cell: number
  gap: number
  originX: number // 网格左上角绝对 DIP 坐标
  originY: number
}

/** 21-bit token 截断：generation → token（安全整数，[0, 2^21)） */
export function encodeWitnessToken(generation: number): number {
  return generation & ((1 << WITNESS_BITS) - 1)
}

/** token 解码：复原低 21 位（幂等） */
export function decodeWitnessToken(token: number): number {
  return token & ((1 << WITNESS_BITS) - 1)
}

/** 由 bitmap 尺寸与 rect 尺寸推导 DPI 缩放；无法识别返回 null */
function deriveDpiScale(imgW: number, imgH: number, grid: WitnessGridLayout): number | null {
  if (grid.rect.width <= 0 || grid.rect.height <= 0) return null
  const ratioX = imgW / grid.rect.width
  const ratioY = imgH / grid.rect.height
  let best: number | null = null
  let bestErr = Number.POSITIVE_INFINITY
  for (const s of WITNESS_SCALES) {
    const errX = Math.abs(ratioX - s) / s
    const errY = Math.abs(ratioY - s) / s
    const err = Math.max(errX, errY)
    if (err < bestErr) {
      bestErr = err
      best = s
    }
  }
  // 相对误差 >5% 视为无法识别（裁剪/全页截图等）
  return bestErr <= 0.05 ? best : null
}

/** 单格中心采样：±WITNESS_SAMPLE_HALF 区域多数投票；无法判定返回 -1 */
function sampleWitnessCell(buf: Buffer | Uint8Array, imgW: number, imgH: number, cx: number, cy: number): number {
  let brand = 0
  let white = 0
  let other = 0
  for (let dy = -WITNESS_SAMPLE_HALF; dy <= WITNESS_SAMPLE_HALF; dy++) {
    for (let dx = -WITNESS_SAMPLE_HALF; dx <= WITNESS_SAMPLE_HALF; dx++) {
      const px = Math.round(cx + dx)
      const py = Math.round(cy + dy)
      if (px < 0 || py < 0 || px >= imgW || py >= imgH) continue
      const o = (py * imgW + px) * 4
      if (o < 0 || o + 2 >= buf.length) continue
      const b = buf[o]
      const g = buf[o + 1]
      const r = buf[o + 2]
      const isBrand = Math.abs(r - WITNESS_BRAND.r) <= WITNESS_TOL && Math.abs(g - WITNESS_BRAND.g) <= WITNESS_TOL && Math.abs(b - WITNESS_BRAND.b) <= WITNESS_TOL
      if (isBrand) brand++
      else if (r >= 235 && g >= 235 && b >= 235) white++
      else other++
    }
  }
  const total = brand + white + other
  if (total === 0) return -1
  if (brand >= total / 2) return 1
  if (white >= total / 2) return 0
  return -1
}

/**
 * FrameWitness 分类：
 * - `match`：四角定位格命中品牌蓝，且 21 个数据格解码 token === expectedToken（本次新鲜帧）。
 * - `stale`：网格存在、可定位，但 token 是旧帧（四角可被伪造，token 错仍非 match）。
 * - `blank`：全底色/纯白（画面空白）。
 * - `unknown`：空图/畸形/无法识别 DPI 缩放/网格无法定位（不能伪装成失败，不升级）。
 * opts.dpiScale 可显式注入（跳过推导），否则按 bitmap 尺寸/rect 推导。
 */
export function classifyFrameWitness(
  img: FrameLike,
  expectedToken: number,
  grid: WitnessGridLayout,
  opts?: { dpiScale?: number },
): WitnessVerdict {
  if (!img || img.isEmpty()) return 'unknown'
  const size = img.getSize()
  if (size.width <= 0 || size.height <= 0) return 'unknown'
  const buf = img.toBitmap()
  if (!buf || buf.length < 4) return 'unknown'
  // 全底色（白屏）优先：网格存在时必有品牌蓝，全底色必为空白
  if (isBlankFrameLike(img)) return 'blank'
  // DPI 缩放推导
  const scale = opts?.dpiScale ?? deriveDpiScale(size.width, size.height, grid)
  if (scale === null) return 'unknown'
  // 逐格采样（含四角定位格）
  const bits: number[] = []
  for (let i = 0; i < grid.n * grid.n; i++) {
    const r = Math.floor(i / grid.n)
    const c = i % grid.n
    const cx = (grid.originX + c * (grid.cell + grid.gap) + grid.cell / 2 - grid.rect.x) * scale
    const cy = (grid.originY + r * (grid.cell + grid.gap) + grid.cell / 2 - grid.rect.y) * scale
    bits.push(sampleWitnessCell(buf, size.width, size.height, cx, cy))
  }
  // 四角定位格必须命中品牌蓝（网格真实存在）；否则无法定位 → unknown
  const corners = [0, grid.n - 1, grid.n * (grid.n - 1), grid.n * grid.n - 1]
  for (const ci of corners) {
    if (bits[ci] !== 1) return 'unknown'
  }
  // 数据格解码 token（21 格，非蓝非白视为无法判定）
  let token = 0
  for (let k = 0; k < WITNESS_DATA_IDX.length; k++) {
    const bit = bits[WITNESS_DATA_IDX[k]]
    if (bit === 1) token |= 1 << k
    else if (bit !== 0) return 'unknown'
  }
  return token === (expectedToken & ((1 << WITNESS_BITS) - 1)) ? 'match' : 'stale'
}
