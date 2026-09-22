/**
 * 官方插件内容密钥获取与内存解密（v2.5.7 线程 F5b）。
 *
 * 生命周期：
 *  1. 激活加密插件 → 查本地密钥缓存（secretStore 加密落盘，Linux 无 keyring 退化 base64
 *     ——与 account.ts raw: 同口径）→ 命中且未过 7 天宽限 → 用；
 *  2. 缓存未命中/过期 → 在线取钥（erp POST /api/box/plugin-key，Bearer JWT + 密文 sha256
 *     比对防调包）→ 写缓存；
 *  3. 网络失败且缓存过期 → 拒绝加载（锁云端入口；本地非云端功能不受影响）。
 *
 * 明文不落盘：解密后的 bundle 只在内存（Module._compile / Response body），进程退出即消。
 * 诚实口径（Kerckhoffs）：解密逻辑公开（box 开源），安全依赖密钥服务端化与取钥审计——
 * 打补丁的自编译宿主可在加载时转储明文，防的是静态提取与无账号分发，不防付费用户主动破解。
 *
 * 本模块不 import electron（纯 TS，可在 node 直测）；密钥落盘加密走 secretStore 注入
 * （装配层传 safeStorage 封装，node 单测传 fake）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { PluginManifest } from '../../plugins/types'

/** 离线宽限（与线程 C 拍板口径一致）：密钥缓存 7 天内可用，过期锁云端插件入口 */
export const KEY_GRACE_PERIOD_MS = 7 * 24 * 3600 * 1000
/** .enc 文件头魔数（写入与读取双端一致） */
export const ENC_MAGIC = 'QHENC1'

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
 *  localCipherSha256 = 本地密文文件（main/index.js.enc）的 sha256——由调用方计算传入，
 *  不信任 manifest 字段（manifest 也可被篡改；服务端只认登记值，比对失败拒发钥）。 */
export async function fetchKeyOnline(
  deps: KeyDeps,
  manifest: PluginManifest,
  localCipherSha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!deps.getToken()) {
    deps.log('warn', '[encryption] 未登录，无法在线取钥（加密插件需登录）')
    return null
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
  if (!res) return null
  const json = (await res.json().catch(() => null)) as { code?: number; data?: { key_hex?: string } } | null
  if (!res.ok || json?.code !== 200 || !json.data?.key_hex) {
    deps.log('warn', `[encryption] 取钥被拒（HTTP ${res.status}）：${JSON.stringify(json)?.slice(0, 160)}`)
    return null
  }
  return json.data.key_hex
}

/**
 * 获取插件内容密钥（hex）：缓存宽限内直接返回；否则在线取钥并写缓存；失败 → null。
 * 解密本身在调用方（Module._compile / protocol），本模块只管密钥生命周期。
 */
export async function getPluginKey(
  deps: KeyDeps,
  manifest: PluginManifest,
  localCipherSha256: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  if (!manifest.encryption) return null
  const cached = readCache(deps, manifest.id)
  // 批 2.5 P1-2：缓存命中须「未过期 且 版本一致」——覆盖安装后版本变化即回源（服务端按版本发钥）
  if (cached && cached.keyHex && cached.version === manifest.version && Date.now() - cached.fetchedAt < KEY_GRACE_PERIOD_MS) {
    return cached.keyHex
  }
  const fetched = await fetchKeyOnline(deps, manifest, localCipherSha256, fetchImpl)
  if (fetched) {
    writeCache(deps, manifest.id, fetched, manifest.version)
    return fetched
  }
  // 网络失败 + 缓存过期/版本不符 → 拒绝（锁云端插件入口；本地功能不受影响）
  deps.log('warn', `[encryption] 密钥不可用（${manifest.id}@${manifest.version}）→ 拒绝加载加密插件`)
  return null
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
