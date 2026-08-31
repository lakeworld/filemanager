/**
 * 密钥落盘加密单点（D-09，2026-08-31 发布轮）。
 *
 * 此前同一份 safeStorage 封装 + base64 退化逻辑存在两份：
 *  - `plugins/ipc.ts` 里的 makePluginSecretStore()
 *  - `index.ts` 装配 registerQiheboxProtocol 时的内联对象
 * 实测两处 cacheDir 同源（userData/plugins/keys）、行为一致（enc:/raw: 前缀与降级一致），
 * 但双份实现意味着将来改前缀/加轮数必有一处漏。合并到这里，装配层与 IPC 层复用同一实现。
 */
import { safeStorage } from 'electron'
import type { SecretStore } from './encryption'

/** safeStorage 封装（密钥落盘加密；Linux 无 keyring 时退化 base64——与 account.ts raw: 同口径） */
export function makePluginSecretStore(): SecretStore {
  return {
    encrypt(buf: Buffer, _scope: string): string {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return 'enc:' + safeStorage.encryptString(buf.toString('utf8')).toString('base64')
        }
      } catch {
        /* 退化 */
      }
      return 'raw:' + buf.toString('base64')
    },
    decrypt(s: string, _scope: string): Buffer | null {
      try {
        if (s.startsWith('enc:')) return Buffer.from(safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')), 'utf8')
        if (s.startsWith('raw:')) return Buffer.from(s.slice(4), 'base64')
      } catch {
        return null
      }
      return null
    },
  }
}
