/**
 * 登录 token 落盘编解码单点（2.6 安全收口批，2026-09-23）。
 *
 * 来历：v2.5.5（`39d1e36`，2026-08-25）按当时这台 Linux 机的实测结论——safeStorage 可用性波动
 * （登录时有 keyring、重启后无 ⇒ `enc:` 解密失败 ⇒ 登录态丢失，AI 助手等账号能力锁「登录后可用」）——
 * 把装配层里的 `encryptToken` 改成**无条件**返回 `raw:`。一条环境实测被写成全平台永久降级，
 * 结果是所有平台一律明文落盘，safeStorage 形同虚设。审计挖出后判为真问题，本模块把它改回
 * 与插件密钥同一口径（见 `src/main/plugins/secretStore.ts` 的 encrypt）：**能加密就加密，
 * 只有不可用/抛错才降级明文**。
 *
 * 兼容与迁移（v2.5.5 的原意一条不能改坏）：
 * - **读**：`decryptToken` 同时认 `enc:` 与 `raw:` ⇒ 存量明文文件照常登录，不要求用户重登；
 * - **写**：`encryptToken` 在 safeStorage 可用时产出 `enc:` ⇒ **下一次落盘（重新登录）自动升级**成密文；
 *   刻意不做「读时回写」：`AccountService.load()` 是同步只读路径，往里塞写盘会把 keyring 抖动
 *   放大成启动期登录竞态，而且存量文件本来就要在下次登录时自然换掉。
 * - **降级保登录**：Linux 无 keyring（`isEncryptionAvailable()` 为 false，或 `encryptString` 直接抛错）
 *   继续落 `raw:`，「没钥匙环也能登录」这条原意不变；
 * - **fail-closed**：`enc:` 解不开（keyring 消失）/ 未知前缀一律返回空串，由 `AccountService`
 *   按未登录处理并 log 警告，不抛、不猜明文。
 */
import { safeStorage } from 'electron'

/** safeStorage 密文前缀 */
const ENC = 'enc:'
/** 明文降级前缀（v2.5.5 起的存量文件即此形态） */
const RAW = 'raw:'

/** token 落盘编码：safeStorage 可用 → `enc:` + base64 密文；不可用或抛错 → `raw:` + 明文（保 Linux 无 keyring 可登录） */
export function encryptToken(plain: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC + safeStorage.encryptString(plain).toString('base64')
    }
  } catch {
    /* keyring 中途失效等：降级不阻断登录（与 secretStore 同处理） */
  }
  return RAW + plain
}

/** token 读盘解码：`raw:` 取明文（存量兼容）；`enc:` 走 safeStorage；失败或未知前缀 → 空串（按未登录，不抛） */
export function decryptToken(encoded: string): string {
  try {
    if (encoded.startsWith(RAW)) return encoded.slice(RAW.length)
    if (encoded.startsWith(ENC)) return safeStorage.decryptString(Buffer.from(encoded.slice(ENC.length), 'base64'))
  } catch {
    return ''
  }
  return ''
}
