/**
 * 自动更新（对照原 Go internal/updater）
 * 阶段 8 完善：保留 /version.json 检查机制。
 * - checkUpdate：拉取发布源对比版本，有新版返回 UpdateInfo，无更新返回 null
 * - downloadUpdate / applyUpdate：应用内安装尚未就绪，仍抛「尚未就绪」
 *   引导用户前往官网下载全新安装包（Profile 页已提供入口）
 */
export interface UpdateInfo {
  version: string
  download_url: string
  checksum: string
  release_notes: string
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

export async function downloadUpdate(_info: UpdateInfo): Promise<string> {
  // 应用内下载安装尚未就绪：引导用户前往官网下载全新安装包
  throw new Error('更新下载尚未就绪，请前往官网下载最新安装包')
}

export async function applyUpdate(_installerPath: string, _checksum: string): Promise<void> {
  // 应用内下载安装尚未就绪：引导用户前往官网下载全新安装包
  throw new Error('更新安装尚未就绪，请前往官网下载最新安装包')
}
