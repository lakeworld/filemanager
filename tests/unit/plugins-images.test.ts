/**
 * host.images 能力单测（v2.6.1 协议增量 B14）：**真 sharp**（本机 node_modules 有）+ 临时目录现造小图。
 *
 * 为什么用真引擎：本能力的契约面（像素闸、contain 不放大、透明底铺白、元数据剥离、真实编码）
 * 全靠 libvips 行为背书，假引擎只能钉自己的想象——设计稿要的 14 条判据里过半是引擎语义。
 * io 注入只替换 loadSharp / readFile / limitPixels（装配层那层真链在 plugins-contract.test.ts
 * 的 contract:v1:host.images self-check 里跑：真 registerPluginHost + 真 sharp + 真 fsp）。
 *
 * 判据取向（契约卡 B14）：顺序 crop → rotate → resize；crop 相对源图；contain 绝不放大；
 * jpeg 透明底缺省铺白（旧 canvas 路径修过的 2.4 缺陷，这里必须钉住）；缺省剥元数据；
 * 文件级失败 READ_FAILED 与 sharp 侧 DECODE_FAILED 可分辨；引擎不可用每次调用同一码、日志只记一次。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import {
  createImagesCapability,
  IMAGES_LIMIT_PIXELS,
  type ImagesCapability,
  type ImagesIo,
  type SharpFactoryLike,
} from '../../src/main/plugins/images'

const sharpFactory = sharp as unknown as SharpFactoryLike

let tmpDir = ''

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-images-'))
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

/** 真 sharp 的 io：loadSharp/readFile 全真实，只有日志被收集（每条用例独立实例，引擎态不串） */
function makeCap(overrides: Partial<ImagesIo> = {}): { cap: ImagesCapability; logs: string[] } {
  const logs: string[] = []
  const cap = createImagesCapability({
    loadSharp: async () => sharpFactory,
    readFile: (p) => fsp.readFile(p),
    log: (level, msg) => {
      logs.push(`${level}:${msg}`)
    },
    ...overrides,
  })
  return { cap, logs }
}

/** 现造纯色 PNG 写盘（alpha 给定时 4 通道） */
async function writePng(
  name: string,
  w: number,
  h: number,
  background: { r: number; g: number; b: number; alpha?: number },
): Promise<string> {
  const p = path.join(tmpDir, name)
  const channels = background.alpha === undefined ? 3 : 4
  await sharp({ create: { width: w, height: h, channels, background } }).png().toFile(p)
  return p
}

/** 现造「左半红 / 右半蓝」PNG（crop 相对源图 + 旋转方向可分辨） */
async function writeHalvesPng(name: string, w: number, h: number): Promise<string> {
  const ch = 4
  const raw = Buffer.alloc(w * h * ch)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      const left = x < w / 2
      raw[i] = left ? 255 : 0
      raw[i + 1] = 0
      raw[i + 2] = left ? 0 : 255
      raw[i + 3] = 255
    }
  }
  const p = path.join(tmpDir, name)
  await sharp(raw, { raw: { width: w, height: h, channels: ch } }).png().toFile(p)
  return p
}

/** 返回编码字节的真实宽高/格式（回读断言用——不信 transform 的自述） */
async function metaOf(data: Uint8Array): Promise<{ width: number; height: number; format?: string }> {
  const m = await sharp(Buffer.from(data)).metadata()
  return { width: m.width ?? 0, height: m.height ?? 0, format: m.format }
}

/** 解码首像素（RGB，铺白/铺黑断言用） */
async function firstPixel(data: Uint8Array): Promise<number[]> {
  const r = await sharp(Buffer.from(data)).raw().toBuffer({ resolveWithObject: true })
  return [r.data[0], r.data[1], r.data[2]]
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

describe('resize 三档：contain（默认，绝不放大）/ stretch（精确）/ scale（优先）', () => {
  it('contain 等比内缩且给出精确宽高（8×4 + maxWidth 4/maxHeight 4 → 4×2；maxWidth 2 → 2×1）', async () => {
    const src = await writePng('resize-contain.png', 8, 4, { r: 200, g: 60, b: 60 })
    const { cap } = makeCap()
    const a = await cap.transform({ source: src, format: 'png', maxWidth: 4, maxHeight: 4 })
    expect({ w: a.width, h: a.height }).toEqual({ w: 4, h: 2 })
    // 回读真实编码再证一次（不信自述）
    const b = await cap.transform({ source: src, format: 'png', maxWidth: 2 })
    expect(await metaOf(b.data)).toMatchObject({ width: 2, height: 1, format: 'png' })
  })

  it('contain 绝不放大：源比上限小 → 原尺寸不动（1×1 上限也只保原样）', async () => {
    const src = await writePng('resize-noenlarge.png', 8, 4, { r: 20, g: 160, b: 90 })
    const { cap } = makeCap()
    const big = await cap.transform({ source: src, format: 'png', maxWidth: 100, maxHeight: 100 })
    expect({ w: big.width, h: big.height }).toEqual({ w: 8, h: 4 })
    const one = await cap.transform({ source: src, format: 'png', maxWidth: 1, maxHeight: 1 })
    // r=min(1/8,1/4)=0.125 → round(8*0.125)=1 / round(4*0.125)=1（像素下限 1）
    expect({ w: one.width, h: one.height }).toEqual({ w: 1, h: 1 })
  })

  it('stretch 精确宽高不保比例（6×2）；只给一个边时不进精确档（按 contain 缩）', async () => {
    const src = await writePng('resize-stretch.png', 8, 4, { r: 90, g: 90, b: 200 })
    const { cap } = makeCap()
    const st = await cap.transform({ source: src, format: 'png', maxWidth: 6, maxHeight: 2, stretch: true })
    expect({ w: st.width, h: st.height }).toEqual({ w: 6, h: 2 }) // 6:2 ≠ 源 2:1 ⇒ 确实没保比例
    const half = await cap.transform({ source: src, format: 'png', maxWidth: 6, stretch: true })
    expect({ w: half.width, h: half.height }).toEqual({ w: 6, h: 3 }) // 单边 → 回落 contain（等比）
  })

  it('scale 优先于 maxWidth/maxHeight：0.5 缩放 + maxWidth 2 → 4×2（不是 2×1）；允许显式放大', async () => {
    const src = await writePng('resize-scale.png', 8, 4, { r: 120, g: 40, b: 160 })
    const { cap } = makeCap()
    const down = await cap.transform({ source: src, format: 'png', scale: 0.5, maxWidth: 2, maxHeight: 2 })
    expect({ w: down.width, h: down.height }).toEqual({ w: 4, h: 2 })
    const up = await cap.transform({ source: src, format: 'png', scale: 2, maxWidth: 1 })
    expect({ w: up.width, h: up.height }).toEqual({ w: 16, h: 8 }) // 显式倍率不受 contain 约束
  })
})

describe('rotate：0/90/180/270，90/270 交换宽高（resize 看到旋转后的宽高）', () => {
  it('rotate 90 交换宽高（8×4 → 4×8）；180 不变；270 也交换', async () => {
    const src = await writePng('rotate.png', 8, 4, { r: 40, g: 120, b: 220 })
    const { cap } = makeCap()
    const r90 = await cap.transform({ source: src, format: 'png', rotate: 90 })
    expect({ w: r90.width, h: r90.height }).toEqual({ w: 4, h: 8 })
    const r180 = await cap.transform({ source: src, format: 'png', rotate: 180 })
    expect({ w: r180.width, h: r180.height }).toEqual({ w: 8, h: 4 })
    const r270 = await cap.transform({ source: src, format: 'png', rotate: 270 })
    expect({ w: r270.width, h: r270.height }).toEqual({ w: 4, h: 8 })
  })

  it('rotate 后再 contain：maxWidth 按旋转后的宽（4×8 + maxWidth 2 → 2×4，不是 2×1）', async () => {
    const src = await writePng('rotate-resize.png', 8, 4, { r: 220, g: 140, b: 40 })
    const { cap } = makeCap()
    const out = await cap.transform({ source: src, format: 'png', rotate: 90, maxWidth: 2 })
    expect({ w: out.width, h: out.height }).toEqual({ w: 2, h: 4 })
  })
})

describe('crop：相对源图取整求交 / 无交集报错 / 三件套顺序 crop → rotate → resize', () => {
  it('越界负坐标按图幅求交（8×4 + {x:-4,y:-4,w:8,h:8} → 4×4）', async () => {
    const src = await writePng('crop-clamp.png', 8, 4, { r: 60, g: 60, b: 60 })
    const { cap } = makeCap()
    const out = await cap.transform({ source: src, format: 'png', crop: { x: -4, y: -4, w: 8, h: 8 } })
    expect({ w: out.width, h: out.height }).toEqual({ w: 4, h: 4 })
  })

  it('右下越界求交（8×4 + {x:6,y:2,w:10,h:10} → 2×2）', async () => {
    const src = await writePng('crop-clamp2.png', 8, 4, { r: 60, g: 120, b: 60 })
    const { cap } = makeCap()
    const out = await cap.transform({ source: src, format: 'png', crop: { x: 6, y: 2, w: 10, h: 10 } })
    expect({ w: out.width, h: out.height }).toEqual({ w: 2, h: 2 })
  })

  it('与图幅无交集 → IMAGES_CROP_OUT_OF_RANGE（不是静默空图）', async () => {
    const src = await writePng('crop-out.png', 8, 4, { r: 30, g: 30, b: 30 })
    const { cap } = makeCap()
    expect(await codeOf(cap.transform({ source: src, crop: { x: 100, y: 0, w: 10, h: 10 } }))).toBe(
      'IMAGES_CROP_OUT_OF_RANGE',
    )
    expect(await codeOf(cap.transform({ source: src, crop: { x: 0, y: 0, w: 0, h: 4 } }))).toBe(
      'IMAGES_CROP_OUT_OF_RANGE',
    )
  })

  it('顺序契约：crop 取源图右半（x:4 已超出旋转后图幅）→ rotate 90 → 仍成功且内容 = 右半蓝', async () => {
    const src = await writeHalvesPng('crop-order.png', 8, 4)
    const { cap } = makeCap()
    const out = await cap.transform({ source: src, format: 'png', crop: { x: 4, y: 0, w: 4, h: 4 }, rotate: 90 })
    expect({ w: out.width, h: out.height }).toEqual({ w: 4, h: 4 })
    // 若实现成「先 rotate 再 crop」，x:4 在 4×8 图幅上无交集 → 早就 CROP_OUT_OF_RANGE；
    // 这里成功且像素是右半的蓝 ⇒ crop 确实相对源图、且先于 rotate。
    expect(await firstPixel(out.data)).toEqual([0, 0, 255])
  })

  it('crop + rotate + resize 三件套同给：crop 4×4 → rotate 90 → contain 2×2', async () => {
    const src = await writeHalvesPng('crop-order2.png', 8, 4)
    const { cap } = makeCap()
    const out = await cap.transform({
      source: src,
      format: 'png',
      crop: { x: 0, y: 0, w: 4, h: 4 },
      rotate: 90,
      maxWidth: 2,
      maxHeight: 2,
    })
    expect({ w: out.width, h: out.height }).toEqual({ w: 2, h: 2 })
    expect(await firstPixel(out.data)).toEqual([255, 0, 0]) // 取的是左半红
  })
})

describe('cropRatio：交集内最大等比框（锚点 = 交集左上角）', () => {
  it('8×4 + crop 全幅 + cropRatio 1 → 4×4（受高限制）', async () => {
    const src = await writePng('ratio-1.png', 8, 4, { r: 10, g: 10, b: 200 })
    const { cap } = makeCap()
    const out = await cap.transform({ source: src, format: 'png', crop: { x: 0, y: 0, w: 8, h: 4 }, cropRatio: 1 })
    expect({ w: out.width, h: out.height }).toEqual({ w: 4, h: 4 })
  })

  it('cropRatio 0.5 → 2×4（受宽限制）；无 crop 时以全图为交集基底（8×4 + ratio 1 → 4×4）', async () => {
    const src = await writePng('ratio-2.png', 8, 4, { r: 200, g: 10, b: 10 })
    const { cap } = makeCap()
    const narrow = await cap.transform({
      source: src,
      format: 'png',
      crop: { x: 0, y: 0, w: 8, h: 4 },
      cropRatio: 0.5,
    })
    expect({ w: narrow.width, h: narrow.height }).toEqual({ w: 2, h: 4 })
    const full = await cap.transform({ source: src, format: 'png', cropRatio: 1 })
    expect({ w: full.width, h: full.height }).toEqual({ w: 4, h: 4 })
  })
})

describe('输出格式与编码字节', () => {
  it('缺省随源：.png → png（魔数 89504e47）；.jpg → jpeg；扩展名不认识看真实格式', async () => {
    const png = await writePng('fmt.png', 4, 4, { r: 77, g: 88, b: 99 })
    const jpg = path.join(tmpDir, 'fmt.jpg')
    await sharp(png).jpeg().toFile(jpg)
    const unknown = path.join(tmpDir, 'fmt.unknown-ext')
    await fsp.copyFile(png, unknown)
    const { cap } = makeCap()

    const a = await cap.transform({ source: png })
    expect(a.format).toBe('png')
    expect(Buffer.from(a.data.slice(0, 4)).toString('hex')).toBe('89504e47')
    expect(a.bytes).toBe(a.data.length)

    const b = await cap.transform({ source: jpg })
    expect(b.format).toBe('jpeg')
    expect(Buffer.from(b.data.slice(0, 2)).toString('hex')).toBe('ffd8')

    const c = await cap.transform({ source: unknown })
    expect(c.format).toBe('png') // 扩展名不认识 → 看真实格式
  })

  it('显式 format：webp 魔数 52494646（RIFF）；返回的 data/width/height/bytes/format 与真实编码一致', async () => {
    const src = await writePng('fmt-webp.png', 8, 4, { r: 5, g: 250, b: 5 })
    const { cap } = makeCap()
    const out = await cap.transform({ source: src, format: 'webp', maxWidth: 4 })
    expect(out.format).toBe('webp')
    expect(Buffer.from(out.data.slice(0, 4)).toString('hex')).toBe('52494646')
    expect(out.bytes).toBe(out.data.length)
    expect(await metaOf(out.data)).toMatchObject({ width: 4, height: 2, format: 'webp' })
    expect({ w: out.width, h: out.height }).toEqual({ w: 4, h: 2 })
  })

  it('不支持的 format 值 → IMAGES_UNSUPPORTED_FORMAT；源内容不是三格式（gif）→ 同码', async () => {
    const src = await writePng('fmt-unsup.png', 4, 4, { r: 1, g: 2, b: 3 })
    const { cap } = makeCap()
    expect(await codeOf(cap.transform({ source: src, format: 'gif' as unknown as 'png' }))).toBe(
      'IMAGES_UNSUPPORTED_FORMAT',
    )
    const gifPath = path.join(tmpDir, 'one.gif')
    await fsp.writeFile(
      gifPath,
      Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex'),
    )
    expect(await codeOf(cap.transform({ source: gifPath }))).toBe('IMAGES_UNSUPPORTED_FORMAT')
  })

  it('宿主不写盘：transform 只在内存产生字节，临时目录文件数不变', async () => {
    const dir = path.join(tmpDir, 'nofs')
    await fsp.mkdir(dir, { recursive: true })
    const src = path.join(dir, 'src.png')
    await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toFile(src)
    const before = await fsp.readdir(dir)
    const { cap } = makeCap()
    const out = await cap.transform({ source: src, format: 'png', maxWidth: 2 })
    expect(out.data.length).toBeGreaterThan(0)
    expect(await fsp.readdir(dir)).toEqual(before) // 没有产物落盘（输出文件归插件）
  })
})

describe('jpeg 透明底与元数据', () => {
  it('全透明 PNG 转 jpeg：缺省铺白（不是黑——旧 canvas 路径修过的 2.4 缺陷钉）；显式 flatten 黑则铺黑', async () => {
    const src = await writePng('alpha.png', 4, 4, { r: 0, g: 0, b: 0, alpha: 0 })
    const { cap } = makeCap()
    const white = await cap.transform({ source: src, format: 'jpeg' })
    const wp = await firstPixel(white.data)
    for (const c of wp) expect(c, '缺省白底（#ffffff）').toBeGreaterThan(200)
    const black = await cap.transform({ source: src, format: 'jpeg', flatten: '#000000' })
    const bp = await firstPixel(black.data)
    for (const c of bp) expect(c, '显式 flatten 被尊重').toBeLessThan(20)
  })

  it('缺省剥元数据（EXIF 不进输出）；keepMetadata: true 才保留', async () => {
    const src = path.join(tmpDir, 'exif.jpg')
    await sharp({ create: { width: 6, height: 6, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'qihe-images-unit' } })
      .toFile(src)
    const { cap } = makeCap()
    const stripped = await cap.transform({ source: src, format: 'jpeg' })
    expect((await sharp(Buffer.from(stripped.data)).metadata()).exif, '缺省剥 EXIF').toBeUndefined()
    const kept = await cap.transform({ source: src, format: 'jpeg', keepMetadata: true })
    expect((await sharp(Buffer.from(kept.data)).metadata()).exif, 'keepMetadata: true 保留 EXIF').toBeDefined()
  })
})

describe('错误分类：参数 / 文件级 / 解码级 / 引擎级 / 像素闸', () => {
  it('缺参数与垃圾参数 → IMAGES_BAD_REQUEST，且不触碰引擎与文件（校验先行）', async () => {
    const { cap } = makeCap({
      loadSharp: async () => {
        throw new Error('校验先行：不应加载引擎')
      },
      readFile: async () => {
        throw new Error('校验先行：不应读文件')
      },
    })
    const cases: Array<Record<string, unknown>> = [
      {},
      { source: 42 },
      { source: '' },
      { source: '/x.png', quality: 0 },
      { source: '/x.png', quality: 101 },
      { source: '/x.png', quality: '85' },
      { source: '/x.png', rotate: 45 },
      { source: '/x.png', scale: 0 },
      { source: '/x.png', maxWidth: -1 },
      { source: '/x.png', maxHeight: Number.NaN },
      { source: '/x.png', crop: { x: 0, y: 0, w: '4', h: 4 } },
      { source: '/x.png', crop: 'soon' },
      { source: '/x.png', cropRatio: 0 },
      { source: '/x.png', stretch: 1 },
      { source: '/x.png', flatten: '' },
      { source: '/x.png', keepMetadata: 'yes' },
    ]
    for (const c of cases) {
      expect(await codeOf(cap.transform(c as never)), `应拒绝：${JSON.stringify(c)}`).toBe('IMAGES_BAD_REQUEST')
    }
    expect(await codeOf(cap.transform(null as never))).toBe('IMAGES_BAD_REQUEST')
  })

  it('源不存在（文件级失败）→ IMAGES_READ_FAILED；原始原因只进日志', async () => {
    const { cap, logs } = makeCap()
    const missing = path.join(tmpDir, 'does-not-exist.png')
    expect(await codeOf(cap.transform({ source: missing }))).toBe('IMAGES_READ_FAILED')
    expect(logs.some((l) => l.includes('源图读取失败'))).toBe(true)
  })

  it('坏图（随便几个字节）→ IMAGES_DECODE_FAILED（sharp 侧失败，与 READ 可分辨）', async () => {
    const bad = path.join(tmpDir, 'junk.png')
    await fsp.writeFile(bad, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))
    const { cap, logs } = makeCap()
    expect(await codeOf(cap.transform({ source: bad }))).toBe('IMAGES_DECODE_FAILED')
    expect(logs.some((l) => l.includes('图像解码失败'))).toBe(true)
  })

  it('引擎加载抛错 → 每次调用都 IMAGES_ENGINE_UNAVAILABLE，日志只记一次（不刷屏）', async () => {
    const { cap, logs } = makeCap({
      loadSharp: async () => {
        throw new Error('ERR_DLOPEN_FAILED: libvips-cpp.so: cannot open shared object file')
      },
    })
    const src = await writePng('engine.png', 4, 4, { r: 1, g: 1, b: 1 })
    expect(await codeOf(cap.transform({ source: src }))).toBe('IMAGES_ENGINE_UNAVAILABLE')
    expect(await codeOf(cap.transform({ source: src }))).toBe('IMAGES_ENGINE_UNAVAILABLE')
    expect(await codeOf(cap.transform({ source: 'whatever.png' }))).toBe('IMAGES_ENGINE_UNAVAILABLE')
    expect(logs.filter((l) => l.includes('引擎加载失败'))).toHaveLength(1)
    // 引擎原文只进日志、不进用户面（spike 硬输入①：不能把引擎文案端给用户）
    expect(logs.some((l) => l.includes('ERR_DLOPEN_FAILED'))).toBe(true)
  })

  it('像素闸：注入小上限 + 超限图 → IMAGES_TOO_LARGE，文案报实际宽高与上限；限内正常', async () => {
    expect(IMAGES_LIMIT_PIXELS).toBe(100_000_000) // 契约口径：宿主默认上限 1e8
    const big = await writePng('pixels-big.png', 40, 40, { r: 8, g: 8, b: 8 }) // 1600 像素
    const small = await writePng('pixels-small.png', 10, 10, { r: 8, g: 8, b: 8 }) // 100 像素
    const { cap } = makeCap({ limitPixels: 1000 })
    const err = await cap.transform({ source: big }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    )
    expect(err?.code).toBe('IMAGES_TOO_LARGE')
    expect(err?.message).toContain('40×40')
    expect(err?.message).toContain('1000')
    const ok = await cap.transform({ source: small, format: 'png' })
    expect({ w: ok.width, h: ok.height }).toEqual({ w: 10, h: 10 }) // 上限是闸不是恒拒
  })

  it('quality 档生效不报错（1..100 边界值均可编码）；png 忽略 quality', async () => {
    const src = await writePng('quality.png', 8, 8, { r: 120, g: 130, b: 140 })
    const { cap } = makeCap()
    const q1 = await cap.transform({ source: src, format: 'jpeg', quality: 1 })
    const q100 = await cap.transform({ source: src, format: 'jpeg', quality: 100 })
    expect(q1.bytes).toBeGreaterThan(0)
    expect(q100.bytes).toBeGreaterThan(q1.bytes) // 质量档真进了编码器
    const png = await cap.transform({ source: src, format: 'png', quality: 1 })
    expect(png.format).toBe('png')
  })
})