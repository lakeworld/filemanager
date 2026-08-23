/**
 * 插件协议模糊测试（v2.5，PLAN-v2.5-测试 §三.C）：fast-check 三套模糊。
 * - manifest 结构模糊（纯内存）：fc.anything() 任意嵌套 → validateManifest 永不抛异常、
 *   返回值恒 { ok: boolean; errors: string[] }；定向生成器（9 违规 + 合法 record + 单字段破坏）
 *   → 规则①–⑨专属关键词确定性断言（不依赖随机命中）。
 * - host.files 模糊（IO）：随机路径/文件名（逃逸/超长/Unicode/空串/分隔符 + \0 显式注入）
 *   → readText/readBuffer/writeExport 只返回规定错误码或成功，不抛无 code 裸异常（\0 → INVALID_NAME）。
 * - registry 模糊（纯内存）：随机插件 id / ipcPrefix / 页面路径 / 事件名 / 通道名
 *   → 登记与路由不崩溃。
 *
 * 确定性：seed 固定写死（本文件顶部常量），env FUZZ_SEED 可覆盖（本地换 seed 探索，CI 用默认常数）；
 * numRuns 按套件在 fc.assert 处传（manifest 1000 / host.files 250 / registry 500）。
 * 发现反例时 fast-check 输出 seed，作为新增回归用例依据。
 *
 * seed: 20260814
 */
import { describe, expect, it, beforeEach } from 'vitest'
import fc from 'fast-check'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { validateManifest } from '../../src/plugins/types'
import { createPluginHost, HostEventBus, type PluginHostInstance } from '../../src/main/plugins/host'
import { PluginRegistry, PKG_DIR } from '../../src/main/plugins/registry'

// —— 确定性配置（PLAN §三.C）：seed 固定 + FUZZ_SEED 覆盖 ——
const SEED = 20260814
const envSeed = Number(process.env.FUZZ_SEED)
fc.configureGlobal({ seed: Number.isFinite(envSeed) ? envSeed : SEED })

/** 最简合法清单（对齐 plugins-types.test.ts baseManifest） */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'com.qihe.hello',
    name: '示例插件',
    version: '0.1.0',
    apiVersion: 1,
    enabled: true,
    kind: ['ipc'],
    ipcPrefix: 'hello',
    ...overrides,
  }
}

// ==================== 套件 1：manifest 结构模糊 ====================

/** 九个已知违规样本（每条规则一个，确定性触发专属关键词；关键词对照 plugins-types.test.ts 错误消息） */
interface RuleCase {
  rule: number
  keyword: string
  input: Record<string, unknown>
}

const RULE_CASES: RuleCase[] = [
  { rule: 1, keyword: 'id 须为域名倒序', input: base({ id: 'Not-A-Domain' }) },
  { rule: 2, keyword: 'kind 声明了', input: base({ kind: ['ipc', 'pages'] }) },
  { rule: 3, keyword: 'apiCompat', input: base({ apiCompat: [2, 3] }) },
  {
    rule: 4,
    keyword: '须为包内相对路径',
    input: base({
      kind: ['ipc', 'pages'],
      pages: [{ path: '/plugin/x', label: 'x', icon: 'i', group: 'g', component: '../evil.js' }],
    }),
  },
  { rule: 5, keyword: 'transport', input: base({ transport: 'process' }) },
  { rule: 6, keyword: '含非法域名', input: base({ permissions: { network: ['https://api.qihe.com'] } }) },
  { rule: 7, keyword: 'onEvent', input: base({ activation: ['onEvent:workspaceChanged'] }) },
  { rule: 8, keyword: 'syncScope', input: base({ syncScope: 'cloud' }) },
  { rule: 9, keyword: 'permissions.account', input: base({ permissions: { account: 'yes' } }) },
  { rule: 10, keyword: 'permissions.customers', input: base({ permissions: { customers: 'yes' } }) },
  { rule: 10, keyword: 'permissions.share', input: base({ permissions: { share: 1 } }) },
]

/** 合法 manifest 组合（fc.record，全部必需字段 + 布尔随机 enabled） */
const validManifestArb = fc.record({
  id: fc.constant('com.qihe.hello'),
  name: fc.constant('示例插件'),
  version: fc.constant('0.1.0'),
  apiVersion: fc.constant(1),
  enabled: fc.boolean(),
  kind: fc.constant(['ipc']),
  ipcPrefix: fc.constant('hello'),
})

/** 单字段破坏派生：合法清单随机破坏一个必需字段 */
const brokenManifestArb = fc
  .tuple(validManifestArb, fc.constantFrom('id', 'name', 'version', 'apiVersion', 'enabled', 'kind', 'ipcPrefix'))
  .map(([m, field]) => {
    const b: Record<string, unknown> = { ...m }
    if (field === 'id') b.id = 'bad-id!'
    else if (field === 'name') b.name = 42
    else if (field === 'version') b.version = 1
    else if (field === 'apiVersion') b.apiVersion = 'one'
    else if (field === 'enabled') b.enabled = 'yes'
    else if (field === 'kind') b.kind = []
    else if (field === 'ipcPrefix') b.ipcPrefix = 'qihebox:x'
    return b
  })

/** 定向生成器：9 违规值 + 合法 record + 单字段破坏派生 */
const directedManifestArb = fc.oneof(
  ...RULE_CASES.map((c) => fc.constant(c.input)),
  validManifestArb,
  brokenManifestArb,
)

describe('manifest 结构模糊（validateManifest）', () => {
  it('fc.anything() 任意嵌套 → 永不抛异常且返回值恒 { ok: boolean; errors: string[] }', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const r = validateManifest(input)
        expect(typeof r).toBe('object')
        expect(r).not.toBeNull()
        expect(typeof r.ok).toBe('boolean')
        expect(Array.isArray(r.errors)).toBe(true)
        expect(r.errors.every((e) => typeof e === 'string')).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })

  it('定向生成器（违规 + 合法 + 单字段破坏）→ 永不抛异常且返回形状恒一致', () => {
    fc.assert(
      fc.property(directedManifestArb, (input) => {
        const r = validateManifest(input)
        expect(typeof r.ok).toBe('boolean')
        expect(Array.isArray(r.errors)).toBe(true)
        expect(r.errors.every((e) => typeof e === 'string')).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it('规则①–⑨：每条规则存在确定性违规样本触发专属关键词（不依赖随机命中）', () => {
    for (const c of RULE_CASES) {
      const r = validateManifest(c.input)
      expect(r.ok, `规则${c.rule} 应被判定违规（input=${JSON.stringify(c.input)}）`).toBe(false)
      expect(r.errors.join('\n'), `规则${c.rule} 应含专属关键词「${c.keyword}」`).toContain(c.keyword)
    }
  })
})

// ==================== 套件 2：host.files 模糊 ====================

describe('host.files 模糊（工作区受限读写）', () => {
  let wsDir = ''
  let inst: PluginHostInstance

  beforeEach(async () => {
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-fuzz-files-ws-'))
    await fsp.mkdir(path.join(wsDir, '导出'), { recursive: true })
    await fsp.writeFile(path.join(wsDir, 'ok.txt'), 'hello', 'utf-8')
    inst = await createPluginHost({
      pluginId: 'com.qihe.fuzz',
      ipcPrefix: 'fuzz',
      stateDir: path.join(wsDir, '.state'),
      bus: new HostEventBus(),
      log: () => {},
      workspace: { currentPath: () => wsDir, list: () => null },
      dialog: { openFile: async () => '', openDirectory: async () => '' },
      notify: () => false,
      emitToRenderer: () => {},
      account: { getToken: () => null, isLoggedIn: () => false },
      accountAccess: false,
      customers: {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
        relation: { link: async () => {}, unlink: async () => {} },
      },
      customersAccess: false,
      suppliers: {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
      },
      suppliersAccess: false,
      quotes: { list: async () => [], get: async () => null },
      share: {
        listProductSets: async () => [],
        listCustomers: async () => [],
        listTree: async () => [],
        getMetadata: async () => ({ tags: [], notes: '' }),
        statFile: async () => ({ size: 0, mtime: '' }),
        readFileChunk: async () => new Uint8Array(0),
        writePulledFile: async () => {},
        ensureProductSet: async () => 'exists' as const,
        ensureCustomer: async () => 'exists' as const,
        ensureSubfolder: async () => {},
        mergePulledMetadata: async () => ({ conflicts: [] }),
      },
      shareAccess: false,
    })
  })

  /** 执行后返回错误 code（成功 → undefined）；无 code 裸异常 → 取 code 为 undefined（断言侧暴露） */
  async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p
      return undefined
    } catch (err) {
      return (err as { code?: string }).code
    }
  }

  const OK_CODES = new Set(['NOT_FOUND', 'OUT_OF_WORKSPACE', 'NO_WORKSPACE', 'TOO_LARGE', 'INVALID_NAME', 'IO_ERROR'])

  /** 随机路径/文件名：逃逸 / 超长 / Unicode / 空串 / 含分隔符 + \0 显式注入 */
  const relPathArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 40 }), // 常规随机（含 unicode / 分隔符）
    fc.constant('../escape.txt'),
    fc.constant('/etc/passwd'),
    fc.constant('a/b.txt'),
    fc.constant('a\\b.txt'),
    fc.constant(''),
    fc.constant('x'.repeat(6000)), // 超长
    fc.constant('中文 文件 名.txt'),
    fc.constant('\0'), // 显式 NUL 注入（修复后 → INVALID_NAME）
    fc.constant('a\0b.txt'),
  )

  it('readText / readBuffer：随机路径只返回规定错误码或成功，不抛无 code 裸异常', () => {
    fc.assert(
      fc.asyncProperty(relPathArb, async (p) => {
        const t = await codeOf(inst.host.files.readText(p))
        expect(t === undefined || OK_CODES.has(t)).toBe(true)
        const b = await codeOf(inst.host.files.readBuffer(p))
        expect(b === undefined || OK_CODES.has(b)).toBe(true)
      }),
      { numRuns: 250 },
    )
  })

  it('writeExport：随机文件名只返回规定错误码或成功，不抛无 code 裸异常', () => {
    fc.assert(
      fc.asyncProperty(relPathArb, async (p) => {
        const c = await codeOf(inst.host.files.writeExport(p, 'x'))
        expect(c === undefined || OK_CODES.has(c)).toBe(true)
      }),
      { numRuns: 250 },
    )
  })
})

// ==================== 套件 3：registry 模糊 ====================

describe('registry 模糊（登记与路由）', () => {
  let root = ''

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-fuzz-registry-'))
  })

  const idArb = fc.oneof(
    fc.constant('com.qihe.ok'),
    fc.constant('bad'),
    fc.constant(''),
    fc.string({ minLength: 1, maxLength: 16 }).map((s) => 'com.qihe.' + s.replace(/[^a-z0-9.]/g, 'x')),
  )
  const prefixArb = fc.oneof(
    fc.constant('hello'),
    fc.constant('qihebox:evil'),
    fc.constant(''),
    fc.string({ minLength: 1, maxLength: 16 }),
  )
  const pageArb = fc.oneof(
    fc.constant('/plugin/x'),
    fc.constant('/settings/evil'),
    fc.constant(''),
    fc.string({ minLength: 1, maxLength: 24 }),
  )
  const channelArb = fc.oneof(
    fc.string({ minLength: 0, maxLength: 24 }),
    fc.constant('workspaceChanged'),
    fc.constant('hello:ok'),
  )

  /** 写单个插件包（dir 名取合法 id，非法 id 落固定目录；main/index.js 恒存在以隔离「缺入口」broken） */
  function writeOne(desc: { id: string; ipcPrefix: string; page: string }): void {
    const safe = /^[a-z0-9.]+$/.test(desc.id) && desc.id.length > 0 ? desc.id : 'com.qihe.invalid'
    const pkg = path.join(root, safe, PKG_DIR)
    fs.mkdirSync(path.join(pkg, 'main'), { recursive: true })
    const manifest: Record<string, unknown> = {
      id: desc.id,
      name: 'fuzz',
      version: '0.1.0',
      apiVersion: 1,
      enabled: true,
      kind: ['ipc'],
      ipcPrefix: desc.ipcPrefix,
    }
    if (desc.page !== undefined) {
      manifest.kind = ['ipc', 'pages']
      manifest.pages = [{ path: desc.page, label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }]
    }
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(pkg, 'main', 'index.js'), 'module.exports={activate:async()=>({ipc:{}})}')
  }

  it('随机插件 id / ipcPrefix / 页面路径 → 登记（scan）不崩溃、条目结构完整', () => {
    fc.assert(
      fc.property(fc.record({ id: idArb, ipcPrefix: prefixArb, page: pageArb }), (desc) => {
        fs.rmSync(root, { recursive: true, force: true })
        fs.mkdirSync(root, { recursive: true })
        writeOne(desc)
        const registry = new PluginRegistry({ root, hostVersion: '2.5.0' })
        expect(() => registry.scan()).not.toThrow()
        for (const info of registry.list()) {
          expect(typeof info.id).toBe('string')
          expect(['enabled', 'disabled', 'broken']).toContain(info.state)
          if (info.state === 'broken') expect(typeof info.brokenReason).toBe('string')
        }
        expect(() => registry.info(desc.id)).not.toThrow()
        expect(() => registry.get(desc.id)).not.toThrow()
      }),
      { numRuns: 500 },
    )
  })

  it('随机事件名 / 通道名 → HostEventBus 路由（pluginOn / emitHost）不崩溃', () => {
    const bus = new HostEventBus()
    fc.assert(
      fc.property(channelArb, (channel) => {
        let called = 0
        const unsub = bus.pluginOn(channel, () => {
          called++
        })
        expect(() => bus.emitHost(channel, { x: 1 })).not.toThrow()
        expect(called).toBe(1)
        unsub()
        expect(() => bus.emitHost(channel, { x: 2 })).not.toThrow()
        expect(called).toBe(1) // 退订后不再触发
      }),
      { numRuns: 500 },
    )
  })
})
