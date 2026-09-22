/**
 * 官方索引目录（v2.6 批 2，宿主侧）：登录态拉取 + 严格解析 + versions 兼容映射。
 *
 * 契约出处 = 公开 `docs/PLUGIN.md` §5.3 `catalog()`（本轮由「当前未实现」改为实装口径）。
 * 数据源 = 启禾云账号 API（与账号/云通道同基址，登录态 JWT），端点约定：
 *
 *   GET {base}/api/box/plugin-catalog              Authorization: Bearer <JWT>
 *   200 → { code: 200, data: { generatedAt: <RFC3339>, plugins: [ <原始目录项> ] } }
 *   服务端实际发 `generatedAt`；宿主只认 `code` 与 `data.plugins`，既没有也不校验 `catalog_version`
 *   （2026-09-23 勘正：旧注释写的 `catalog_version: 1` 服务端从未发过）。
 *
 * **未部署 ≠ 空目录**（本模块最重要的一条纪律）：只有 200 + 空列表才返回 `[]`；
 * 404 / 401 / 5xx / 网络不可达 / 形状非法一律抛中文错误，由管理页如实展示（不得谎报"暂无插件"）。
 *
 * 纯 TS：不 import electron，`fetchImpl` 可注入 → node 直测（tests/unit/plugins-catalog.test.ts）。
 */
import { API_VERSION } from '../../plugins/types'
import { versionAtLeast } from './registry'
import type { PluginCatalogEntry, PluginCatalogVersion } from '../../shared/types'

/** 官方目录端点（公开面唯一形状：服务端由启禾云实现，宿主不写死任何服务器地址） */
export const CATALOG_PATH = '/api/box/plugin-catalog'

/** 中文错误码（形如 `CODE：人话`，沿用既有 `DEV_MODE_REQUIRED：` 先例；渲染层按 CODE 决定引导路径） */
export const CATALOG_ERRORS = {
  NO_SERVER:
    'NO_SERVER：当前未配置云服务地址，无法获取官方插件目录（安装包未内置服务地址，或未设置 QIHE_API_BASE）',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN：官方插件目录需要登录——请先在「我的 → 账号」登录启禾云账号后重试',
  NOT_DEPLOYED:
    'NOT_DEPLOYED：官方插件目录服务未就绪（HTTP 404）——服务端尚未部署该功能，请稍后重试或联系官方',
  NETWORK: 'CATALOG_UNAVAILABLE：官方插件目录获取失败（网络不可达）——请检查网络后重试',
  BAD_PAYLOAD: 'CATALOG_BAD_PAYLOAD：官方插件目录返回格式无法识别',
} as const

/** 非 2xx 状态码 → 中文人话（401/403 归登录态，404 归未部署，其余归「稍后重试」） */
export function catalogHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return `NOT_LOGGED_IN：官方插件目录登录态已失效（HTTP ${status}）——请重新登录后重试`
  }
  if (status === 404) return CATALOG_ERRORS.NOT_DEPLOYED
  return `CATALOG_UNAVAILABLE：官方插件目录获取失败（HTTP ${status}）——请稍后重试`
}

/**
 * 端点 URL：基址尾 `/api` 先剥一次再拼路径。
 * 理由与 `main/plugins/encryption.ts`（批 2.5 P0-1）同：`resolveApiBase()` 返回 `…/api`，
 * 直接拼会产生 `/api/api/box/plugin-catalog` 双段——落 SPA 兜底 200 text/html 而真路由 404，
 * 表现为「目录永远是空的」这类最难查的假象。
 */
export function resolveCatalogUrl(baseUrl: string): string {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new Error(CATALOG_ERRORS.NO_SERVER)
  const root = base.endsWith('/api') ? base.slice(0, -4) : base
  return `${root}${CATALOG_PATH}`
}

/** 目录原始项（服务端形状：不含宿主派生的兼容判定字段） */
export type RawCatalogEntry = Omit<PluginCatalogEntry, 'compatible' | 'selected' | 'reason'>

/** 宿主兼容上下文（`API_VERSION` + `app.getVersion()`） */
export interface HostCompat {
  apiVersion: number
  productVersion: string
}

// —— 解析（严格；坏形状 → 中文错误，绝不静默丢条目）——

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function badPayload(detail: string): Error {
  return new Error(`${CATALOG_ERRORS.BAD_PAYLOAD}（${detail}）`)
}

function parseVersion(raw: unknown, where: string): PluginCatalogVersion {
  if (!isPlainObject(raw)) throw badPayload(`${where} 不是对象`)
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (!version) throw badPayload(`${where} 缺少 version`)
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw badPayload(`${where} 的 sha256 不是 64 位十六进制`)
  const downloadUrl = typeof raw.downloadUrl === 'string' ? raw.downloadUrl.trim() : ''
  if (!downloadUrl) throw badPayload(`${where} 缺少 downloadUrl`)

  let apiCompat: [number, number] | undefined
  if (raw.apiCompat !== undefined) {
    const t = raw.apiCompat
    if (
      !Array.isArray(t) ||
      t.length !== 2 ||
      typeof t[0] !== 'number' ||
      typeof t[1] !== 'number' ||
      !Number.isFinite(t[0]) ||
      !Number.isFinite(t[1]) ||
      t[0] > t[1]
    ) {
      throw badPayload(`${where} 的 apiCompat 须为 [min, max] 数值元组（min ≤ max）`)
    }
    apiCompat = [t[0], t[1]]
  }
  let minHostVersion: string | undefined
  if (raw.minHostVersion !== undefined) {
    if (typeof raw.minHostVersion !== 'string' || !raw.minHostVersion.trim()) {
      throw badPayload(`${where} 的 minHostVersion 须为非空字符串`)
    }
    minHostVersion = raw.minHostVersion.trim()
  }
  let size: number | undefined
  if (raw.size !== undefined) {
    if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0) {
      throw badPayload(`${where} 的 size 须为非负数值`)
    }
    size = raw.size
  }
  return { version, ...(apiCompat ? { apiCompat } : {}), ...(minHostVersion ? { minHostVersion } : {}), ...(size !== undefined ? { size } : {}), sha256, downloadUrl }
}

function parseEntry(raw: unknown, idx: number): RawCatalogEntry {
  const where = `第 ${idx + 1} 项`
  if (!isPlainObject(raw)) throw badPayload(`${where} 不是对象`)
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  // id 形状与 manifest 同口径（域名倒序，如 com.qihe.cloud）：粗校验挡住明显坏的键（防「目录项点不动」的哑故障）
  if (!id || !/^[a-z0-9.-]+$/.test(id) || !id.includes('.')) throw badPayload(`${where} 的 id 不合法：${JSON.stringify(raw.id)}`)
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) throw badPayload(`${where}（${id}）缺少 name`)
  if (!Array.isArray(raw.versions) || raw.versions.length === 0) {
    throw badPayload(`${where}（${id}）缺少 versions（至少一个版本）`)
  }
  const versions = raw.versions.map((v, i) => parseVersion(v, `${where}（${id}）的 versions[${i}]`))
  const out: RawCatalogEntry = { id, name, versions }
  if (typeof raw.description === 'string' && raw.description) out.description = raw.description
  if (typeof raw.author === 'string' && raw.author) out.author = raw.author
  if (typeof raw.icon === 'string' && raw.icon) out.icon = raw.icon
  if (typeof raw.source === 'string' && raw.source) out.source = raw.source
  if (isPlainObject(raw.permissions)) out.permissions = raw.permissions as PluginCatalogEntry['permissions']
  return out
}

/**
 * 解析服务端回包 → 原始目录项数组。
 * 宽容两处：`data.plugins`（约定形状）与 `data` 直接是数组（防服务端少包一层导致整条链哑掉）；
 * 其余严格——任一条目坏掉即整体抛错（宁可真话，不静默少一个插件）。
 */
export function parseCatalogPayload(json: unknown): RawCatalogEntry[] {
  if (!isPlainObject(json)) throw badPayload('顶层不是对象')
  if (json.code !== undefined && json.code !== 200) throw badPayload(`code=${JSON.stringify(json.code)}，期望 200`)
  const data = json.data
  const list = Array.isArray(data) ? data : isPlainObject(data) && Array.isArray(data.plugins) ? data.plugins : null
  if (!list) throw badPayload('缺少 data.plugins 数组')
  return list.map((e, i) => parseEntry(e, i))
}

// —— 兼容映射（versions.json 语义：插件版本 → 所需宿主 API 版本）——

/** 语义化版本比对：核心数字段逐段比；有预发布段者小于同核心的正式版（`1.0.0-rc1 < 1.0.0`） */
export function compareSemver(a: string, b: string): number {
  const split = (s: string): { core: number[]; pre: string | null } => {
    const [head, ...rest] = String(s).split('+')[0].split('-')
    return { core: head.split('.').map((x) => parseInt(x, 10) || 0), pre: rest.length ? rest.join('-') : null }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const dx = x.core[i] ?? 0
    const dy = y.core[i] ?? 0
    if (dx !== dy) return dx > dy ? 1 : -1
  }
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre > y.pre ? 1 : -1
}

/** 单版本兼容判定：apiCompat 缺省视为 [1,1]（与 manifest 同口径）；声明 minHostVersion 时产品版本须 ≥ 之 */
export function isVersionCompatible(v: PluginCatalogVersion, host: HostCompat): boolean {
  const [min, max] = v.apiCompat ?? [API_VERSION, API_VERSION]
  if (host.apiVersion < min || host.apiVersion > max) return false
  if (v.minHostVersion && !versionAtLeast(host.productVersion, v.minHostVersion)) return false
  return true
}

/**
 * 选版：全部兼容版本里取**语义化版本最高**者（不是数组最后一个——服务端顺序漂移不该改变宿主行为）。
 * 无兼容版本 → null（调用方标「不兼容」并置灰，不提供下载）。
 */
export function resolveCompatibleVersion(
  versions: PluginCatalogVersion[],
  host: HostCompat,
): PluginCatalogVersion | null {
  let best: PluginCatalogVersion | null = null
  for (const v of versions) {
    if (!isVersionCompatible(v, host)) continue
    if (!best || compareSemver(v.version, best.version) > 0) best = v
  }
  return best
}

/** 原始目录项 → 渲染层目录条目（补宿主派生的 `compatible` / `selected` / `reason`） */
export function toCatalogEntries(raw: RawCatalogEntry[], host: HostCompat): PluginCatalogEntry[] {
  return raw.map((e) => {
    const selected = resolveCompatibleVersion(e.versions, host)
    if (selected) return { ...e, compatible: true, selected }
    return {
      ...e,
      compatible: false,
      reason: `无与当前宿主兼容的版本（宿主 API v${host.apiVersion} / 产品 ${host.productVersion}）——请升级应用后重试`,
    }
  })
}

// —— 拉取（登录态；只此一处发请求）——

export interface CatalogFetchDeps {
  /** 云 API 基址（装配层 `resolveApiBase()`；空 = 未配置 → NO_SERVER） */
  baseUrl: string
  /** 登录态 token（null = 未登录 → NOT_LOGGED_IN，**不发起请求**） */
  getToken: () => string | null
  /** 网络实现（默认全局 fetch；测试注入） */
  fetchImpl?: typeof fetch
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/**
 * 拉取官方目录（进入管理页时调用一次；**不后台轮询**——网络常驻红线）。
 * 失败一律抛中文错误（见 §模块头）；成功返回宿主已判兼容性的目录条目。
 */
export async function fetchCatalog(deps: CatalogFetchDeps, host: HostCompat): Promise<PluginCatalogEntry[]> {
  const url = resolveCatalogUrl(deps.baseUrl) // 未配置服务器 → NO_SERVER（先于登录态：没地址就没法登录）
  const token = deps.getToken()
  if (!token) throw new Error(CATALOG_ERRORS.NOT_LOGGED_IN)
  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }).catch((err: unknown) => {
    deps.log?.('warn', `[plugins] 官方目录拉取网络失败：${String(err)}`)
    return null
  })
  if (!res) throw new Error(CATALOG_ERRORS.NETWORK)
  if (!res.ok) {
    deps.log?.('warn', `[plugins] 官方目录拉取被拒（HTTP ${res.status}）`)
    throw new Error(catalogHttpError(res.status))
  }
  const json = await res.json().catch(() => null)
  if (json === null) throw new Error(`${CATALOG_ERRORS.BAD_PAYLOAD}（回包不是合法 JSON）`)
  return toCatalogEntries(parseCatalogPayload(json), host)
}