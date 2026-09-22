/**
 * 应用内更新的**纯判据层**（v2.6 批 4）：形态判据 / 完整性校验 / AppImage 落盘动作。
 *
 * 为什么不堆在 `updater.ts` 里：与 `core/relaunch.ts`、`core/autoLaunch.ts` 同一条纪律——
 * **判据纯 TS、electron 与 electron-updater 全部住 `src/main/updaterMain.ts` 薄壳**，
 * 这样三平台分叉（NSIS / AppImage / deb）能在 Linux 宿主上 node 直测，而不靠真机挂账。
 *
 * 三件事：
 *   ① `resolveUpdateChannel`：本机该走哪条更新路（唯一判据；判据口径与 electron-updater
 *      自己挑 Updater 实现的规则对齐——APPIMAGE 环境变量、resources/package-type）；
 *   ② `verifyDownloadedFile`：下载回来的包**逐字节**复算哈希再交给安装器，不匹配即删残包；
 *   ③ `replaceAppImage`：AppImage 自更新的落盘动作（原地同名覆盖 + 可执行位）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

/**
 * 匿名更新面（feed 根）。**跨项目接触点，逐字符不许改**；该地址**设计上必须公开**
 * （客户端要自己按它取更新），所以它写在公开仓里，不算基础设施泄漏：
 * - ERP 侧（闭源）发布脚本与站点配置申报**同一地址**，形态为扁平静态目录
 *   （`latest.yml` / `latest-linux.yml` / 全量包 / blockmap）；
 * - 本仓 `electron-builder.yml` 的 `publish: generic` URL（由 `tests/unit/updaterInstall.test.ts` 锚定同源）。
 * 任一漂移 ⇒ 客户端静默取不到 feed（404 落 SPA 兜底时甚至是 200 + text/html 的假面）。
 */
export const UPDATE_FEED_URL = 'https://www.qihebook.cloud/updates/box/'

/** 更新形态：决定「能不能应用内安装」以及安装动作走哪条路 */
export type UpdateChannel =
  /** Windows NSIS 安装包：完整自更新（下载 → 退出静默安装 → 重启） */
  | 'nsis'
  /** AppImage：自更新（替换本体文件后重启） */
  | 'appimage'
  /** deb：**官方不支持**自更新（直链口径）→ UI 走「提示 + 一键直链 /file-manager」 */
  | 'deb'
  /** 未打包实例（开发/预览）或非目标平台/非本仓包型：不做应用内更新，也不谎报成 deb */
  | 'unsupported'

export interface UpdateChannelInput {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  isPackaged: boolean
  /** `resources/package-type` 内容（electron-builder 给 deb/rpm/pacman 包写的标记）；读不到给 null */
  packageType?: string | null
}

/**
 * 本机更新形态（单一判据，别在别处再散写 `process.platform === …`）。
 * 顺序即优先级：Windows 先判（APPIMAGE 在 Windows 上不存在）；APPIMAGE 环境变量在位即 AppImage
 * 形态（`process.execPath` 住在 `/tmp/.mount_XXXX/` 挂载点里，只有它指向本体）；
 * 其余 Linux 已打包 = deb（本仓 Linux 只出 AppImage + deb 两个 target）；
 * 未打包 / darwin / rpm·pacman 一律 unsupported。
 */
export function resolveUpdateChannel(input: UpdateChannelInput): UpdateChannel {
  if (input.platform === 'win32') return 'nsis'
  if (input.env.APPIMAGE) return 'appimage'
  if (input.platform !== 'linux') return 'unsupported'
  if (input.packageType) return input.packageType === 'deb' ? 'deb' : 'unsupported'
  return input.isPackaged ? 'deb' : 'unsupported'
}

/** 有「退出并安装」按钮的形态（deb / unsupported 只有「提示 + 直链」） */
export function canInstallInApp(channel: UpdateChannel): boolean {
  return channel === 'nsis' || channel === 'appimage'
}

export const UPDATE_UNSUPPORTED_CODE = 'update-unsupported'

/** 可判别的「本形态不支持应用内更新」——UI 据此落直链分支（IPC 错误串之外还留了 code/channel） */
export class UpdateUnsupportedError extends Error {
  readonly code = UPDATE_UNSUPPORTED_CODE
  readonly channel: UpdateChannel
  constructor(channel: UpdateChannel) {
    super(
      channel === 'deb'
        ? '当前为 deb 安装版：官方不支持 deb 的应用内自动更新，请前往官网下载新版本，或改用 AppImage 版'
        : '当前实例（开发/预览或非目标平台）不支持应用内更新，请前往官网下载新版本',
    )
    this.name = 'UpdateUnsupportedError'
    this.channel = channel
  }
}

// —— 完整性校验 ——

export type DigestAlgo = 'sha256' | 'sha512'

export interface ExpectedDigest {
  algo: DigestAlgo
  value: string
}

/**
 * 解析更新面申报的校验值。认三种写法，其余一律 null（**不许「解析不出来就当通过」**）：
 * - `sha256:<64hex>` / 裸 `<64hex>`（`/version.json` 的 checksum 口径）；
 * - `sha512:<base64>` / `sha512-<base64>` / 裸 `<base64>`（electron-builder 写进 `latest*.yml` 的 sha512，
 *   88 字符 base64，解出 64 字节才算数）。
 */
export function parseExpectedDigest(raw: string): ExpectedDigest | null {
  const s = raw.trim()
  if (!s) return null
  const prefixed = /^(sha256|sha512)\s*[:\-]\s*(\S+)$/i.exec(s)
  const algo = (prefixed?.[1]?.toLowerCase() as DigestAlgo | undefined) ?? null
  const body = prefixed ? prefixed[2] : s
  if (algo === 'sha256' || (!algo && /^[0-9a-f]{64}$/i.test(body))) {
    return /^[0-9a-f]{64}$/i.test(body) ? { algo: 'sha256', value: body.toLowerCase() } : null
  }
  if (algo === 'sha512') {
    return /^[A-Za-z0-9+/]+={0,2}$/.test(body) && Buffer.from(body, 'base64').length === 64
      ? { algo: 'sha512', value: body }
      : null
  }
  // 无前缀的 base64（88 字符）按 sha512 认
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(body) && Buffer.from(body, 'base64').length === 64) {
    return { algo: 'sha512', value: body }
  }
  return null
}

/** 流式摘要：115MB 的包不许整块进内存 */
async function digestOf(file: string, algo: DigestAlgo): Promise<string> {
  const hash = crypto.createHash(algo)
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest(algo === 'sha256' ? 'hex' : 'base64')
}

export const UPDATE_CHECKSUM_MISMATCH_CODE = 'update-checksum-mismatch'

/** 校验不通过（半截 / 被改过的包）——**残包已被删掉**，绝不会交到安装器手里 */
export class UpdateChecksumMismatchError extends Error {
  readonly code = UPDATE_CHECKSUM_MISMATCH_CODE
  readonly algo: DigestAlgo
  readonly expected: string
  readonly actual: string
  constructor(algo: DigestAlgo, expected: string, actual: string) {
    super(
      `更新包校验不通过（${algo}）：更新面申报 ${expected}，实际 ${actual}。已删除残包，请重试或前往官网下载`,
    )
    this.name = 'UpdateChecksumMismatchError'
    this.algo = algo
    this.expected = expected
    this.actual = actual
  }
}

/**
 * 逐字节复算下载回来的包：命中静默通过；不命中 **删残包 + 抛可判别的错**。
 * 是不是与 electron-updater 自己的 sha512 校验重复？——是同一个申报值，但这条是我们的
 * **自持闸**：库升级/替换都不改变「没算过哈希的包不许进安装器」这条纪律，且它可由单测断言
 * （库内部行为测不到）。复算代价 = 读一遍 115MB（本地 SSD 亚秒级）。
 */
export async function verifyDownloadedFile(file: string, expected: string): Promise<void> {
  const want = parseExpectedDigest(expected)
  if (!want) {
    throw new Error(`更新包校验值不可解析：${expected || '(空)'}——拒绝安装（宁可不更新）`)
  }
  let actual: string
  try {
    actual = await digestOf(file, want.algo)
  } catch {
    throw new Error(`更新包读不到（下载未完成或被清理）：${file}`)
  }
  if (actual !== want.value) {
    await fsp.rm(file, { force: true }).catch(() => {
      /* 删失败不掩盖主因：校验不通过才是要报的事，残留由下次下载覆盖 */
    })
    throw new UpdateChecksumMismatchError(want.algo, want.value, actual)
  }
}

/**
 * AppImage 自更新的落盘动作（`applyUpdate` 的 appimage 分支；判据纯函数便于宿主直测）：
 * 新包先写到同目录的临时名 → 给可执行位 → `rename` **原地同名覆盖** `env.APPIMAGE`
 * （名字保持不变：自启项 `.desktop`、桌面快捷方式、用户书签指的都是同一个路径）。
 *
 * 为什么不用 electron-updater 的 AppImageUpdater 装：它先 `unlink` 旧文件再搬新的
 * （`AppImageUpdater.doInstall`），任一步失败都留下「本体没了」的砖态；且在包名带版本号时
 * 会换成新文件名（用户手上的路径随之变化）。本实现任一步失败旧文件都原地可用。
 */
export function replaceAppImage(from: string, to: string): void {
  if (!fs.existsSync(from)) throw new Error(`更新包不存在：${from}`)
  const staged = `${to}.qihe-new`
  try {
    fs.copyFileSync(from, staged)
    fs.chmodSync(staged, 0o755)
    fs.renameSync(staged, to)
  } catch (err) {
    try {
      fs.rmSync(staged, { force: true })
    } catch {
      /* 清理失败不掩盖主因 */
    }
    throw new Error(
      `替换 AppImage 失败（${
        err instanceof Error ? err.message : String(err)
      }）：文件可能不在可写目录，请手动下载新版本（原文件未改动）`,
    )
  }
}

// —— 引擎（真实实现在 updaterMain.ts；这里只定义契约，便于单测注入替身）——

export interface DownloadedUpdate {
  /** 已落盘的更新包路径 */
  file: string
  /** 更新面申报的 sha512(base64)——交给 verifyDownloadedFile 复算 */
  sha512: string
  /** 更新面申报的版本号 */
  version: string
}

export interface UpdateProgress {
  phase: 'downloading' | 'verifying'
  percent: number
  transferred: number
  total: number
  bytesPerSecond?: number
}

export interface UpdateEngine {
  /** 本机形态（判据在 resolveUpdateChannel，薄壳只负责喂环境事实） */
  channel: UpdateChannel
  /** 下载到更新面的全量包（进度经 onProgress 回流给渲染层） */
  download(onProgress: (progress: UpdateProgress) => void): Promise<DownloadedUpdate>
  /** 安装（进程即将退出）：nsis 交 NSIS 安装器；appimage 替换本体后走既有重启通道 */
  install(file: string): void
}