/**
 * host.images 能力实现（v2.6.1 协议增量 B14）：宿主内置图像引擎（sharp/libvips）的
 * 「读源 → 内存变换 → 返回编码字节」原语。**宿主不写盘**——输出文件由插件自己落
 * （命名与存在性检查本来就是插件的事）。
 *
 * 为什么引擎住宿主（spike 结论）：插件侧解析链物理上到不了 app.asar 里的 sharp、自带要付
 * 每平台 ~19MB 与版本漂移；宿主自己那份在打包态可 dlopen ⇒ 能力口 + 失败分类都住宿主侧。
 *
 * 三条硬输入（spike 态 2/态 3 实跑）如何落地：
 * 1. **分类不靠引擎文案**：sharp 的失败是聚合 Error（外层 `code=null`、文案随 locale 变甚至乱码），
 *    故本模块只按**失败发生在哪一侧**分类——`readFile` 失败一律 `IMAGES_READ_FAILED`，
 *    sharp 侧（metadata/变换/编码）失败一律 `IMAGES_DECODE_FAILED`；引擎原文只进宿主日志。
 * 2. **引擎加载失败只记一次日志**：加载结果（成功与否）缓存，失败后每次调用都以
 *    `IMAGES_ENGINE_UNAVAILABLE` 失败，不再重复尝试与刷屏。
 * 3. 像素闸先于解码：`metadata()`（`limitInputPixels: false`，只读头部）拿真实宽高，
 *    `w*h > limitPixels` → `IMAGES_TOO_LARGE`（文案报实际宽高与上限）；再以 limitInputPixels
 *    打开做变换（上限 io 可注入，单测用小上限 + 小图钉住）。
 *
 * 顺序契约（写进 PLUGIN.md）：**crop → rotate → resize**；crop 矩形相对**源图**（sharp 的
 * extract 本就在 rotate 之前按其坐标校验，实测 extract 先于 rotate 生效），90/270 旋转交换宽高，
 * 故 resize 的 contain/scale 计算按旋转后的有效宽高进行。
 */
import path from 'node:path'
import type { PluginBusinessError } from '../../plugins/types'

/** 像素闸上限（w*h 超限 → IMAGES_TOO_LARGE，解码前拒）；io.limitPixels 可注入缩小（单测用） */
export const IMAGES_LIMIT_PIXELS = 100_000_000
/** 编码质量缺省档（1..100；png 忽略） */
export const IMAGES_DEFAULT_QUALITY = 85
/** 非 alpha 输出格式（jpeg）的透明底合成色缺省（与既有白底口径一致） */
export const IMAGES_DEFAULT_FLATTEN = '#ffffff'

export type ImagesFormat = 'jpeg' | 'png' | 'webp'

/** 带 code 的业务错误（与 host.fileError 同形状；本模块不 import host——避免 host ↔ images 循环依赖） */
function bizError(code: string, msg: string): PluginBusinessError {
  const e = new Error(msg) as PluginBusinessError
  e.code = code
  return e
}

/** sharp 流水线的最小结构类型（不 import sharp 值——node 下可测、与引擎解耦；真 sharp 由装配层收窄注入） */
export interface SharpInstanceLike {
  metadata(): Promise<{ format?: string; width?: number; height?: number }>
  extract(region: { left: number; top: number; width: number; height: number }): SharpInstanceLike
  rotate(angle: number): SharpInstanceLike
  resize(width: number, height: number, options: { fit: 'fill' }): SharpInstanceLike
  flatten(options: { background: string }): SharpInstanceLike
  withMetadata(): SharpInstanceLike
  jpeg(options: { quality: number }): SharpInstanceLike
  png(): SharpInstanceLike
  webp(options: { quality: number }): SharpInstanceLike
  toBuffer(options: {
    resolveWithObject: true
  }): Promise<{ data: Buffer; info: { width: number; height: number; size: number; format: string } }>
}

/** sharp 工厂最小结构类型：`sharp(buffer, { limitInputPixels })` */
export interface SharpFactoryLike {
  (input: Buffer, options?: { limitInputPixels?: number | boolean }): SharpInstanceLike
}

/** 契约请求形状（与 `PluginHost.images.transform(req)` 的 req 逐字段一致） */
export interface ImagesTransformRequest {
  source: string
  format?: ImagesFormat
  quality?: number
  maxWidth?: number
  maxHeight?: number
  scale?: number
  stretch?: boolean
  rotate?: 0 | 90 | 180 | 270
  crop?: { x: number; y: number; w: number; h: number }
  cropRatio?: number
  flatten?: string
  keepMetadata?: boolean
}

export interface ImagesTransformResult {
  data: Uint8Array
  width: number
  height: number
  bytes: number
  format: ImagesFormat
}

export interface ImagesIo {
  /** 延迟加载引擎（装配层注入 `await import('sharp')` 的结果）；抛错 = 引擎不可用 */
  loadSharp(): Promise<SharpFactoryLike>
  readFile(p: string): Promise<Buffer>
  log(level: 'info' | 'warn' | 'error', msg: string): void
  /** 像素闸上限（缺省 IMAGES_LIMIT_PIXELS=1e8；单测注入小值钉 TOO_LARGE） */
  limitPixels?: number
}

export interface ImagesCapability {
  transform(req: ImagesTransformRequest): Promise<ImagesTransformResult>
}

/** 参数校验后的规范化请求（缺省档落在这里，后续流程不再判 undefined） */
interface ParsedRequest {
  source: string
  format?: ImagesFormat
  quality: number
  maxWidth?: number
  maxHeight?: number
  scale?: number
  stretch: boolean
  rotate: 0 | 90 | 180 | 270
  crop?: { x: number; y: number; w: number; h: number }
  cropRatio?: number
  flatten: string
  keepMetadata: boolean
}

const SUPPORTED_FORMATS: readonly ImagesFormat[] = ['jpeg', 'png', 'webp']

function badRequest(detail: string): PluginBusinessError {
  return bizError('IMAGES_BAD_REQUEST', `图片变换参数非法：${detail}`)
}

/** 有限数字（拒绝 NaN/Infinity/字符串数字——插件侧类型错误要显式报，不猜） */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 插件传入的请求体（`unknown` 面）：逐字段校验 + 缺省档归一；垃圾参数 → IMAGES_BAD_REQUEST */
function parseRequest(raw: unknown): ParsedRequest {
  if (typeof raw !== 'object' || raw === null) throw badRequest('请求体须为对象')
  const o = raw as Record<string, unknown>

  if (typeof o.source !== 'string' || o.source === '') {
    throw badRequest('source 须为非空字符串（源图绝对路径）')
  }

  // 输出格式：显式值不在三格式内 → 专用码（不是"参数非法"，是"该格式不支持"）
  let format: ImagesFormat | undefined
  if (o.format !== undefined) {
    if (typeof o.format !== 'string' || !SUPPORTED_FORMATS.includes(o.format as ImagesFormat)) {
      throw bizError(
        'IMAGES_UNSUPPORTED_FORMAT',
        `不支持的输出格式：${String(o.format)}（仅支持 jpeg / png / webp）`,
      )
    }
    format = o.format as ImagesFormat
  }

  let quality = IMAGES_DEFAULT_QUALITY
  if (o.quality !== undefined) {
    if (!isFiniteNumber(o.quality) || o.quality < 1 || o.quality > 100) {
      throw badRequest('quality 须为 1..100 的数字')
    }
    quality = o.quality
  }

  if (o.maxWidth !== undefined && !(isFiniteNumber(o.maxWidth) && o.maxWidth > 0)) {
    throw badRequest('maxWidth 须为正数')
  }
  if (o.maxHeight !== undefined && !(isFiniteNumber(o.maxHeight) && o.maxHeight > 0)) {
    throw badRequest('maxHeight 须为正数')
  }
  if (o.scale !== undefined && !(isFiniteNumber(o.scale) && o.scale > 0)) {
    throw badRequest('scale 须为正数（倍率）')
  }
  if (o.stretch !== undefined && typeof o.stretch !== 'boolean') {
    throw badRequest('stretch 须为布尔值')
  }
  if (o.rotate !== undefined && o.rotate !== 0 && o.rotate !== 90 && o.rotate !== 180 && o.rotate !== 270) {
    throw badRequest('rotate 只支持 0 / 90 / 180 / 270')
  }
  if (o.cropRatio !== undefined && !(isFiniteNumber(o.cropRatio) && o.cropRatio > 0)) {
    throw badRequest('cropRatio 须为正数')
  }
  if (o.flatten !== undefined && (typeof o.flatten !== 'string' || o.flatten === '')) {
    throw badRequest('flatten 须为非空颜色字符串（如 "#ffffff"）')
  }
  if (o.keepMetadata !== undefined && typeof o.keepMetadata !== 'boolean') {
    throw badRequest('keepMetadata 须为布尔值')
  }

  let crop: ParsedRequest['crop']
  if (o.crop !== undefined) {
    if (typeof o.crop !== 'object' || o.crop === null) throw badRequest('crop 须为 { x, y, w, h } 数字矩形')
    const c = o.crop as Record<string, unknown>
    if (!isFiniteNumber(c.x) || !isFiniteNumber(c.y) || !isFiniteNumber(c.w) || !isFiniteNumber(c.h)) {
      throw badRequest('crop 须为 { x, y, w, h } 数字矩形')
    }
    crop = { x: c.x, y: c.y, w: c.w, h: c.h }
  }

  return {
    source: o.source,
    format,
    quality,
    maxWidth: o.maxWidth as number | undefined,
    maxHeight: o.maxHeight as number | undefined,
    scale: o.scale as number | undefined,
    stretch: o.stretch === true,
    rotate: (o.rotate ?? 0) as 0 | 90 | 180 | 270,
    crop,
    cropRatio: o.cropRatio as number | undefined,
    flatten: typeof o.flatten === 'string' ? o.flatten : IMAGES_DEFAULT_FLATTEN,
    keepMetadata: o.keepMetadata === true,
  }
}

/** 引擎读出的真实格式 → 三格式（jpg 归一为 jpeg）；认不出 → null（调用方按 UNSUPPORTED_FORMAT 拒） */
function normalizeFormat(raw: string): ImagesFormat | null {
  if (raw === 'jpeg' || raw === 'jpg') return 'jpeg'
  if (raw === 'png') return 'png'
  if (raw === 'webp') return 'webp'
  return null
}

/**
 * 缺省输出格式（缺省随源）：`.png→png / .webp→webp / 其余→jpeg`；
 * 扩展名不认识时看真实格式，仍不认识按 jpeg。
 */
function defaultFormat(source: string, realFormat: ImagesFormat): ImagesFormat {
  const ext = path.extname(source).toLowerCase()
  if (ext === '.png') return 'png'
  if (ext === '.webp') return 'webp'
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg'
  return realFormat ?? 'jpeg'
}

/**
 * 裁剪矩形：crop（相对源图）越界部分按图幅取整求交；与图幅无交集 → IMAGES_CROP_OUT_OF_RANGE。
 * 带 cropRatio 时取交集内最大等比框，锚点 = 交集左上角。两者都没有 → null（不裁剪）。
 */
function cropRect(
  crop: ParsedRequest['crop'],
  cropRatio: number | undefined,
  srcW: number,
  srcH: number,
): { left: number; top: number; width: number; height: number } | null {
  if (!crop && cropRatio === undefined) return null
  let left = 0
  let top = 0
  let right = srcW
  let bottom = srcH
  if (crop) {
    // 取整求交：左上 floor、右下 ceil（小数矩形也能落进整像素网格）
    left = Math.max(0, Math.floor(crop.x))
    top = Math.max(0, Math.floor(crop.y))
    right = Math.min(srcW, Math.ceil(crop.x + crop.w))
    bottom = Math.min(srcH, Math.ceil(crop.y + crop.h))
  }
  let width = right - left
  let height = bottom - top
  if (width <= 0 || height <= 0) {
    throw bizError('IMAGES_CROP_OUT_OF_RANGE', '裁剪区域与图幅无交集（请检查 crop 的 x / y / w / h）')
  }
  if (cropRatio !== undefined) {
    // 最大等比框：受较短边限制，锚点固定为交集左上角（w/h 比 cropRatio 大则压宽，否则压高）
    if (width / height > cropRatio) width = Math.max(1, Math.round(height * cropRatio))
    else height = Math.max(1, Math.round(width / cropRatio))
  }
  return { left, top, width, height }
}

/**
 * resize 目标尺寸（三档优先级：scale > stretch > contain）；null = 不 resize。
 * dims 是 resize 实际看到的宽高（crop 后、rotate 后的有效宽高）。
 */
function resizeTarget(
  dims: { width: number; height: number },
  req: ParsedRequest,
): { width: number; height: number } | null {
  if (req.scale !== undefined) {
    const width = Math.max(1, Math.round(dims.width * req.scale))
    const height = Math.max(1, Math.round(dims.height * req.scale))
    return width === dims.width && height === dims.height ? null : { width, height }
  }
  if (req.stretch && req.maxWidth !== undefined && req.maxHeight !== undefined) {
    // 精确宽高：不保比例（两值都给才算精确档）
    return { width: Math.max(1, Math.round(req.maxWidth)), height: Math.max(1, Math.round(req.maxHeight)) }
  }
  // contain（默认档）：等比内缩，**绝不放大**——r >= 1 一律不动
  const ratios: number[] = []
  if (req.maxWidth !== undefined) ratios.push(req.maxWidth / dims.width)
  if (req.maxHeight !== undefined) ratios.push(req.maxHeight / dims.height)
  if (ratios.length === 0) return null
  const r = Math.min(...ratios)
  if (!(r < 1)) return null
  return {
    width: Math.max(1, Math.round(dims.width * r)),
    height: Math.max(1, Math.round(dims.height * r)),
  }
}

export function createImagesCapability(io: ImagesIo): ImagesCapability {
  const limitPixels = io.limitPixels ?? IMAGES_LIMIT_PIXELS

  // 引擎加载：只尝试一次（成功缓存 / 失败记住），失败只记一次日志 ⇒ 之后每次调用直接
  // IMAGES_ENGINE_UNAVAILABLE（不重试、不刷屏）。
  let engineOk: SharpFactoryLike | null = null
  let engineFailed = false
  let engineLoading: Promise<void> | null = null
  async function engine(): Promise<SharpFactoryLike> {
    if (!engineOk && !engineFailed) {
      if (!engineLoading) {
        engineLoading = io.loadSharp().then(
          (sharp) => {
            engineOk = sharp
          },
          (err) => {
            engineFailed = true
            io.log(
              'error',
              `[images] 图像引擎加载失败（宿主内置 sharp 不可用），本实例后续图像调用将统一以 IMAGES_ENGINE_UNAVAILABLE 失败：${err instanceof Error ? err.message : String(err)}`,
            )
          },
        )
      }
      await engineLoading
    }
    if (!engineOk) {
      throw bizError('IMAGES_ENGINE_UNAVAILABLE', '图像引擎不可用（宿主内置图像组件加载失败），请重启宿主或更新后再试')
    }
    return engineOk
  }

  /** sharp 侧失败统一落点：原文只进宿主日志，插件拿到一句话 + 稳定码（分类不读引擎文案） */
  function decodeFailed(source: string, err: unknown): never {
    io.log('warn', `[images] 图像解码失败（${source}）：${err instanceof Error ? err.message : String(err)}`)
    throw bizError('IMAGES_DECODE_FAILED', '图片解码失败（文件损坏或不是有效图片）')
  }

  async function transform(raw: ImagesTransformRequest): Promise<ImagesTransformResult> {
    const req = parseRequest(raw)
    // 引擎优先于读文件：引擎不可用时**每次调用**都以 ENGINE_UNAVAILABLE 失败（spike 硬输入②）
    const sharp = await engine()

    let buf: Buffer
    try {
      // 宿主自己读源：sharp 只吃 Buffer（文件级失败 = READ_FAILED，与 sharp 侧失败可分辨）
      buf = await io.readFile(req.source)
    } catch (err) {
      io.log('warn', `[images] 源图读取失败（${req.source}）：${err instanceof Error ? err.message : String(err)}`)
      throw bizError('IMAGES_READ_FAILED', '读取源图失败，请确认文件存在且可读')
    }

    // 像素闸（解码前）：metadata 只读头部，limitInputPixels: false 保证大图也能拿到真实宽高如实上报
    const meta = await sharp(buf, { limitInputPixels: false })
      .metadata()
      .catch((err: unknown) => decodeFailed(req.source, err))
    const srcW = meta.width
    const srcH = meta.height
    if (!srcW || !srcH || !meta.format) decodeFailed(req.source, new Error('图像元数据缺宽高/格式'))
    if (srcW * srcH > limitPixels) {
      throw bizError(
        'IMAGES_TOO_LARGE',
        `图片像素过大：${srcW}×${srcH}（共 ${srcW * srcH} 像素），超过上限 ${limitPixels} 像素`,
      )
    }
    const realFormat = normalizeFormat(meta.format)
    if (!realFormat) {
      throw bizError(
        'IMAGES_UNSUPPORTED_FORMAT',
        `不支持的图片格式：${meta.format}（仅支持 JPEG / PNG / WebP）`,
      )
    }
    const outFormat = req.format ?? defaultFormat(req.source, realFormat)

    try {
      let pipe = sharp(buf, { limitInputPixels: limitPixels })
      const rect = cropRect(req.crop, req.cropRatio, srcW, srcH)
      if (rect) pipe = pipe.extract(rect)
      if (req.rotate !== 0) pipe = pipe.rotate(req.rotate)
      // resize 看到的是 crop 后、rotate 后的有效宽高（90/270 交换宽高）
      const baseW = rect ? rect.width : srcW
      const baseH = rect ? rect.height : srcH
      const swapped = req.rotate === 90 || req.rotate === 270
      const target = resizeTarget({ width: swapped ? baseH : baseW, height: swapped ? baseW : baseH }, req)
      if (target) pipe = pipe.resize(target.width, target.height, { fit: 'fill' })
      // 透明底：仅输出非 alpha 格式（jpeg）时合成；缺省白（旧 canvas 路径修过的 2.4 缺陷）
      if (outFormat === 'jpeg') pipe = pipe.flatten({ background: req.flatten })
      if (req.keepMetadata) pipe = pipe.withMetadata() // 缺省不带 = 剥 EXIF/ICC（与旧 canvas 路径同效）
      if (outFormat === 'jpeg') pipe = pipe.jpeg({ quality: req.quality })
      else if (outFormat === 'png') pipe = pipe.png() // png 忽略 quality
      else pipe = pipe.webp({ quality: req.quality })

      const out = await pipe.toBuffer({ resolveWithObject: true })
      return {
        data: new Uint8Array(out.data), // 拷贝出 sharp 的池化内存，返回独立 Uint8Array
        width: out.info.width,
        height: out.info.height,
        bytes: out.info.size,
        format: outFormat,
      }
    } catch (err) {
      if ((err as { code?: string } | null)?.code) throw err // 已分类的业务错误（如 CROP_OUT_OF_RANGE）原样透传
      return decodeFailed(req.source, err)
    }
  }

  return { transform }
}