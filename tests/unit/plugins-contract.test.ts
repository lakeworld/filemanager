/**
 * 契约对账自动化（v2.5，Task 2 / PLAN-v2.5-测试.md §三.B）。
 *
 * 双向对账 docs/PLUGIN.md（公开契约）与实现（src/plugins/types.ts + 宿主）：
 *  1. 文档提取的锚点集合 === 映射表 key 全集（文档缺锚点 / 多锚点 / 无映射锚点 → 红）。
 *     映射表 key 全集 = 唯一权威 oracle（不另建第二份清单）。
 *  2. 每个 v1 锚点执行 self-check（依赖注入真实实现，行为级断言，非"方法存在"空断言）；
 *     v2.7 锚点仅登记（文档登记存在即可，不要求实现存在）。
 *  3. 反查：复用 apiSurface.ts 的 extractApiSurface() 提取 PluginHost 接口成员名，
 *     断言每个 host.<name> 都有 contract:v1:host.<kebab-case> 锚点（实现有、文档无 → 红）。
 *
 * self-check 依赖注入：函数签名 (deps) => void | Promise<void>。deps 核心可注入项为
 * validateManifest（manifest 规则）与 host（宿主能力）——mutation 红验证注入坏实现即可变红；
 * 额外携带 host 构造上下文（bus / logCalls / emitted / wsDir / stateDir）供 log 转发、
 * 事件往返、emit 前缀、storage 落盘、files 读写等行为级断言使用。
 *
 * 已知差异（实施发现，PLAN §五 对账差异④；2026-08-14 已部分落地 4fc39b4）：
 *   security.csp——qihebox://plugin/<id>/ 响应已附加 Content-Security-Policy 头（PLUGIN_CSP），
 *   兑现 §六 规则 5 的「响应带 CSP 头」承诺；但 import 模块无执行约束（形式防护，真隔离 v2.7）。
 *   self-check 断言 protocol.ts 源码含 CSP 头与 PLUGIN_CSP（删头即红），并保留协议 URL 资源边界断言。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { API_VERSION, validateManifest, type PluginHost } from '../../src/plugins/types'
import { createPluginHost, HostEventBus, HOST_EVENT_WHITELIST, DEFAULT_STORAGE_LIMITS } from '../../src/main/plugins/host'
import { PluginLoader, BREAK_THRESHOLD } from '../../src/main/plugins/loader'
import { PluginRegistry, PKG_DIR, MAIN_ENTRY } from '../../src/main/plugins/registry'
import { PluginInstaller, sha256OfFile } from '../../src/main/plugins/installer'
import { createSettings } from '../../src/main/settings'
import { compressToZip } from '../../src/main/core/archive'
import {
  extractApiSurface,
  PRELOAD_MANIFEST,
  IPC_CHANNELS,
  assertPreloadManifestMatchesSource,
  assertIpcManifestMatchesSource,
  BASELINE_PATH,
} from './helpers/apiSurface'
// v2.5.5（B2）：prefill 数字字段 pickNumber 边界（协议稳定性收口，PLAN §三）
import { normalizePrefill } from '../../src/renderer/src/stores/createPrefillNormalize'
import type { InvoicePrefill, QuotePrefill } from '../../src/renderer/src/stores/createPrefillNormalize'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const PUBLIC_PLUGIN_MD = path.join(repoRoot, 'docs/PLUGIN.md')
const INTERNAL_PLUGIN_MD = path.join(repoRoot, 'docs/INTERNAL/PLUGIN.md')

function readSource(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8')
}

// —— 锚点提取（机器可读锚点：<!-- contract:<stage>:<id> -->）——

const ANCHOR_RE = /<!--\s*(contract:(?:v1|v2\.6|v2\.7):[a-z0-9][a-z0-9.-]*)\s*-->/g

/** 从 markdown 文本提取锚点集合（阶段 + id 全量，如 contract:v1:host.storage）。 */
function extractAnchors(md: string): Set<string> {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = ANCHOR_RE.exec(md)) !== null) out.add(m[1])
  return out
}

// —— manifest 校验 self-check 工具 ——

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** 断言校验器对输入产出含 needle 的错误（中文描述逐条汇总，不提前终止）。 */
function reject(vm: typeof validateManifest, input: unknown, needle: string): void {
  expect(vm(input).errors.join('\n')).toContain(needle)
}

const PAGE = { path: '/plugin/x', label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }

// —— host 构造上下文（依赖注入：核心可注入项 = validateManifest + host）——

/** 宿主透传能力注入的哨兵值（行为断言：host.dialog/notify/workspace 原样透传装配层注入实现）。 */
const LIST_SENTINEL = { marker: 'list-sentinel' }
const DIALOG_FILE = '/contract/picked.txt'
const DIALOG_DIR = '/contract/picked-dir'
const NOTIFY_RESULT = true

interface ContractDeps {
  validateManifest: typeof validateManifest
  host: PluginHost
  bus: HostEventBus
  logCalls: Array<[string, string]>
  emitted: Array<[string, unknown]>
  /** 工作区目录（缺省 null = 无工作区；files 宿主注入真实临时目录） */
  wsDir: string | null
  /** 插件状态目录（userData/plugins/<id>/state/，storage 落盘断言用） */
  stateDir: string
}

interface HostCtx {
  deps: ContractDeps
  dispose: () => void
}

/** 构造真实宿主实例（createPluginHost，行为级断言的"真实实现"载体）。 */
async function makeContractHost(
  overrides: {
    workspacePath?: () => string | null
    accountAccess?: boolean
    limits?: Parameters<typeof createPluginHost>[1]
  } = {},
): Promise<HostCtx> {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-contract-state-'))
  const bus = new HostEventBus()
  const logCalls: Array<[string, string]> = []
  const emitted: Array<[string, unknown]> = []
  const wsPath = overrides.workspacePath?.() ?? null
  const inst = await createPluginHost(
    {
      pluginId: 'com.qihe.contract',
      ipcPrefix: 'contract',
      stateDir,
      bus,
      log: (level, msg) => {
        logCalls.push([level, msg])
      },
      workspace: { currentPath: () => wsPath, list: () => LIST_SENTINEL },
      dialog: { openFile: async () => DIALOG_FILE, openDirectory: async () => DIALOG_DIR },
      notify: () => NOTIFY_RESULT,
      emitToRenderer: (channel, data) => {
        emitted.push([channel, data])
      },
      account: { getToken: () => 'jwt-abc', isLoggedIn: () => true },
      accountAccess: overrides.accountAccess ?? false,
      // v2.5.1（A1/A2）：customers/share 适配器桩（契约测试不涉及这两个域）
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
      invoices: { list: async () => [], get: async () => null },
      inbounds: { list: async () => [], get: async () => null },
      cloudFetchImpl: { baseUrl: '' },
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
        getThumb: async () => '',
      },
      shareAccess: false,
    },
    overrides.limits,
  )
  return {
    deps: { validateManifest, host: inst.host, bus, logCalls, emitted, wsDir: wsPath, stateDir },
    dispose: () => inst.dispose(),
  }
}

/** 构造带真实工作区（含 UTF-8 文本 / 二进制 / 超限文件 / symlink 逃逸）的宿主，限界注入缩小便于触发 TOO_LARGE。 */
async function makeFilesHost(): Promise<HostCtx> {
  const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-contract-ws-'))
  await fsp.mkdir(path.join(wsDir, '导出'), { recursive: true })
  await fsp.writeFile(path.join(wsDir, 'a.txt'), '你好 hello', 'utf-8')
  await fsp.writeFile(path.join(wsDir, 'bin.dat'), Buffer.from([0, 1, 2, 0xff]))
  await fsp.writeFile(path.join(wsDir, 'big.txt'), 'x'.repeat(200))
  const outside = path.join(os.tmpdir(), `qihe-contract-outside-${path.basename(wsDir)}.txt`)
  await fsp.writeFile(outside, 'secret')
  await fsp.symlink(outside, path.join(wsDir, 'evil-link.txt'))
  return makeContractHost({
    workspacePath: () => wsDir,
    limits: { maxReadTextBytes: 100, maxReadBufferBytes: 100, maxExportBytes: 100 },
  })
}

/** 提取宿主业务错误的 code（成功 → undefined）。 */
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

// —— loader / installer 夹具（fuse.policy / retry.policy / install.check 行为断言）——

const cjsRequire = createRequire(import.meta.url)

async function makeLoaderFixture(mainJs: string): Promise<{
  loader: PluginLoader
  registry: PluginRegistry
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-contract-loader-'))
  const id = 'com.qihe.load'
  const pkg = path.join(root, id, PKG_DIR)
  fs.mkdirSync(path.join(pkg, 'main'), { recursive: true })
  fs.writeFileSync(
    path.join(pkg, 'manifest.json'),
    JSON.stringify({ id, name: 'x', version: '0.1.0', apiVersion: 1, enabled: true, kind: ['ipc'], ipcPrefix: 'load' }),
  )
  fs.writeFileSync(path.join(pkg, MAIN_ENTRY), mainJs)
  const registry = new PluginRegistry({ root, hostVersion: '2.5.0' })
  registry.scan()
  const loader = new PluginLoader({
    registry,
    root,
    createHost: (pid, manifest) =>
      createPluginHost({
        pluginId: pid,
        ipcPrefix: manifest.ipcPrefix,
        stateDir: path.join(root, pid, 'state'),
        bus: new HostEventBus(),
        log: () => {},
        workspace: { currentPath: () => null, list: () => null },
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
        invoices: { list: async () => [], get: async () => null },
        inbounds: { list: async () => [], get: async () => null },
        cloudFetchImpl: { baseUrl: '' },
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
          getThumb: async () => '',
        },
        shareAccess: false,
      }),
    importer: (url) => Promise.resolve(cjsRequire(fileURLToPath(url))),
    log: () => {},
  })
  return { loader, registry }
}

// ============================================================================
// 映射表（锚点 id → self-check 函数）：key 全集 = 唯一权威 oracle
// stage：v1 = API_VERSION=1 现在必须实现；v2.7 = 仅登记的未来承诺（无 check）。
// ============================================================================

interface ContractEntry {
  stage: 'v1' | 'v2.7'
  check?: (deps: ContractDeps) => void | Promise<void>
}

const CONTRACT: Record<string, ContractEntry> = {
  // —— §三 校验规则九条（validateManifest 逐条行为断言）——
  'contract:v1:manifest.rule1': {
    stage: 'v1',
    check: (deps) => {
      // id 域名倒序 / ipcPrefix 非空且不得 qihebox: 保留前缀（可判定部分）
      reject(deps.validateManifest, baseManifest({ id: 'hello' }), 'id')
      reject(deps.validateManifest, baseManifest({ id: 'com..qihe.hello' }), 'id')
      reject(deps.validateManifest, baseManifest({ ipcPrefix: '' }), 'ipcPrefix')
    },
  },
  'contract:v1:manifest.rule2': {
    stage: 'v1',
    check: (deps) => {
      // kind 声明与 pages/commands 字段存在性一致（双向）
      reject(deps.validateManifest, baseManifest({ kind: ['ipc', 'pages'] }), 'pages')
      reject(deps.validateManifest, baseManifest({ pages: [PAGE] }), 'pages')
      reject(deps.validateManifest, baseManifest({ kind: ['ipc', 'commands'] }), 'commands')
    },
  },
  'contract:v1:manifest.rule3': {
    stage: 'v1',
    check: (deps) => {
      // apiCompat 与宿主 API_VERSION=1 相交（不相交 → broken）
      reject(deps.validateManifest, baseManifest({ apiCompat: [2, 3] }), 'apiCompat')
    },
  },
  'contract:v1:manifest.rule4': {
    stage: 'v1',
    check: (deps) => {
      // pages[].path 须 /plugin/ 前缀；component 包内相对路径（拒绝绝对路径与 .. 逃逸）
      reject(deps.validateManifest, baseManifest({ pages: [{ ...PAGE, path: 'plugin/x' }] }), 'path')
      reject(deps.validateManifest, baseManifest({ pages: [{ ...PAGE, component: '../secret.js' }] }), 'component')
    },
  },
  'contract:v1:manifest.rule5': {
    stage: 'v1',
    check: (deps) => {
      // transport 缺省或 'inproc'；其余值 broken
      reject(deps.validateManifest, baseManifest({ transport: 'process' }), 'transport')
    },
  },
  'contract:v1:manifest.rule6': {
    stage: 'v1',
    check: (deps) => {
      // permissions.network 域名合法；'*' 须附 reasoning（落地为 description 非空）
      reject(deps.validateManifest, baseManifest({ permissions: { network: ['*'] } }), 'description')
      reject(deps.validateManifest, baseManifest({ permissions: { network: ['a..b'] } }), 'network')
    },
  },
  'contract:v1:manifest.rule7': {
    stage: 'v1',
    check: (deps) => {
      // activation.onEvent 通道须以本插件 ipcPrefix 开头（防冒充宿主事件）
      reject(deps.validateManifest, baseManifest({ activation: ['onEvent:workspaceChanged'] }), 'onEvent')
    },
  },
  'contract:v1:manifest.rule8': {
    stage: 'v1',
    check: (deps) => {
      // syncScope 合法枚举（global/local）或缺失（默认 local）
      reject(deps.validateManifest, baseManifest({ syncScope: 'cloud' }), 'syncScope')
    },
  },
  'contract:v1:manifest.rule9': {
    stage: 'v1',
    check: (deps) => {
      // permissions 子字段类型校验（account/clipboard/notification 布尔、network 字符串数组）
      reject(deps.validateManifest, baseManifest({ permissions: { account: 'yes' } }), 'permissions.account')
      reject(deps.validateManifest, baseManifest({ permissions: { clipboard: 'yes' } }), 'clipboard')
    },
  },

  // —— §5.1 宿主 → 插件：PluginHost 能力域（真实宿主行为断言）——
  'contract:v1:host.api-version': {
    stage: 'v1',
    check: (deps) => {
      expect(deps.host.apiVersion).toBe(1)
    },
  },
  'contract:v1:host.log': {
    stage: 'v1',
    check: (deps) => {
      deps.host.log('info', 'hello contract')
      expect(deps.logCalls).toContainEqual(['info', 'hello contract'])
    },
  },
  'contract:v1:host.storage': {
    stage: 'v1',
    check: async (deps) => {
      await deps.host.storage.set('k', { a: 1, b: [1, 2] })
      expect(await deps.host.storage.get('k')).toEqual({ a: 1, b: [1, 2] })
      expect(await deps.host.storage.get('missing')).toBeNull()
    },
  },
  'contract:v1:host.events': {
    stage: 'v1',
    check: (deps) => {
      // on 白名单强校验 + 往返（bus → 订阅回调）+ emit 前缀强校验
      for (const ch of HOST_EVENT_WHITELIST) {
        expect(() => deps.host.events.on(ch, () => {})).not.toThrow()
      }
      expect(() => deps.host.events.on('nope', () => {})).toThrow('白名单')
      const got: unknown[] = []
      const unsub = deps.host.events.on('workspaceChanged', (d) => got.push(d))
      deps.bus.emitHost('workspaceChanged', { a: 1 })
      expect(got).toEqual([{ a: 1 }])
      expect(() => deps.host.events.emit('workspaceChanged', 1)).toThrow('ipcPrefix')
      deps.host.events.emit('contract:ok', 1)
      expect(deps.emitted).toContainEqual(['contract:ok', 1])
      unsub()
      expect(() => unsub()).not.toThrow()
    },
  },
  'contract:v1:host.workspace': {
    stage: 'v1',
    check: async (deps) => {
      // 装配层注入实现原样透传（currentPath / list）
      expect(deps.host.workspace.currentPath()).toBeNull()
      expect(deps.host.workspace.list()).toBe(LIST_SENTINEL)
      const f = await makeFilesHost()
      try {
        expect(f.deps.host.workspace.currentPath()).toBe(f.deps.wsDir)
      } finally {
        f.dispose()
      }
    },
  },
  'contract:v1:host.dialog': {
    stage: 'v1',
    check: async (deps) => {
      await expect(deps.host.dialog.openFile({})).resolves.toBe(DIALOG_FILE)
      await expect(deps.host.dialog.openDirectory({})).resolves.toBe(DIALOG_DIR)
    },
  },
  'contract:v1:host.notify': {
    stage: 'v1',
    check: (deps) => {
      expect(deps.host.notify('标题', '正文')).toBe(NOTIFY_RESULT)
    },
  },
  'contract:v1:host.account': {
    stage: 'v1',
    check: async (deps) => {
      // permissions.account 未声明 → 恒 null/false（空实现注入）
      expect(deps.host.account.getToken()).toBeNull()
      expect(deps.host.account.isLoggedIn()).toBe(false)
      // 声明后 → 真实账号透传
      const on = await makeContractHost({ accountAccess: true })
      try {
        expect(on.deps.host.account.getToken()).toBe('jwt-abc')
        expect(on.deps.host.account.isLoggedIn()).toBe(true)
      } finally {
        on.dispose()
      }
    },
  },
  'contract:v1:host.files': {
    stage: 'v1',
    check: async () => {
      const ctx = await makeFilesHost()
      try {
        const host = ctx.deps.host
        expect(await host.files.readText('a.txt')).toBe('你好 hello')
        expect(await host.files.readBuffer('bin.dat')).toEqual(Buffer.from([0, 1, 2, 0xff]))
        await host.files.writeExport('report.txt', 'hello-export')
        expect(await fsp.readFile(path.join(ctx.deps.wsDir!, '导出', 'com.qihe.contract_report.txt'), 'utf-8')).toBe('hello-export')
      } finally {
        ctx.dispose()
      }
    },
  },
  'contract:v1:host.entitlement': {
    stage: 'v1',
    check: (deps) => {
      // 恒 free 占位 + 字段形状（红线 4：本体零订阅逻辑）
      expect(deps.host.entitlement.status()).toEqual({ tier: 'free', expiresAt: null, quota: null })
    },
  },

  // —— v2.5.1（A1/A2，PLAN-v2.6-v2.7 §3.1/§3.2）：customers / share 能力域 ——
  'contract:v1:host.customer': {
    stage: 'v1',
    check: async () => {
      // 契约锚点 = 实现存在性（方法签名面由 API surface 基线守护）+ 权限门控源包含
      // v2.5.4（弹一 C-5a）：customer 经 makeEntityDomain 工厂合一（adapter 注入装配层适配器）
      const hostSrc = readSource('src/main/plugins/host.ts')
      expect(hostSrc).toContain('makeEntityDomain')
      expect(hostSrc).toContain('adapter: deps.customers')
      expect(hostSrc).toContain('PERMISSION_DENIED')
      const typesSrc = readSource('src/plugins/types.ts')
      expect(typesSrc).toContain('customer: {')
      expect(typesSrc).toContain('syncProfile(req: {')
      // 门控行为：customersAccess=false → 全部方法抛 PERMISSION_DENIED（含读方法）
      const ctx = await makeContractHost()
      try {
        const h = ctx.deps.host as unknown as {
          customer: {
            list(): Promise<unknown>
            get(n: string): Promise<unknown>
            writeErpExt(n: string, e: Record<string, unknown>): Promise<void>
            syncProfile(r: { name: string; updated_at: string }): Promise<{ applied: boolean }>
            relation: { link(c: string, p: string): Promise<void>; unlink(c: string, p: string): Promise<void> }
          }
        }
        expect(await codeOf(h.customer.list())).toBe('PERMISSION_DENIED')
        expect(await codeOf(h.customer.get('x'))).toBe('PERMISSION_DENIED')
        expect(await codeOf(h.customer.relation.link('x', 'y'))).toBe('PERMISSION_DENIED')
      } finally {
        ctx.dispose()
      }
    },
  },
  'contract:v1:host.share': {
    stage: 'v1',
    check: async () => {
      const hostSrc = readSource('src/main/plugins/host.ts')
      expect(hostSrc).toContain('share = deps.shareAccess')
      const typesSrc = readSource('src/plugins/types.ts')
      expect(typesSrc).toContain('share: {')
      expect(typesSrc).toContain('writePulledFile(targetRelPath: string')
      // 门控行为：shareAccess=false → PERMISSION_DENIED
      const ctx = await makeContractHost()
      try {
        const h = ctx.deps.host as unknown as { share: { listProductSets(): Promise<unknown> } }
        expect(await codeOf(h.share.listProductSets())).toBe('PERMISSION_DENIED')
      } finally {
        ctx.dispose()
      }
    },
  },
  'contract:v1:host.supplier': {
    stage: 'v1',
    check: async () => {
      // v2.5.4（弹一 C-1/C-2，云桥 M3）：supplier 能力域实现存在性 + 权限门控
      // v2.5.4（弹一 C-5a）：supplier 与 customer 同经 makeEntityDomain 工厂合一
      const hostSrc = readSource('src/main/plugins/host.ts')
      expect(hostSrc).toContain('makeEntityDomain')
      expect(hostSrc).toContain('adapter: deps.suppliers')
      // C-5a：门控键经工厂参数注入（permissionDenied(cfg.permission) 动态）；运行态断言在上方 host 门控用例
      expect(hostSrc).toContain("permission: 'suppliers'")
      const typesSrc = readSource('src/plugins/types.ts')
      expect(typesSrc).toContain('supplier: {')
      expect(typesSrc).toContain('list(since?: string): Promise<SupplierProfile[]>')
      expect(typesSrc).toContain('syncProfile(req: {')
      expect(typesSrc).toContain('suppliers?: boolean')
      // 门控行为：suppliersAccess=false → 全部方法抛 PERMISSION_DENIED（含读方法）
      const ctx = await makeContractHost()
      try {
        const h = ctx.deps.host as unknown as {
          supplier: {
            list(): Promise<unknown>
            get(n: string): Promise<unknown>
            writeErpExt(n: string, e: Record<string, unknown>): Promise<void>
            syncProfile(r: { name: string; updated_at: string }): Promise<{ applied: boolean }>
          }
        }
        expect(await codeOf(h.supplier.list())).toBe('PERMISSION_DENIED')
        expect(await codeOf(h.supplier.get('x'))).toBe('PERMISSION_DENIED')
        expect(await codeOf(h.supplier.writeErpExt('x', {}))).toBe('PERMISSION_DENIED')
        expect(await codeOf(h.supplier.syncProfile({ name: 'x', updated_at: 't' }))).toBe('PERMISSION_DENIED')
      } finally {
        ctx.dispose()
      }
    },
  },
  'contract:v1:event.supplier': {
    stage: 'v1',
    check: () => {
      // v2.5.4（弹一 C-3，云桥 M3）：事件白名单 +2
      const hostSrc = readSource('src/main/plugins/host.ts')
      expect(hostSrc).toContain("'supplierCreated'")
      expect(hostSrc).toContain("'supplierUpdated'")
    },
  },
  'contract:v1:host.quote': {
    stage: 'v1',
    check: async () => {
      // v2.5.4（弹一 C-4，云桥 M3）：quote 只读域实现存在性 + 门控并入 customers
      const hostSrc = readSource('src/main/plugins/host.ts')
      expect(hostSrc).toContain('quote = deps.customersAccess')
      const typesSrc = readSource('src/plugins/types.ts')
      expect(typesSrc).toContain('quote: {')
      expect(typesSrc).toContain('list(since?: string): Promise<QuoteProfile[]>')
      // 无写方法（类型面断言）
      expect(typesSrc).toContain('**无任何写方法**')
      // 门控行为：customersAccess=false → quote 全部方法抛 PERMISSION_DENIED
      const ctx = await makeContractHost()
      try {
        const h = ctx.deps.host as unknown as {
          quote: { list(): Promise<unknown>; get(n: string): Promise<unknown> }
        }
        expect(await codeOf(h.quote.list())).toBe('PERMISSION_DENIED')
        expect(await codeOf(h.quote.get('BJ-1'))).toBe('PERMISSION_DENIED')
      } finally {
        ctx.dispose()
      }
    },
  },
  'contract:v1:host.invoice': {
    stage: 'v1',
    check: async () => {
      // v2.5.7（协议增量 E1）：invoice 只读域实现存在性 + 门控并入 customers（同 quote 拍板）
      const hostSrc = readSource('src/main/plugins/host.ts')
      expect(hostSrc).toContain('invoice = deps.customersAccess')
      const typesSrc = readSource('src/plugins/types.ts')
      expect(typesSrc).toContain('invoice: {')
      expect(typesSrc).toContain('list(since?: string): Promise<InvoiceProfile[]>')
      // 无写方法（只读投影）
      const ctx = await makeContractHost()
      try {
        const h = ctx.deps.host as unknown as { invoice: { list(): Promise<unknown>; get(n: string): Promise<unknown> } }
        expect(await codeOf(h.invoice.list())).toBe('PERMISSION_DENIED')
        expect(await codeOf(h.invoice.get('NO1'))).toBe('PERMISSION_DENIED')
      } finally {
        ctx.dispose()
      }
    },
  },
  'contract:v1:host.inbound': {
    stage: 'v1',
    check: async () => {
      // v2.5.7（协议增量 E2）：inbound 只读域实现存在性 + 门控并入 customers（同 quote 拍板）
      const hostSrc = readSource('src/main/plugins/host.ts')
      expect(hostSrc).toContain('inbound = deps.customersAccess')
      const typesSrc = readSource('src/plugins/types.ts')
      expect(typesSrc).toContain('inbound: {')
      expect(typesSrc).toContain('list(since?: string): Promise<InboundProfile[]>')
      const ctx = await makeContractHost()
      try {
        const h = ctx.deps.host as unknown as { inbound: { list(): Promise<unknown>; get(id: string): Promise<unknown> } }
        expect(await codeOf(h.inbound.list())).toBe('PERMISSION_DENIED')
        expect(await codeOf(h.inbound.get('RK1'))).toBe('PERMISSION_DENIED')
      } finally {
        ctx.dispose()
      }
    },
  },
  'contract:v1:event.customer-file-archived': {
    stage: 'v1',
    check: () => {
      // 事件白名单 +3（customerCreated/customerUpdated/fileArchived）
      const hostSrc = readSource('src/main/plugins/host.ts')
      expect(hostSrc).toContain("'customerCreated'")
      expect(hostSrc).toContain("'customerUpdated'")
      expect(hostSrc).toContain("'fileArchived'")
    },
  },

  // —— host.files 错误码 + 边界 ——
  'contract:v1:error.code': {
    stage: 'v1',
    check: async () => {
      const ctx = await makeFilesHost()
      try {
        const host = ctx.deps.host
        expect(await codeOf(host.files.readText('missing.txt'))).toBe('NOT_FOUND')
        expect(await codeOf(host.files.readText('../secret.txt'))).toBe('OUT_OF_WORKSPACE')
        expect(await codeOf(host.files.readText(42 as unknown as string))).toBe('INVALID_NAME')
        expect(await codeOf(host.files.readText('big.txt'))).toBe('TOO_LARGE')
      } finally {
        ctx.dispose()
      }
      // 无工作区 → NO_WORKSPACE
      const noWs = await makeContractHost()
      try {
        expect(await codeOf(noWs.deps.host.files.readText('a.txt'))).toBe('NO_WORKSPACE')
      } finally {
        noWs.dispose()
      }
      // 六错误码齐备（IO_ERROR 为读写兜底，源包含断言兜底不可确定性触发）
      const hostSrc = readSource('src/main/plugins/host.ts')
      for (const c of ['NOT_FOUND', 'OUT_OF_WORKSPACE', 'NO_WORKSPACE', 'TOO_LARGE', 'INVALID_NAME', 'IO_ERROR']) {
        expect(hostSrc).toContain(`'${c}'`)
      }
    },
  },
  'contract:v1:host.files.boundary': {
    stage: 'v1',
    check: async () => {
      // 10MB/50MB 限界常量 + 注入缩小限界行为 + realpath 防 symlink 逃逸
      expect(DEFAULT_STORAGE_LIMITS.maxReadTextBytes).toBe(10 * 1024 * 1024)
      expect(DEFAULT_STORAGE_LIMITS.maxReadBufferBytes).toBe(50 * 1024 * 1024)
      expect(DEFAULT_STORAGE_LIMITS.maxExportBytes).toBe(50 * 1024 * 1024)
      const ctx = await makeFilesHost()
      try {
        const host = ctx.deps.host
        expect(await codeOf(host.files.readText('big.txt'))).toBe('TOO_LARGE')
        expect(await codeOf(host.files.readBuffer('big.txt'))).toBe('TOO_LARGE')
        expect(await codeOf(host.files.writeExport('ok.txt', 'x'.repeat(200)))).toBe('TOO_LARGE')
        expect(await codeOf(host.files.readText('evil-link.txt'))).toBe('OUT_OF_WORKSPACE')
      } finally {
        ctx.dispose()
      }
    },
  },

  // —— §5.2 插件 → 宿主：PluginRegistration（types 同源类型面断言）——
  'contract:v1:registration.ipc': {
    stage: 'v1',
    check: () => {
      const types = new Set(extractApiSurface().types)
      expect([...types].some((l) => l.startsWith('PluginRegistration.ipc') && l.includes('Record<string'))).toBe(true)
    },
  },
  'contract:v1:registration.pages': {
    stage: 'v1',
    check: () => {
      const types = new Set(extractApiSurface().types)
      expect([...types].some((l) => l.startsWith('PluginRegistration.pages') && l.includes("PluginManifest['pages']"))).toBe(true)
    },
  },
  'contract:v1:registration.commands': {
    stage: 'v1',
    check: () => {
      const types = new Set(extractApiSurface().types)
      expect([...types].some((l) => l.startsWith('PluginRegistration.commands') && l.includes('Record<string'))).toBe(true)
    },
  },
  'contract:v1:registration.dispose': {
    stage: 'v1',
    check: () => {
      const types = new Set(extractApiSurface().types)
      expect([...types].some((l) => l.startsWith('PluginRegistration.dispose') && l.includes('() => void'))).toBe(true)
    },
  },
  // v2.5.4：插件 IPC 返回 ApiResult 形状 → 宿主透传（防双层信封）。src/main/plugins/ipc.ts 行为锚：
  // 读取源码断言「按 success 布尔透传」分支存在（行为由 e2e/真链实证，此处防契约代码漂移）。
  'contract:v1:registration.api-result-passthrough': {
    stage: 'v1',
    check: () => {
      const src = fs.readFileSync(path.join(repoRoot, 'src/main/plugins/ipc.ts'), 'utf-8')
      expect(src).toContain("'success' in r")
      expect(src).toMatch(/typeof \(r as \{ success: unknown \}\)\.success === 'boolean'/)
    },
  },

  // —— §5.3 渲染层 → 宿主：window.qihebox.plugins / settings（preload 面清单）——
  'contract:v1:window.plugins': {
    stage: 'v1',
    check: () => {
      expect(PRELOAD_MANIFEST.plugins).toEqual(['list', 'call', 'setEnabled', 'install', 'uninstall', 'on'])
      assertPreloadManifestMatchesSource()
      // 签名口径（P1-E1/A3）：plugins 命名空间方法返回 ApiResult 包装；install 返回 ApiResult<PluginInfo>
      // （组 D 已把 PLUGIN.md §5.3 改为 ApiResult 口径，此处守护 preload 源码与文档一致）
      const preload = readSource('src/preload/index.ts')
      expect(preload).toContain('ApiResult<')
      expect(preload).toContain('list: (): Promise<ApiResult<PluginInfo[]>>')
      expect(preload).toContain('call: (pluginId: string, action: string, payload?: unknown): Promise<ApiResult<unknown>>')
      expect(preload).toContain('setEnabled: (pluginId: string, enabled: boolean): Promise<ApiResult<boolean>>')
      expect(preload).toContain('install: (source: { filePath: string }): Promise<ApiResult<PluginInfo>>')
      expect(preload).toContain('uninstall: (pluginId: string): Promise<ApiResult<boolean>>')
    },
  },
  'contract:v1:window.settings': {
    stage: 'v1',
    check: () => {
      expect(PRELOAD_MANIFEST.settings).toEqual(['getDevMode', 'setDevMode'])
      // 签名口径（P1-E2）：settings 命名空间返回 ApiResult<boolean>（对齐全仓 handle() 纪律）
      const preload = readSource('src/preload/index.ts')
      expect(preload).toContain('getDevMode: (): Promise<ApiResult<boolean>>')
      expect(preload).toContain('setDevMode: (enabled: boolean): Promise<ApiResult<boolean>>')
    },
  },

  // —— §5.4 IPC 通道命名 ——
  'contract:v1:ipc.channels': {
    stage: 'v1',
    check: () => {
      expect(IPC_CHANNELS).toEqual([
        'qihebox:plugins:list',
        'qihebox:plugins:call',
        'qihebox:plugins:setEnabled',
        'qihebox:plugins:install',
        'qihebox:plugins:uninstall',
        'qihebox:settings:getDevMode',
        'qihebox:settings:setDevMode',
      ])
      assertIpcManifestMatchesSource()
    },
  },

  // —— API 版本与演进政策 ——
  'contract:v1:api-version': {
    stage: 'v1',
    check: (deps) => {
      expect(API_VERSION).toBe(1)
      expect(deps.validateManifest(baseManifest({ apiCompat: [0, 2] })).ok).toBe(true) // 相交
      expect(deps.validateManifest(baseManifest({ apiCompat: [2, 3] })).ok).toBe(false) // 不相交
    },
  },
  'contract:v1:api-evolution': {
    stage: 'v1',
    check: () => {
      // 只增不删：由 Task 1 的 API 面基线（超集强制）守护，此处断言基线存在且声明"只增不删"
      const baseline = fs.readFileSync(BASELINE_PATH, 'utf-8')
      expect(baseline).toContain('只增不删')
      // @deprecated 存活条款（§四.1：废弃字段标记 @deprecated，至少存活一个宿主大版本）：
      // 标记废弃的符号仍须导出（API 面可见）——v2.5.7（F4a）getToken 被 cloudFetch 取代但仍保留导出
      const typesSrc = readSource('src/plugins/types.ts')
      if (typesSrc.includes('@deprecated')) {
        // 任一 @deprecated 成员须仍出现在序列化 API 面中（存活）
        const surface = extractApiSurface()
        const all = [...surface.types, ...surface.preload, ...surface.ipc].join('\n')
        // getToken 是当前唯一 @deprecated 符号（F4a 决策）；断言其仍导出
        expect(all).toContain('PluginHost.account.getToken')
        expect(typesSrc).toContain('@deprecated') // 标记仍在（契约承诺废弃而存活）
      }
    },
  },

  // —— 熔断 / 重试政策（真实 loader 行为断言）——
  'contract:v1:fuse.policy': {
    stage: 'v1',
    check: async () => {
      expect(BREAK_THRESHOLD).toBe(3)
      // 连续 3 次握手失败 → 自动 broken
      const a = await makeLoaderFixture('module.exports = { activate: async () => { throw new Error("activate boom") } }')
      for (let i = 1; i <= BREAK_THRESHOLD; i++) {
        await expect(a.loader.call('com.qihe.load', 'echo', null)).rejects.toThrow('activate boom')
      }
      expect(a.registry.get('com.qihe.load')!.state).toBe('broken')
      expect(a.registry.get('com.qihe.load')!.brokenReason).toContain('熔断')
      // 带 code 业务错误不计熔断（超阈值仍 enabled、failCount 0）
      const b = await makeLoaderFixture(
        'module.exports = { activate: async () => ({ ipc: { boom: async () => { const e = new Error("business fail"); e.code = "TOO_LARGE"; throw e } } }) }',
      )
      for (let i = 0; i < BREAK_THRESHOLD + 1; i++) {
        await expect(b.loader.call('com.qihe.load', 'boom', null)).rejects.toThrow('business fail')
      }
      expect(b.registry.get('com.qihe.load')!.state).toBe('enabled')
      expect(b.registry.get('com.qihe.load')!.failCount).toBe(0)
    },
  },
  'contract:v1:retry.policy': {
    stage: 'v1',
    check: async () => {
      // 仅加载/握手失败重试：一次加载失败 → 本次报错但保持 enabled（failCount 计数，下次触发重试）
      const { loader, registry } = await makeLoaderFixture(
        'module.exports = { activate: async () => { throw new Error("activate boom") } }',
      )
      await expect(loader.call('com.qihe.load', 'echo', null)).rejects.toThrow('activate boom')
      expect(registry.get('com.qihe.load')!.state).toBe('enabled')
      expect(registry.get('com.qihe.load')!.failCount).toBe(1)
    },
  },

  // —— 事件前缀 / storage 限界 / 保留通道 ——
  'contract:v1:event.prefix': {
    stage: 'v1',
    check: (deps) => {
      // emit 通道须 ipcPrefix 前缀；宿主保留事件只能 on 不能 emit
      expect(() => deps.host.events.emit('workspaceChanged', 1)).toThrow('ipcPrefix')
      expect(() => deps.host.events.emit('contract:ok', 1)).not.toThrow()
      expect(() => deps.host.events.on('qihebox:event:update:available', () => {})).toThrow('白名单')
    },
  },
  'contract:v1:storage.bounds': {
    stage: 'v1',
    check: async () => {
      expect(DEFAULT_STORAGE_LIMITS.maxKeyBytes).toBe(1024 * 1024)
      expect(DEFAULT_STORAGE_LIMITS.maxTotalBytes).toBe(64 * 1024 * 1024)
      const ctx = await makeContractHost({ limits: { maxKeyBytes: 100 } })
      try {
        await expect(ctx.deps.host.storage.set('big', 'x'.repeat(200))).rejects.toThrow('超限')
      } finally {
        ctx.dispose()
      }
    },
  },
  'contract:v1:channel.reserved': {
    stage: 'v1',
    check: (deps) => {
      // qihebox:* 保留前缀禁注册（ipcPrefix 强校验）
      for (const p of ['qihebox:x', 'qihebox:plugins:x', 'qihebox:event:x', 'qihebox:settings:x']) {
        reject(deps.validateManifest, baseManifest({ ipcPrefix: p }), 'qihebox:')
      }
    },
  },

  // —— 安装校验 / 侧载收紧 / CSP / 语义 ——
  'contract:v1:install.check': {
    stage: 'v1',
    check: async () => {
      // JSON Schema（validateManifest）+ SHA-256 校验：合法包安装成功且 sha256 记录；坏 manifest 拒绝
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-contract-install-'))
      const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-contract-staging-'))
      await fsp.mkdir(path.join(staging, 'main'), { recursive: true })
      await fsp.writeFile(
        path.join(staging, 'manifest.json'),
        JSON.stringify({ id: 'com.qihe.inst', name: 'x', version: '0.1.0', apiVersion: 1, enabled: true, kind: ['ipc'], ipcPrefix: 'inst' }),
      )
      await fsp.writeFile(path.join(staging, MAIN_ENTRY), 'module.exports = { activate: async () => ({ ipc: {} }) }')
      const qbox = path.join(root, 'com.qihe.inst.qbox')
      await compressToZip([path.join(staging, 'manifest.json'), path.join(staging, 'main')], qbox)
      const registry = new PluginRegistry({ root, hostVersion: '2.5.0' })
      registry.scan()
      const installer = new PluginInstaller({ root, registry, log: () => {} })
      const r = await installer.install(qbox)
      expect(r.id).toBe('com.qihe.inst')
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(r.sha256).toBe(await sha256OfFile(qbox))
      expect(fs.readFileSync(path.join(root, 'com.qihe.inst', '.qbox.sha256'), 'utf-8')).toBe(r.sha256)
      // 坏 manifest（apiCompat 不相交）→ JSON Schema 校验拒绝
      const badStaging = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-contract-bad-'))
      await fsp.mkdir(path.join(badStaging, 'main'), { recursive: true })
      await fsp.writeFile(
        path.join(badStaging, 'manifest.json'),
        JSON.stringify({ id: 'com.qihe.bad', name: 'x', version: '0.1.0', apiVersion: 1, enabled: true, kind: ['ipc'], ipcPrefix: 'bad', apiCompat: [2, 3] }),
      )
      await fsp.writeFile(path.join(badStaging, MAIN_ENTRY), 'module.exports = { activate: async () => ({ ipc: {} }) }')
      const badQbox = path.join(root, 'com.qihe.bad.qbox')
      await compressToZip([path.join(badStaging, 'manifest.json'), path.join(badStaging, 'main')], badQbox)
      await expect(installer.install(badQbox)).rejects.toThrow('apiCompat')
    },
  },
  'contract:v1:sideload.gate': {
    stage: 'v1',
    check: async () => {
      // devMode 门控：默认关，setDevMode(true) 落盘持久化（IPC 层 DEV_MODE_REQUIRED 强制为 electron，源包含断言）
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-contract-settings-'))
      const s = createSettings(dir)
      expect(s.getDevMode()).toBe(false)
      await s.setDevMode(true)
      expect(s.getDevMode()).toBe(true)
      const raw = JSON.parse(await fsp.readFile(path.join(dir, 'settings.json'), 'utf-8')) as { devMode?: boolean }
      expect(raw.devMode).toBe(true)
      // IPC 层门控 + 确认框文案（electron 装配层不可 node 直测，源包含断言）
      expect(readSource('src/main/plugins/ipc.ts')).toContain('DEV_MODE_REQUIRED')
      expect(readSource('src/renderer/src/plugins/PluginManagerPage.tsx')).toContain('此插件将获得与启禾文件管理同等的系统权限')
    },
  },
  'contract:v1:security.csp': {
    stage: 'v1',
    check: () => {
      // CSP 头已落地（4fc39b4）：qihebox://plugin/<id>/ 响应附加 Content-Security-Policy（PLUGIN_CSP），
      // 兑现 §六 规则 5 承诺；删头即红。同时保留协议 URL 资源边界断言（受控协议 URL + 路径逃逸拒绝）。
      const proto = readSource('src/main/protocol.ts')
      expect(proto).toContain('Content-Security-Policy')
      expect(proto).toContain('PLUGIN_CSP')
      expect(proto).toContain('qihebox://plugin/')
      expect(proto).toContain('parsePluginUrl')
      expect(proto).toContain('resolvePluginAsset')
      expect(proto).toContain("seg === '..'")
      expect(proto).toContain('realpath')
    },
  },
  'contract:v1:sync-scope.semantics': {
    stage: 'v1',
    check: (deps) => {
      // 语义 = 声明与展示（v2.5 不消费）：'global'/'local'/缺省（默认 local）均合法
      expect(deps.validateManifest(baseManifest({ syncScope: 'global' })).ok).toBe(true)
      expect(deps.validateManifest(baseManifest({ syncScope: 'local' })).ok).toBe(true)
      expect(deps.validateManifest(baseManifest()).ok).toBe(true)
    },
  },
  'contract:v1:state.isolation': {
    stage: 'v1',
    check: async (deps) => {
      // 状态只能写在 userData/plugins/<id>/state/（每 key 一个 JSON 文件，不进工作区/本体 config）
      await deps.host.storage.set('k', 42)
      expect(fs.existsSync(path.join(deps.stateDir, 'k.json'))).toBe(true)
    },
  },
  'contract:v1:memory.zero': {
    stage: 'v1',
    check: async () => {
      // 未启用零内存/惰性加载：registry.scan() 只读 manifest，不执行插件 main 入口代码
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-contract-mem-'))
      const id = 'com.qihe.mem'
      const pkg = path.join(root, id, PKG_DIR)
      fs.mkdirSync(path.join(pkg, 'main'), { recursive: true })
      fs.writeFileSync(
        path.join(pkg, 'manifest.json'),
        JSON.stringify({ id, name: 'x', version: '0.1.0', apiVersion: 1, enabled: true, kind: ['ipc'], ipcPrefix: 'mem' }),
      )
      fs.writeFileSync(path.join(pkg, MAIN_ENTRY), 'throw new Error("should not load at scan time")')
      const registry = new PluginRegistry({ root, hostVersion: '2.5.0' })
      registry.scan() // 不执行 main/index.js
      expect(registry.get(id)!.state).toBe('enabled')
    },
  },

  // —— v2.7 仅登记的未来承诺（无 check：self-check 只断言文档登记存在）——
  'contract:v2.7:window.plugins.catalog': { stage: 'v2.7' },
  'contract:v2.7:customer.list': { stage: 'v2.7' },
  'contract:v2.7:customer.get': { stage: 'v2.7' },
  'contract:v2.7:customer.write-erp-ext': { stage: 'v2.7' },
  'contract:v2.7:customer.sync-profile': { stage: 'v2.7' },
  'contract:v2.7:relation.link': { stage: 'v2.7' },
  'contract:v2.7:relation.unlink': { stage: 'v2.7' },
  'contract:v2.7:event.customer-created': { stage: 'v2.7' },
  'contract:v2.7:event.customer-updated': { stage: 'v2.7' },
  'contract:v2.7:event.file-archived': { stage: 'v2.7' },
  'contract:v2.7:erp-ext.schema': { stage: 'v2.7' },
  'contract:v2.7:transport.process': { stage: 'v2.7' },
  'contract:v2.7:transport.http': { stage: 'v2.7' },
}

// ============================================================================
// 测试
// ============================================================================

function readPublicAnchors(): Set<string> {
  return extractAnchors(fs.readFileSync(PUBLIC_PLUGIN_MD, 'utf-8'))
}

describe('契约对账（docs/PLUGIN.md ↔ 实现）', () => {
  it('公开版锚点集合 === 映射表 key 全集（唯一权威 oracle；缺锚点/多锚点/无映射锚点 → 红）', () => {
    const doc = readPublicAnchors()
    const mapping = new Set(Object.keys(CONTRACT))
    const missing = [...mapping].filter((k) => !doc.has(k))
    const extra = [...doc].filter((k) => !mapping.has(k))
    expect(missing, `文档缺锚点：${missing.join(', ')}`).toEqual([])
    expect(extra, `文档多锚点/无映射锚点：${extra.join(', ')}`).toEqual([])
  })

  // 内部版（docs/INTERNAL/）为 gitignore 黑名单文件，CI checkout 后不存在 → CI 跳过；
  // 本地双份同步验证（黑名单纪律：内部版本地保留不进仓库）
  it.skipIf(!fs.existsSync(INTERNAL_PLUGIN_MD))('内部版 docs/INTERNAL/PLUGIN.md 锚点与公开版双份同步', () => {
    const internal = extractAnchors(fs.readFileSync(INTERNAL_PLUGIN_MD, 'utf-8'))
    const publicAnchors = readPublicAnchors()
    const onlyInternal = [...internal].filter((k) => !publicAnchors.has(k))
    const onlyPublic = [...publicAnchors].filter((k) => !internal.has(k))
    expect(onlyInternal, `内部版独有锚点：${onlyInternal.join(', ')}`).toEqual([])
    expect(onlyPublic, `公开版有、内部版缺：${onlyPublic.join(', ')}`).toEqual([])
  })

  it('映射表 v1 锚点全部具备 self-check（无漏配 self-check）', () => {
    for (const [id, entry] of Object.entries(CONTRACT)) {
      if (id.startsWith('contract:v1:')) {
        expect(typeof entry.check, `${id} 须有 self-check 函数`).toBe('function')
      }
    }
  })

  // 每个 v1 锚点执行 self-check（注入真实实现，行为级断言）
  for (const [id, entry] of Object.entries(CONTRACT)) {
    if (id.startsWith('contract:v1:')) {
      it(`v1 self-check: ${id}`, async () => {
        const ctx = await makeContractHost()
        try {
          await entry.check!(ctx.deps)
        } finally {
          ctx.dispose()
        }
      })
    }
  }

  it('反查：PluginHost 接口成员名均有对应锚点（实现有、文档无 → 红）', () => {
    const names = extractHostMemberNames(extractApiSurface().types)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const anchorId = `contract:v1:host.${camelToKebab(name)}`
      expect(Object.hasOwn(CONTRACT, anchorId), `host.${name} 缺契约锚点 ${anchorId}`).toBe(true)
    }
  })
})

// —— v2.5.5（B2）：prefill 数字字段 pickNumber 边界（协议稳定性收口，PLAN §三）——
describe('pickNumber 边界（预填数字字段归一化：finite 直收 / 数值字符串转换 / 0 合法 / 其余丢弃）', () => {
  it('0 合法（number 与 数值字符串均收为 0）', () => {
    expect((normalizePrefill('invoice', { amount: 0 }) as InvoicePrefill).amount).toBe(0)
    expect((normalizePrefill('invoice', { amount: '0' }) as InvoicePrefill).amount).toBe(0)
    expect((normalizePrefill('invoice', { amount: '0.00' }) as InvoicePrefill).amount).toBe(0)
  })

  it('数值字符串转换（含 trim、负数、小数）', () => {
    expect((normalizePrefill('invoice', { amount: '123.45' }) as InvoicePrefill).amount).toBe(123.45)
    expect((normalizePrefill('invoice', { amount: '-9.9' }) as InvoicePrefill).amount).toBe(-9.9)
    expect((normalizePrefill('invoice', { amount: '  88  ' }) as InvoicePrefill).amount).toBe(88)
  })

  it('负数允许（finite 直收）', () => {
    expect((normalizePrefill('invoice', { amount: -12.5 }) as InvoicePrefill).amount).toBe(-12.5)
    expect((normalizePrefill('invoice', { amount: '-12.5' }) as InvoicePrefill).amount).toBe(-12.5)
  })

  it('NaN / Infinity / -Infinity 丢弃（number 与字符串注入均不收）', () => {
    expect((normalizePrefill('invoice', { amount: NaN }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: Infinity }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: -Infinity }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: 'NaN' }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: 'Infinity' }) as InvoicePrefill).amount).toBeUndefined()
  })

  it('垃圾字符串注入丢弃（含空串/纯空白/夹数字垃圾）', () => {
    expect((normalizePrefill('invoice', { amount: 'abc' }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: '1.2.3' }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: '12abc34' }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: '' }) as InvoicePrefill).amount).toBeUndefined()
    expect((normalizePrefill('invoice', { amount: '   ' }) as InvoicePrefill).amount).toBeUndefined()
  })

  it('quote 明细行 qty/unit_price 走同一 pickNumber（0/负数/小数/垃圾）', () => {
    const out = normalizePrefill('quote', {
      lines: [
        { qty: 0, unit_price: -1.5 },
        { qty: '2', unit_price: '3.5' },
        { qty: NaN, unit_price: 'abc' },
        { qty: 'x', unit_price: Infinity },
      ],
    }) as QuotePrefill
    expect(out.lines).toEqual([
      { qty: 0, unit_price: -1.5 },
      { qty: 2, unit_price: 3.5 },
      {},
      {},
    ])
  })
})

// —— 反查辅助 ——

function camelToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** 从 API 面 types 节提取 PluginHost 接口顶层成员名（仅第一层，嵌套成员如 storage.get 不计）。 */
function extractHostMemberNames(types: string[]): string[] {
  const names = new Set<string>()
  for (const line of types) {
    const m = /^PluginHost\.([A-Za-z0-9_]+)[(:]/.exec(line)
    if (m) names.add(m[1])
  }
  return [...names]
}
