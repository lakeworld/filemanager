/**
 * 官方索引形态的包体下载（v2.6 批 2，宿主侧）：登录态 + 流式落盘 + **逐字节 SHA-256 校验**。
 *
 * 契约出处 = 公开 `docs/PLUGIN.md` §5.3 `install({ downloadUrl, sha256 })`（本轮由「当前未实现」改为实装口径）。
 * 纪律：
 * - **未登录不发起下载**（先判登录态，再碰网络）；
 * - 下载地址只接受 https，或与云基址**同源**的 http（自建/内网部署；官方索引恒为 https）；
 * - 校验不符 → **删临时文件 + 中文原因**，包体永不进安装管线（不落盘半包）；
 * - 成功返回临时 `.qbox` 路径，由调用方（IPC 层）在安装结束后删除（`finally`）。
 *
 * 纯 TS：不 import electron，`fetchImpl` 可注入 → node 直测（tests/unit/plugins-download.test.ts）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** 中文错误码（形如 `CODE：人话`；渲染层按 CODE 决定引导路径） */
export const DOWNLOAD_ERRORS = {
  NOT_LOGGED_IN: 'DOWNLOAD_NOT_LOGGED_IN：下载官方插件需要登录——请先登录启禾云账号后重试',
  URL_UNTRUSTED: 'DOWNLOAD_URL_UNTRUSTED：插件下载地址不受信任',
  BAD_SHA256: 'DOWNLOAD_BAD_SHA256：插件包校验值（sha256）非法——应为 64 位十六进制字符串',
  FAILED: 'DOWNLOAD_FAILED：插件下载失败',
  NO_BODY: 'DOWNLOAD_FAILED：插件下载失败——服务端未返回包体',
  HASH_MISMATCH: 'DOWNLOAD_HASH_MISMATCH：插件包校验失败——SHA-256 与官方索引不一致，已放弃安装',
} as const

/** 非 2xx → 中文人话（404 最可能是「该版本还没上传」，与目录链的未部署区分开） */
export function downloadHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return `DOWNLOAD_NOT_LOGGED_IN：下载官方插件需要登录（HTTP ${status}）——请重新登录后重试`
  }
  if (status === 404) {
    return `DOWNLOAD_FAILED：插件包不存在（HTTP 404）——该版本可能尚未上传，请稍后重试或联系官方`
  }
  return `DOWNLOAD_FAILED：插件下载失败（HTTP ${status}）——请稍后重试`
}

/** 校验值形状：64 位十六进制（大小写不敏感，统一小写比较） */
export function normalizeSha256(sha256: unknown): string {
  const s = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(DOWNLOAD_ERRORS.BAD_SHA256)
  return s
}

/**
 * 下载地址策略：https 一律放行；http 仅当与云基址同源（自建/内网部署）。
 * 其余协议（file:/data: 等）、异源 http、非法 URL → 拒绝（防「索引被改一行就把任意地址拉进宿主」）。
 */
export function isTrustedDownloadUrl(url: string, baseUrl: string): boolean {
  let target: URL
  try {
    target = new URL(String(url ?? '').trim())
  } catch {
    return false
  }
  if (target.protocol === 'https:') return true
  if (target.protocol !== 'http:') return false
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).origin === target.origin
  } catch {
    return false
  }
}

/** 下载地址策略断言（失败 → 中文错误；不进下载函数体，便于单测直接打） */
export function assertTrustedDownloadUrl(url: string, baseUrl: string): void {
  if (!isTrustedDownloadUrl(url, baseUrl)) {
    throw new Error(`${DOWNLOAD_ERRORS.URL_UNTRUSTED}（仅允许 https，或与云服务同源的 http）：${String(url ?? '')}`)
  }
}

export interface DownloadRequest {
  downloadUrl: string
  /** 官方索引声明的 .qbox 整体 SHA-256 */
  sha256: string
  /** 临时文件落地目录（userData/plugins；与安装器同盘，rename 不被跨设备阻挡） */
  destDir: string
}

export interface DownloadDeps {
  /** 云 API 基址（仅用于 http 同源判定） */
  baseUrl: string
  /** 登录态 token（null = 未登录 → 不发起下载） */
  getToken: () => string | null
  fetchImpl?: typeof fetch
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/**
 * 下载 + 校验 → 返回临时 `.qbox` 路径与字节数（**调用方负责删除临时文件**）。
 * 任何失败路径都不留半包（临时文件在抛出前删除）。
 */
export async function downloadPluginPackage(
  deps: DownloadDeps,
  req: DownloadRequest,
): Promise<{ filePath: string; size: number }> {
  const expected = normalizeSha256(req.sha256)
  assertTrustedDownloadUrl(req.downloadUrl, deps.baseUrl)
  const token = deps.getToken()
  if (!token) throw new Error(DOWNLOAD_ERRORS.NOT_LOGGED_IN)

  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(req.downloadUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }).catch((err: unknown) => {
    deps.log?.('warn', `[plugins] 官方包下载网络失败：${String(err)}`)
    return null
  })
  if (!res) throw new Error(`${DOWNLOAD_ERRORS.FAILED}（网络不可达）——请检查网络后重试`)
  if (!res.ok) throw new Error(downloadHttpError(res.status))
  if (!res.body) throw new Error(DOWNLOAD_ERRORS.NO_BODY)

  await fsp.mkdir(req.destDir, { recursive: true })
  const filePath = path.join(req.destDir, `.tmp-download-${process.pid}-${Date.now()}.qbox`)
  const hash = createHash('sha256')
  const fh = await fsp.open(filePath, 'w')
  let size = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length > 0) {
        hash.update(value)
        await fh.write(value)
        size += value.length
      }
    }
    await fh.close()
  } catch (err) {
    await fh.close().catch(() => {})
    await fsp.rm(filePath, { force: true }).catch(() => {})
    throw new Error(`${DOWNLOAD_ERRORS.FAILED}（写入中断：${err instanceof Error ? err.message : String(err)}）`)
  }

  const actual = hash.digest('hex')
  if (actual !== expected) {
    // 校验不符：删包体、不进安装管线（不落盘半包 = 「校验失败拒绝安装」的可验证形态）
    await fsp.rm(filePath, { force: true }).catch(() => {})
    throw new Error(
      `${DOWNLOAD_ERRORS.HASH_MISMATCH}（本地 ${actual.slice(0, 12)}… ≠ 索引 ${expected.slice(0, 12)}…）`,
    )
  }
  if (size === 0) {
    await fsp.rm(filePath, { force: true }).catch(() => {})
    throw new Error(`${DOWNLOAD_ERRORS.FAILED}（包体为空）`)
  }
  deps.log?.('info', `[plugins] 官方包下载完成：${size} B（sha256=${actual.slice(0, 12)}…）`)
  return { filePath, size }
}