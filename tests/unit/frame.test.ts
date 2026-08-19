import { describe, it, expect } from 'vitest'
import {
  isBlankFrameLike,
  BLANK_TARGETS_WAKE,
  type FrameLike,
} from '../../src/main/core/frame'

/** 构造 BGRA 帧 fake：fill 为填充函数 (i,j) => [r,g,b]，默认全色 */
function makeFrame(width: number, height: number, pixel: (i: number, j: number) => [number, number, number]): FrameLike {
  const buf = Buffer.alloc(width * height * 4)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const [r, g, b] = pixel(i, j)
      const o = (j * width + i) * 4
      buf[o] = b
      buf[o + 1] = g
      buf[o + 2] = r
      buf[o + 3] = 255
    }
  }
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => buf,
  }
}

const SIZE = 1000 // 100 万像素，采样步长 ~500，覆盖 ~2000 采样点

// 应用点（2026-08-19 热修）：显示后白屏自检（window.ts runPostShowCheck，可见态抓帧）。
// 原 FrameWitness 网格分类用例随隐藏预检链整体删除（PLAN-v2.5.3-托盘冻结根治.md）。
describe('isBlankFrameLike（显示后白屏像素检测）', () => {
  it('空图 / 尺寸 0 / buffer 过短 → 空白', () => {
    expect(isBlankFrameLike({ isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.alloc(0) })).toBe(true)
    expect(isBlankFrameLike({ isEmpty: () => false, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(4) })).toBe(true)
    expect(isBlankFrameLike({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.alloc(2) })).toBe(true)
  })

  it('全为加载底色 #f8fafc（248,250,252）→ 空白（真实白屏场景）', () => {
    expect(isBlankFrameLike(makeFrame(SIZE, SIZE, () => [248, 250, 252]))).toBe(true)
  })

  it('全为纯白（255,255,255）→ 空白', () => {
    expect(isBlankFrameLike(makeFrame(SIZE, SIZE, () => [255, 255, 255]))).toBe(true)
  })

  it('底色附近波动（JPEG 白底 240-255）→ 空白', () => {
    const f = makeFrame(SIZE, SIZE, (i, j) => [240 + ((i + j) % 12), 242 + ((i + j) % 10), 245 + ((i + j) % 8)])
    expect(isBlankFrameLike(f)).toBe(true)
  })

  it('全黑（视频黑帧/遮幅）→ 非空白（不得误判为白屏）', () => {
    expect(isBlankFrameLike(makeFrame(SIZE, SIZE, () => [0, 0, 0]))).toBe(false)
  })

  it('底色上散布深色文字（真实空态页）→ 非空白', () => {
    // 每 1000 像素行放一个 100x20 的深色文字块（模拟侧栏/文案），采样步长 500 必命中
    const f = makeFrame(SIZE, SIZE, (i, j) => (j >= 0 && j < 20 && i < 2000 ? [30, 41, 59] : [248, 250, 252]))
    expect(isBlankFrameLike(f)).toBe(false)
  })

  it('随机彩色内容（真实界面）→ 非空白', () => {
    const f = makeFrame(SIZE, SIZE, (i, j) => [(i * 7 + j) % 256, (i * 13 + j * 3) % 256, (i * 29 + j * 5) % 256])
    expect(isBlankFrameLike(f)).toBe(false)
  })

  it('深蓝空窗 #0f172a：默认集判非空白（保持既有语义），唤醒扩展集判空白（真机蓝屏残留）', () => {
    const f = makeFrame(SIZE, SIZE, () => [15, 23, 42])
    expect(isBlankFrameLike(f)).toBe(false)
    expect(isBlankFrameLike(f, BLANK_TARGETS_WAKE)).toBe(true)
  })

  it('深蓝附近波动（容差内）→ 唤醒扩展集判空白', () => {
    const f = makeFrame(SIZE, SIZE, (i, j) => [15 + ((i + j) % 10), 23 + ((i + j) % 8), 42 + ((i + j) % 6)])
    expect(isBlankFrameLike(f, BLANK_TARGETS_WAKE)).toBe(true)
  })

  it('全黑（视频黑帧）→ 唤醒扩展集也非空白（防误伤红线保持）', () => {
    expect(isBlankFrameLike(makeFrame(SIZE, SIZE, () => [0, 0, 0]), BLANK_TARGETS_WAKE)).toBe(false)
  })

  it('深灰 #1e293b（surface-800 深色界面）→ 唤醒扩展集非空白（与 #0f172a 色差>12，不误伤）', () => {
    expect(isBlankFrameLike(makeFrame(SIZE, SIZE, () => [30, 41, 59]), BLANK_TARGETS_WAKE)).toBe(false)
  })
})
