import { describe, it, expect } from 'vitest'
import {
  isBlankFrameLike,
  BLANK_TARGETS_WAKE,
  classifyFrameWitness,
  encodeWitnessToken,
  decodeWitnessToken,
  WITNESS_GRID_N,
  WITNESS_DATA_IDX,
  type FrameLike,
  type WitnessGridLayout,
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

describe('isBlankFrameLike（休眠唤醒白屏像素检测）', () => {
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

// —— v2.5.3 常驻轻壳：FrameWitness 新鲜帧验证（T1）——
// 渲染层隐藏后绘制 5×5 品牌蓝网格（四角定位格恒品牌蓝，中间 21 格编码 token bit）；
// 主进程 capturePage(rect,{stayHidden}) 后 toBitmap() BGRA 逐格采样解码 → 分类。
// 与 e2e 探针（tests/e2e/frame-witness-probe.spec.ts）同几何契约。

/** 构造带 FrameWitness 网格的 BGRA 帧 fake：scale=DPI 缩放（bitmap 像素 = DIP × scale） */
function makeWitnessFrame(
  layout: WitnessGridLayout,
  token: number,
  scale: number,
  opts?: { brandTolerance?: boolean; paintCorners?: boolean },
): FrameLike {
  const w = Math.round(layout.rect.width * scale)
  const h = Math.round(layout.rect.height * scale)
  const buf = Buffer.alloc(w * h * 4)
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= w || py >= h) return
    const o = (py * w + px) * 4
    buf[o] = b
    buf[o + 1] = g
    buf[o + 2] = r
    buf[o + 3] = 255
  }
  const brand = opts?.brandTolerance ? [47 + 8, 111 + 6, 237 - 10] : [47, 111, 237]
  for (let i = 0; i < WITNESS_GRID_N * WITNESS_GRID_N; i++) {
    const r = Math.floor(i / WITNESS_GRID_N)
    const c = i % WITNESS_GRID_N
    const cx = (layout.originX + c * (layout.cell + layout.gap) + layout.cell / 2 - layout.rect.x) * scale
    const cy = (layout.originY + r * (layout.cell + layout.gap) + layout.cell / 2 - layout.rect.y) * scale
    const isCorner = WITNESS_DATA_IDX.indexOf(i) === -1
    const bit = isCorner ? 1 : ((token >> WITNESS_DATA_IDX.indexOf(i)) & 1)
    // 填充 cell 中心及邻域（覆盖采样点 + 容差）
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const paint = isCorner ? (opts?.paintCorners ?? true) : true
        if (paint && bit === 1) put(cx + dx, cy + dy, brand[0], brand[1], brand[2])
        else put(cx + dx, cy + dy, 255, 255, 255)
      }
    }
  }
  return {
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    toBitmap: () => buf,
  }
}

const WITNESS_LAYOUT: WitnessGridLayout = {
  rect: { x: 100, y: 100, width: 400, height: 400 },
  n: WITNESS_GRID_N,
  cell: 56,
  gap: 20,
  originX: 140,
  originY: 140,
}

const TOKEN_A = 0b101010101010101010101
const TOKEN_B = 0b010101010101010101010

describe('encodeWitnessToken / decodeWitnessToken（21-bit 截断）', () => {
  it('encode 取低 21 位（generation 高位截断）', () => {
    expect(encodeWitnessToken(1)).toBe(1)
    expect(encodeWitnessToken(0x1fffff)).toBe(0x1fffff)
    expect(encodeWitnessToken(0x200000)).toBe(0) // 第 22 位被截断
    expect(encodeWitnessToken(0x3fffff)).toBe(0x1fffff)
  })

  it('decode 幂等：decode(encode(gen)) 复原低 21 位', () => {
    for (const gen of [0, 1, 42, 123456, 0x1fffff, 0x200001]) {
      expect(decodeWitnessToken(encodeWitnessToken(gen))).toBe(gen & 0x1fffff)
    }
  })
})

describe('classifyFrameWitness（FrameWitness 新鲜帧分类）', () => {
  it('空图 / 尺寸 0 / buffer 过短 → unknown', () => {
    expect(
      classifyFrameWitness(
        { isEmpty: () => true, getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.alloc(0) },
        TOKEN_A,
        WITNESS_LAYOUT,
      ),
    ).toBe('unknown')
    expect(
      classifyFrameWitness(
        { isEmpty: () => false, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(4) },
        TOKEN_A,
        WITNESS_LAYOUT,
      ),
    ).toBe('unknown')
    expect(
      classifyFrameWitness(
        { isEmpty: () => false, getSize: () => ({ width: 10, height: 10 }), toBitmap: () => Buffer.alloc(2) },
        TOKEN_A,
        WITNESS_LAYOUT,
      ),
    ).toBe('unknown')
  })

  it('全底色（白屏）→ blank', () => {
    const f = makeFrame(SIZE, SIZE, () => [248, 250, 252])
    expect(classifyFrameWitness(f, TOKEN_A, WITNESS_LAYOUT)).toBe('blank')
  })

  it('正确 token 网格 → match', () => {
    const f = makeWitnessFrame(WITNESS_LAYOUT, TOKEN_A, 1)
    expect(classifyFrameWitness(f, TOKEN_A, WITNESS_LAYOUT)).toBe('match')
  })

  it('旧 token 网格（stale）→ stale，非 match', () => {
    const f = makeWitnessFrame(WITNESS_LAYOUT, TOKEN_B, 1)
    expect(classifyFrameWitness(f, TOKEN_A, WITNESS_LAYOUT)).toBe('stale')
  })

  it('品牌蓝 ±容差内波动仍识别（色差容差）', () => {
    const f = makeWitnessFrame(WITNESS_LAYOUT, TOKEN_A, 1, { brandTolerance: true })
    expect(classifyFrameWitness(f, TOKEN_A, WITNESS_LAYOUT)).toBe('match')
  })

  it('四角定位格被伪造但 token 错 → stale（仍非 match）', () => {
    // 定位格照常品牌蓝（伪造），但数据格 token 错 → 分类必须 stale 而非 match
    const f = makeWitnessFrame(WITNESS_LAYOUT, TOKEN_B, 1, { paintCorners: true })
    expect(classifyFrameWitness(f, TOKEN_A, WITNESS_LAYOUT)).toBe('stale')
  })

  it('DPI 缩放推导：125% / 150% / 200% 网格仍 match', () => {
    for (const scale of [1.25, 1.5, 2]) {
      const f = makeWitnessFrame(WITNESS_LAYOUT, TOKEN_A, scale)
      expect(classifyFrameWitness(f, TOKEN_A, WITNESS_LAYOUT), `scale=${scale}`).toBe('match')
    }
  })

  it('无网格（正常业务界面）→ 无法定位 → unknown', () => {
    const f = makeFrame(SIZE, SIZE, (i, j) => [(i * 7 + j) % 256, (i * 13 + j * 3) % 256, (i * 29 + j * 5) % 256])
    expect(classifyFrameWitness(f, TOKEN_A, WITNESS_LAYOUT)).toBe('unknown')
  })
})
