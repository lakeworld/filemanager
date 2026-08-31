/**
 * 密钥落盘加密单点单测（D-09，2026-08-31 发布轮）：
 * makePluginSecretStore() 是 index.ts（装配层）与 plugins/ipc.ts（IPC 层）共用的一份实现，
 * 防双份漂移。行为契约与 account.ts raw: 同口径：
 *  - safeStorage 可用 → enc: 前缀；不可用或抛错 → raw: 前缀（base64 混淆退化）；
 *  - decrypt 只认 enc:/raw: 前缀，其它/解密失败一律 null（fail-closed）。
 */
import { describe, expect, it, vi } from 'vitest'

const { isEncryptionAvailable, encryptString, decryptString } = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}))
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable, encryptString, decryptString },
}))

import { makePluginSecretStore } from '../../src/main/plugins/secretStore'

describe('plugins/secretStore（D-09 单点实现）', () => {
  it('safeStorage 不可用 → raw: 退化，roundtrip 保真', () => {
    isEncryptionAvailable.mockReturnValue(false)
    const store = makePluginSecretStore()
    const secret = Buffer.from('你好密钥')
    const s = store.encrypt(secret, 'box_plugin_keys')
    expect(s.startsWith('raw:')).toBe(true)
    expect(store.decrypt(s, 'box_plugin_keys')?.toString('utf8')).toBe('你好密钥')
  })

  it('safeStorage 可用 → enc: 前缀，解密走 decryptString', () => {
    isEncryptionAvailable.mockReturnValue(true)
    encryptString.mockImplementation((plain: string) => Buffer.from(plain, 'utf8'))
    decryptString.mockImplementation((b: Buffer) => b.toString('utf8'))
    const store = makePluginSecretStore()
    const s = store.encrypt(Buffer.from('密钥内容'), 'box_plugin_keys')
    expect(s.startsWith('enc:')).toBe(true)
    expect(store.decrypt(s, 'box_plugin_keys')?.toString('utf8')).toBe('密钥内容')
  })

  it('encrypt 内部抛错 → 不炸，退化 raw:', () => {
    isEncryptionAvailable.mockReturnValue(true)
    encryptString.mockImplementation(() => {
      throw new Error('safeStorage 不可用')
    })
    const store = makePluginSecretStore()
    const s = store.encrypt(Buffer.from('x'), 'k')
    expect(s.startsWith('raw:')).toBe(true)
    expect(store.decrypt(s, 'k')?.toString('utf8')).toBe('x')
  })

  it('未知前缀 / 解密失败 → null（fail-closed，不抛）', () => {
    const store = makePluginSecretStore()
    expect(store.decrypt('plain-text', 'k')).toBeNull()
    expect(store.decrypt('', 'k')).toBeNull()
    isEncryptionAvailable.mockReturnValue(true)
    decryptString.mockImplementation(() => {
      throw new Error('bad')
    })
    expect(store.decrypt('enc:AAAA', 'k')).toBeNull()
  })
})
