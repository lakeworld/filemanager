/**
 * 官方插件内容密钥获取与内存解密（v2.5.7 线程 F5b）。
 *
 * 生命周期：
 *  1. 激活加密插件 → 查本地密钥缓存（secretStore 加密落盘，Linux 无 keyring 退化 base64
 *     ——与 account.ts raw: 同口径）→ 命中且未过 7 天宽限 → 用；
 *  2. 缓存未命中/过期 → 在线取钥（erp POST /api/box/plugin-key，Bearer JWT + 密文 sha256
 *     比对防调包）→ 写缓存；
 *  3. 网络失败且缓存过期 → 拒绝加载（锁云端入口；本地非云端功能不受影响）。
 *  失败不折叠成裸 null：`getPluginKeyResult` / `fetchKeyOnlineResult` 带出服务端 `code` 与 HTTP 状态，
 *  由上层翻成用户可见的原因与出路（v2.6 批 7，审查轮 2 缺口①）；`getPluginKey` 保持旧签名（null = 失败）。
 *
 * 明文不落盘：解密后的 bundle 只在内存（Module._compile / Response body），进程退出即消。
 * 诚实口径（Kerckhoffs）：解密逻辑公开（box 开源），安全依赖密钥服务端化与取钥审计——
 * 打补丁的自编译宿主可在加载时转储明文，防的是静态提取与无账号分发，不防有决心的用户主动破解。
 *
 * 本模块不 import electron（纯 TS，可在 node 直测）；密钥落盘加密走 secretStore 注入
 * （装配层传 safeStorage 封装，node 单测传 fake）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { PluginManifest } from '../../plugins/types'
import type { PluginLoadErrorCode } from '../../shared/types'
import { MAIN_ENTRY } from './registry'

/** 离线宽限（与线程 C 拍板口径一致）：密钥缓存 7 天内可用，过期锁云端插件入口 */
export const KEY_GRACE_PERIOD_MS = 7 * 24 * 3600 * 1000
/** .enc 文件头魔数（写入与读取双端一致） */
export const ENC_MAGIC = 'QHENC1'

/** 本地密文文件 sha256（hex）。读取失败 → 空串（服务端对空值 fail-closed 拒发钥）。 */
async function sha256HexOfFile(file: string): Promise<string> {
  try {
    const b = await fsp.readFile(file)
    return crypto.createHash('sha256').update(b).digest('hex')
  } catch {
    return ''
  }
}

/**
 * 取钥防调包「上报口径」的**唯一出处**（v2.6.1）：插件**主入口**密文
 * `<pkgRoot>/main/index.js.enc` 的 sha256（hex）。
 *
 * 为什么是主入口而不是「所请求的那个文件」：一版一钥覆盖整包（main 与各渲染层模块共用同一把钥），
 * 云端登记值也只有主入口这一项 ⇒ **主入口激活取钥与渲染层模块取钥必须上报同一个值**。
 * 2026-09-23 缺陷即此处漂移：渲染层上报自身 `.enc` 的哈希，只要主入口本会话还没激活过
 * （冷进插件页），服务端必判 TAMPERED、页面根本出不来。
 * 读取失败 → 空串（与旧口径同形：服务端 fail-closed 拒发钥，不回落明文）。
 */
export async function mainEntryCipherSha256(pkgRoot: string): Promise<string> {
  return sha256HexOfFile(path.join(pkgRoot, MAIN_ENTRY) + '.enc')
}

/** 密钥落盘加密提供者（默认 null = 纯 base64 混淆；装配层注入 safeStorage 封装） */
export interface SecretStore {
  encrypt(buf: Buffer, scope: string): string
  decrypt(s: string, scope: string): Buffer | null
}

export interface KeyDeps {
  baseUrl: string
  getToken: () => string | null
  /** 缓存写入目录（userData/plugins/keys） */
  cacheDir: string
  /** 密钥落盘加密（electron safeStorage）；缺省 null = base64（与 account raw: 同口径） */
  secretStore?: SecretStore
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/**
 * 取钥失败原因（v2.6 批 7，审查轮 2 缺口①）：服务端 `POST /api/box/plugin-key` 的非 200 结局各有
 * 不同出路（`SUBSCRIPTION_REQUIRED` 用户可自救、`TAMPERED` 属拒载、`INTERNAL` 可重试），
 * 折叠成裸 null 会让用户「装上但用不了、还没有出路」——故失败原因原样带出（**fail-closed 语义不变**：
 * `keyHex` 为 null 就照旧拒绝加载/解密）。
 *
 * `code` 取值：服务端 code **原样保留**（`TAMPERED` / `SUBSCRIPTION_REQUIRED` / `ENTITLEMENT_UNKNOWN` /
 * `PLUGIN_KEY_NOT_FOUND` / `PLUGIN_KEY_MISSING` / `INTERNAL`；未识别的 code 亦原样透传，映射走通用文案、
 * 日志保留原文）；宿主侧另有 `NOT_LOGGED_IN`（未登录）/ `NETWORK`（网络不可达）/ `HTTP_ERROR`
 * （非 2xx 且回包无可用 code）/ `BAD_RESPONSE`（2xx 但回包形状不对）/ `DECRYPT_FAILED`（拿到钥但解密失败，
 * 由调用方补）。
 */
export interface PluginKeyFailure {
  code: string
  /** 服务端 HTTP 状态（网络不可达 / 未登录时缺省） */
  httpStatus?: number
  /** 服务端 message 原文（诊断用；用户可见文案一律走 pluginKeyFailureText） */
  serverMessage?: string
}

/** 取钥结果：成功带 `keyHex`，失败带 `failure`（成功时不带 failure） */
export interface KeyAcquireResult {
  keyHex: string | null
  failure?: PluginKeyFailure
}

/** 用户可见的失败说明（原因 + 出路）——纯函数输出（可单测） */
export interface PluginKeyFailureText {
  /** 原因：一句话（用户可见） */
  text: string
  /** 出路：用户可走的一步（指向应用内既有入口；不出现任何数字） */
  guidance: string
}

/** 服务端 code 形状（大写字母开头；数字码如 `200` 不在此列，归入 HTTP/回包故障） */
const SERVER_CODE_RE = /^[A-Z][A-Z0-9_]*$/

/**
 * 非成功回包 → 失败原因。服务端 code 原样保留（防调包 / 权益 / 未登记等**各有出路**，不得互相折叠）；
 * 回包没有可用 code 时按 HTTP 状态归类（HTTP_ERROR / BAD_RESPONSE）。
 */
function keyFailureFromResponse(
  status: number,
  ok: boolean,
  json: { code?: unknown; message?: unknown } | null,
): PluginKeyFailure {
  const serverMessage = typeof json?.message === 'string' && json.message ? json.message : undefined
  const raw = typeof json?.code === 'string' && SERVER_CODE_RE.test(json.code) ? json.code : ''
  return {
    code: raw || (ok ? 'BAD_RESPONSE' : 'HTTP_ERROR'),
    httpStatus: status,
    ...(serverMessage ? { serverMessage } : {}),
  }
}

/**
 * 取钥失败码 → 用户可见原因与出路（纯函数；未知 code 走通用文案，原文留给日志）。
 * 文案纪律：只讲技术口径与可走的路，不写任何数字；订阅类出路指向应用内既有页面，不在此自创入口名。
 */
export function pluginKeyFailureText(failure: PluginKeyFailure): PluginKeyFailureText {
  const status = failure.httpStatus
  switch (failure.code) {
    case 'SUBSCRIPTION_REQUIRED':
      return { text: '该插件需要订阅后才能使用', guidance: '请在官方插件「启禾云」的「订阅 VIP」页开通订阅后重试' }
    case 'PLUGIN_KEY_NOT_FOUND':
      return { text: '该插件版本未在云端登记内容密钥', guidance: '请联系插件发布方登记该版本后重试' }
    case 'PLUGIN_KEY_MISSING':
      return { text: '该插件版本的云端密钥缺失（登记不完整）', guidance: '请联系插件发布方补全登记后重试' }
    case 'TAMPERED':
      return { text: '插件包内容与云端登记不一致，已拒绝加载', guidance: '请重新安装该插件；仍失败请联系插件发布方' }
    case 'ENTITLEMENT_UNKNOWN':
      return { text: '该插件声明的取钥门槛云端无法识别', guidance: '请联系插件发布方核对插件清单' }
    case 'INTERNAL':
      return { text: '云端取钥服务临时故障', guidance: '请稍后重试' }
    case 'NETWORK':
      return { text: '取钥网络不可达', guidance: '请检查网络后重试' }
    case 'NOT_LOGGED_IN':
      return { text: '未登录启禾云账号，无法取密钥', guidance: '请在「我的 → 账号」登录后重试' }
    case 'DECRYPT_FAILED':
      return { text: '插件包解密失败（密钥与包内容不匹配）', guidance: '请重新安装该插件；仍失败请联系插件发布方' }
    case 'HTTP_ERROR':
      // 401 = 鉴权中间件先于取钥 handler 拒绝（token 过期/失效是最可能的实情）
      return status === 401
        ? { text: '云端取钥被拒（登录态可能已失效）', guidance: '请在「我的 → 账号」重新登录后重试' }
        : { text: `云端取钥被拒（HTTP ${status ?? '未知'}）`, guidance: '请稍后重试；持续失败请联系插件发布方' }
    case 'BAD_RESPONSE':
      return { text: '云端取钥回包无法识别', guidance: '请稍后重试；持续失败请联系插件发布方' }
    default:
      return { text: `云端取钥失败（${failure.code}）`, guidance: '请稍后重试；持续失败请联系插件发布方' }
  }
}

/**
 * 取钥失败码 → **结构化分类码**（v2.6 缺陷修复：宿主插件页要按「用户能走的出路」分流）。
 *
 * 为什么在主进程算而不在渲染层算：分类要看 `code` **和** HTTP 状态（401 = 登录态失效，出路是
 * 「去登录」；500 = 云端故障，出路是「重试」）——HTTP 状态只在这里拿得到。渲染层拿到分类码后
 * 只管画按钮，**不去猜中文文案**（口径同渲染层 `catalogErrorGuidance`：措辞改字不让引导走偏）。
 *
 * 五类互斥；未识别的云端码（含服务端将来新增）一律落 `NOT_REGISTERED`——它的出路「联系插件发布方」
 * 是「宿主与发布方都帮不上忙」时的最诚实兜底，比假装「重试就好」更贴近实情。
 */
export function pluginKeyLoadCode(failure: PluginKeyFailure): PluginLoadErrorCode {
  switch (failure.code) {
    case 'SUBSCRIPTION_REQUIRED':
      return 'SUBSCRIPTION_REQUIRED'
    case 'NOT_LOGGED_IN':
      // 401 = 鉴权中间件先于取钥 handler 拒绝（token 过期/失效）——同一条出路：去登录
      return 'NOT_LOGGED_IN'
    case 'TAMPERED':
      return 'TAMPERED'
    case 'NETWORK':
      return 'NETWORK'
    case 'DECRYPT_FAILED':
      // 拿到钥却解不开 = 本地包与云端登记的不是同一份，出路同调包：重装
      return 'TAMPERED'
    case 'HTTP_ERROR':
      return failure.httpStatus === 401 ? 'NOT_LOGGED_IN' : 'NETWORK'
    case 'INTERNAL':
    case 'BAD_RESPONSE':
      return 'NETWORK'
    case 'PLUGIN_KEY_NOT_FOUND':
    case 'PLUGIN_KEY_MISSING':
    case 'ENTITLEMENT_UNKNOWN':
      return 'NOT_REGISTERED'
    default:
      return 'NOT_REGISTERED'
  }
}

interface CachedKey {
  keyHex: string
  fetchedAt: number
  /** 取钥时的插件版本（批 2.5 P1-2）：服务端按 (plugin_id, version) 发钥，
   *  覆盖安装后密文换新钥——缓存不绑版本会在 7 天宽限内拿旧钥解新密文（GCM 失败 → fail-closed）。 */
  version: string
}

function cacheFile(deps: KeyDeps, pluginId: string): string {
  return path.join(deps.cacheDir, `${pluginId}.key`)
}

function readCache(deps: KeyDeps, pluginId: string): CachedKey | null {
  try {
    const raw = fs.readFileSync(cacheFile(deps, pluginId), 'utf8')
    const json = JSON.parse(raw) as { key: string; fetchedAt: number; version?: unknown }
    const buf = deps.secretStore ? deps.secretStore.decrypt(json.key, 'qihebox-plugin-key') : null
    if (!buf) return null
    return {
      keyHex: buf.toString('utf8'),
      fetchedAt: json.fetchedAt,
      version: typeof json.version === 'string' ? json.version : '', // 旧缓存无 version 字段 → '' ≠ 任何版本 → 视为未命中
    }
  } catch {
    return null
  }
}

function writeCache(deps: KeyDeps, pluginId: string, keyHex: string, version: string): void {
  try {
    fs.mkdirSync(deps.cacheDir, { recursive: true })
    const encoded = deps.secretStore
      ? deps.secretStore.encrypt(Buffer.from(keyHex, 'utf8'), 'qihebox-plugin-key')
      : 'raw:' + Buffer.from(keyHex, 'utf8').toString('base64')
    fs.writeFileSync(cacheFile(deps, pluginId), JSON.stringify({ key: encoded, fetchedAt: Date.now(), version }), { mode: 0o600 })
  } catch (err) {
    deps.log('warn', `[encryption] 密钥缓存写入失败（仅影响离线宽限）: ${String(err)}`)
  }
}

/** 在线取钥：POST /api/box/plugin-key，Bearer JWT，防调包 sha256 比对在服务端（PLAN F5 §77）。
 *  localCipherSha256 = **主入口密文**（`<pkg>/main/index.js.enc`）的 sha256——调用方一律用
 *  `mainEntryCipherSha256(pkgRoot)` 计算传入（本口径的唯一出处；不许按所请求的渲染层模块各算一份）。
 *  不信任 manifest 字段（manifest 也可被篡改；服务端只认登记值，比对失败拒发钥）。
 *  失败带 `failure`（code + HTTP 状态，v2.6 批 7 审查轮 2 缺口①）——上层据此给用户具体原因与出路；
 *  fail-closed 语义不变：`keyHex` 为 null 即拒绝加载。 */
export async function fetchKeyOnlineResult(
  deps: KeyDeps,
  manifest: PluginManifest,
  localCipherSha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyAcquireResult> {
  if (!deps.getToken()) {
    deps.log('warn', '[encryption] 未登录，无法在线取钥（加密插件需登录）')
    return { keyHex: null, failure: { code: 'NOT_LOGGED_IN' } }
  }
  const body = {
    plugin_id: manifest.id,
    version: manifest.version,
    cipher_sha256: localCipherSha256,
  }
  // 批 2.5 P0-1（照 host.ts F4a 先例）：resolveApiBase() 返回 `…/api`（协议要求路径亦以 /api/ 开头）
  // → 直接拼会产生 /api/api 双段，落 SPA 兜底 200 text/html 而真路由 401。剥 baseUrl 尾部 /api 一次。
  let url = `${deps.baseUrl}/api/box/plugin-key`
  if (deps.baseUrl.endsWith('/api')) url = `${deps.baseUrl.slice(0, -4)}/api/box/plugin-key`
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deps.getToken()}`,
    },
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    deps.log('warn', `[encryption] 取钥网络失败: ${String(err)}`)
    return null
  })
  if (!res) return { keyHex: null, failure: { code: 'NETWORK' } }
  const json = (await res.json().catch(() => null)) as
    | { code?: unknown; message?: unknown; data?: { key_hex?: string } }
    | null
  if (!res.ok || json?.code !== 200 || !json.data?.key_hex) {
    const failure = keyFailureFromResponse(res.status, res.ok, json)
    deps.log(
      'warn',
      `[encryption] 取钥被拒（HTTP ${res.status}，code=${failure.code}）：${JSON.stringify(json)?.slice(0, 160)}`,
    )
    return { keyHex: null, failure }
  }
  return { keyHex: json.data.key_hex }
}

/** 兼容入口（v2.5.7 起既有调用方与单测）：只要密钥，任何失败一律 null（fail-closed）。
 *  需要失败原因时用 `fetchKeyOnlineResult`。 */
export async function fetchKeyOnline(
  deps: KeyDeps,
  manifest: PluginManifest,
  localCipherSha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  return (await fetchKeyOnlineResult(deps, manifest, localCipherSha256, fetchImpl)).keyHex
}

/**
 * 获取插件内容密钥（hex）：缓存宽限内直接返回；否则在线取钥并写缓存；失败 → `keyHex: null` + `failure`。
 * 解密本身在调用方（Module._compile / protocol），本模块只管密钥生命周期。
 */
export async function getPluginKeyResult(
  deps: KeyDeps,
  manifest: PluginManifest,
  localCipherSha256: string,
  fetchImpl?: typeof fetch,
): Promise<KeyAcquireResult> {
  if (!manifest.encryption) return { keyHex: null }
  const cached = readCache(deps, manifest.id)
  // 批 2.5 P1-2：缓存命中须「未过期 且 版本一致」——覆盖安装后版本变化即回源（服务端按版本发钥）
  if (cached && cached.keyHex && cached.version === manifest.version && Date.now() - cached.fetchedAt < KEY_GRACE_PERIOD_MS) {
    return { keyHex: cached.keyHex }
  }
  const fetched = await fetchKeyOnlineResult(deps, manifest, localCipherSha256, fetchImpl)
  if (fetched.keyHex) {
    writeCache(deps, manifest.id, fetched.keyHex, manifest.version)
    return { keyHex: fetched.keyHex }
  }
  // 网络失败 + 缓存过期/版本不符 → 拒绝（锁云端插件入口；本地功能不受影响）
  deps.log(
    'warn',
    `[encryption] 密钥不可用（${manifest.id}@${manifest.version}，code=${fetched.failure?.code ?? '未知'}）→ 拒绝加载加密插件`,
  )
  return fetched.failure ? { keyHex: null, failure: fetched.failure } : { keyHex: null }
}

/**
 * 兼容入口（v2.5.7 起既有调用方与单测）：只要密钥，任何失败一律 null（fail-closed）。
 * 需要失败原因时用 `getPluginKeyResult`。
 */
export async function getPluginKey(
  deps: KeyDeps,
  manifest: PluginManifest,
  localCipherSha256: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  return (await getPluginKeyResult(deps, manifest, localCipherSha256, fetchImpl)).keyHex
}

/** 解密 .enc 内容（magic + iv + tag + body）。非 QHENC1 / 密钥错 → null（调用方 fail-closed）。 */
export function decryptEnc(buf: Buffer, keyHex: string): Buffer | null {
  try {
    if (buf.subarray(0, 6).toString('utf8') !== ENC_MAGIC || buf.length <= 34) return null
    const key = Buffer.from(keyHex, 'hex')
    if (key.length !== 32) return null
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(6, 18))
    d.setAuthTag(buf.subarray(18, 34))
    return Buffer.concat([d.update(buf.subarray(34)), d.final()])
  } catch {
    return null
  }
}

/** 加密明文 → .enc 内容（供构建脚本/测试；产品打包在 plugins 仓 --encrypt 实现） */
export function encryptForBundle(buf: Buffer, keyHex: string): Buffer | null {
  try {
    const key = Buffer.from(keyHex, 'hex')
    if (key.length !== 32) return null
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(buf), c.final()])
    return Buffer.concat([Buffer.from(ENC_MAGIC, 'utf8'), iv, c.getAuthTag(), body])
  } catch {
    return null
  }
}
