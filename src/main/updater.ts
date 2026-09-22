/**
 * 自动更新（对照原 Go internal/updater）
 * - checkUpdate：拉取发布源对比版本，有新版返回 UpdateInfo，无更新返回 null
 * - downloadUpdate / applyUpdate：v2.6 批 4 起**应用内落地**（判据在 core/updatePlan.ts，
 *   electron-updater 只在 src/main/updaterMain.ts 薄壳里）：
 *   下载 → 更新面申报的 sha512 逐字节复算 → 交安装器（NSIS / AppImage）/ deb 抛不支持走直链。
 *   三平台口径与决策见内部设计文档（D-UP1/D-UP3）。
 */
import fs from 'node:fs'
import {
  UpdateUnsupportedError,
  canInstallInApp,
  verifyDownloadedFile,
  type UpdateChannel,
  type UpdateEngine,
  type UpdateProgress,
} from './core/updatePlan'

export interface UpdateInfo {
  version: string
  download_url: string
  checksum: string
  release_notes: string
}

// v2.4.7（评审 P1）：更新可用状态缓存——runUpdateCheck 发现新版时写入；
// Profile 页懒加载可能错过启动时的 update:available 事件，渲染层通过 updater:state 主动查询兜底
let cachedUpdate: UpdateInfo | null = null

export function setCachedUpdate(info: UpdateInfo | null): void {
  cachedUpdate = info
}

export function getCachedUpdate(): UpdateInfo | null {
  return cachedUpdate
}

const VERSION_URL = 'https://www.qihebook.cloud/version.json'
const REQUEST_TIMEOUT_MS = 10_000

/** 版本号规范化：去首尾空白与可选 v 前缀（version.json / app.getVersion 可能带 v） */
function normalizeVersion(s: string): string {
  return s.trim().replace(/^v/i, '')
}

/**
 * 手写语义化版本比较（按 . 分段数值比较，支持 2.3.1 形式；不引入新依赖）。
 * 返回 >0 表示 a 比 b 新，<0 表示 a 比 b 旧，0 相等。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    normalizeVersion(v)
      .split('.')
      .map((s) => {
        const n = Number.parseInt(s, 10)
        return Number.isNaN(n) ? 0 : n
      })
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/**
 * 检查更新：从发布源 /version.json 拉取最新版本信息。
 * - 远端版本 > 当前 → 返回 UpdateInfo
 * - 相等 / 更低 / 无新版本 → 返回 null
 * - 网络 / 超时 / 解析失败 → 抛出 Error('检查更新失败：...')
 * @param fetchImpl 网络实现（默认全局 fetch，测试注入）
 */
export async function checkUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const resp = await fetchImpl(VERSION_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as Partial<UpdateInfo>
    if (!data || typeof data.version !== 'string' || typeof data.download_url !== 'string') {
      throw new Error('返回格式非法（缺少 version 或 download_url）')
    }
    if (compareVersions(data.version, currentVersion) <= 0) return null
    return {
      version: normalizeVersion(data.version),
      download_url: data.download_url,
      checksum: data.checksum ?? '',
      release_notes: data.release_notes ?? '',
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('检查更新失败：请求超时')
    }
    throw new Error(`检查更新失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 下载与安装的账目（v2.6 批 4）：**只有校验过的包才能进这一格**——applyUpdate 只认它，
 * 不认渲染层递上来的路径（渲染层手上的 `checksum` 是 /version.json 的 deb 口径，
 * 与 win/AppImage 包不是同一条哈希，拿它当安装前校验必然假红）。
 */
let pendingUpdate: { file: string; version: string } | null = null

export interface UpdateRunOptions {
  /** 注入引擎（单测替身）；缺省 = 真实薄壳 updaterMain.ts（动态 import，单测不碰 electron） */
  engine?: UpdateEngine
  /** 下载/校验进度回流（IPC 层转成事件推给渲染层） */
  onProgress?: (progress: UpdateProgress) => void
}

async function engineOf(opts: UpdateRunOptions): Promise<UpdateEngine> {
  if (opts.engine) return opts.engine
  const shell = await import('./updaterMain')
  return shell.createUpdateEngine()
}

/** 本机更新形态（供「检查更新」页决定分支：能装 → 「退出并安装」；不能装 → 提示 + 一键直链） */
export interface UpdateCapability {
  channel: UpdateChannel
  canInstallInApp: boolean
}

export async function updateCapability(opts: UpdateRunOptions = {}): Promise<UpdateCapability> {
  const engine = await engineOf(opts)
  return { channel: engine.channel, canInstallInApp: canInstallInApp(engine.channel) }
}

/**
 * 下载更新包（更新面全量包），完成后**逐字节复算哈希**再记账。
 * - deb / unsupported：抛可判别的 UpdateUnsupportedError（零下载；UI 落 D-UP1 直链分支）
 * - 校验不通过：删残包 + 抛（不留半截包等着被装）
 * @returns 已落盘并通过校验的更新包路径
 */
export async function downloadUpdate(
  info: UpdateInfo,
  opts: UpdateRunOptions = {},
): Promise<string> {
  const engine = await engineOf(opts)
  if (!canInstallInApp(engine.channel)) throw new UpdateUnsupportedError(engine.channel)
  const done = await engine.download((progress) => opts.onProgress?.(progress))
  // 哈希那一段也要给渲染层回声（115MB 的包复算不是瞬时的，别让界面看着像卡住）
  opts.onProgress?.({ phase: 'verifying', percent: 100, transferred: 0, total: 0 })
  await verifyDownloadedFile(done.file, done.sha512)
  pendingUpdate = { file: done.file, version: done.version || info.version }
  return done.file
}

/**
 * 退出并安装（进程会退出）：nsis 交 NSIS 安装器、appimage 替换本体后走既有重启通道。
 * 账清在**安装动作交出去且成功之后**——安装失败（如 AppImage 本体所在目录不可写）时账还在，
 * 用户可原地重试，不必为一个已经下好并校验过的包再走一次 110MB 下载。
 */
export async function applyUpdate(opts: UpdateRunOptions = {}): Promise<void> {
  const engine = await engineOf(opts)
  if (!canInstallInApp(engine.channel)) throw new UpdateUnsupportedError(engine.channel)
  const pending = pendingUpdate
  if (!pending) throw new Error('没有已下载的更新包，请先下载更新')
  if (!fs.existsSync(pending.file)) {
    pendingUpdate = null
    throw new Error('更新包已不存在（可能被清理），请重新下载')
  }
  engine.install(pending.file)
  pendingUpdate = null
}
