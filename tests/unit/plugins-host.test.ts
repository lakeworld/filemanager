/**
 * 主进程插件宿主单测（v2.5，P0）：registry / loader / installer / host（PLAN §八测试计划）。
 * - registry：发现扫描 / 校验规则逐条（apiCompat、transport、id 不一致、缺入口、minHostVersion）/
 *   broken 标记与原因 / config 启停覆盖 / 全局冲突（ipcPrefix、页面路径）/ 熔断重置
 * - loader：IPC 首达惰性加载 / activate 抛错重试 + 连续 3 次熔断 / 激活握手超时（默认 15s、env 覆盖、
 *   迟到 registration dispose）/ disposeAll 同步释放 / 熔断走幂等 deactivate / dispose / 未安装/未启用报错 /
 *   onEvent 触发 / host.events 订阅与停用回收 / registration 校验
 * - installer：Schema 校验 / SHA-256 / zip-slip 拦截 / pkg 与 state 分离 / 卸载清理 / 安装冲突 / 全局冲突回滚
 * - host：storage 往返与限界（单 key/总容量/路径逃逸）/ events 白名单与前缀强校验 / dispose 清理
 * 插件加载用 createRequire（CJS 包，与 hello 构建产物同形态）；不 import electron（ipc.ts 除外，纯 electron 装配不在此测）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PluginRegistry, PKG_DIR, resolvePluginText, versionAtLeast } from '../../src/main/plugins/registry'
import { PluginLoader, BREAK_THRESHOLD } from '../../src/main/plugins/loader'
import { PluginInstaller, sha256OfFile } from '../../src/main/plugins/installer'
import { createPluginHost, HostEventBus, HOST_EVENT_WHITELIST } from '../../src/main/plugins/host'
import { createSettings } from '../../src/main/settings'
import { compressToZip } from '../../src/main/core/archive'
import type { PluginManifest } from '../../src/plugins/types'

// —— 公共测试工具 ——

let root = ''

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-plugins-test-'))
})

const g = globalThis as Record<string, unknown>

/** CJS 包加载器（与 hello 构建产物同形态；require 对加载失败不缓存，熔断重试可复现） */
const cjsRequire = createRequire(import.meta.url)
function cjsImporter(url: string): Promise<unknown> {
  return Promise.resolve(cjsRequire(fileURLToPath(url)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 合法清单（ipcPrefix 取 id 末段，保证跨插件唯一） */
function manifestFor(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: '示例插件',
    version: '0.1.0',
    apiVersion: 1,
    enabled: true,
    kind: ['ipc'],
    ipcPrefix: id.split('.').pop() ?? id,
    ...overrides,
  }
}

/** 写插件包：root/<id>/pkg/{manifest.json,main/index.js} */
function writePlugin(id: string, overrides: Record<string, unknown> = {}, mainJs = OK_MAIN_JS): string {
  const pkg = path.join(root, id, PKG_DIR)
  fs.mkdirSync(path.join(pkg, 'main'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifestFor(id, overrides)))
  fs.writeFileSync(path.join(pkg, 'main', 'index.js'), mainJs)
  return pkg
}

const OK_MAIN_JS = `
module.exports = {
  activate: async (host) => {
    globalThis.__pluginAct = (globalThis.__pluginAct || 0) + 1
    return {
      ipc: { echo: async (args) => ({ pong: args }) },
      dispose: () => { globalThis.__pluginDispose = (globalThis.__pluginDispose || 0) + 1 },
    }
  },
}
`

const THROW_ACTIVATE_JS = `
module.exports = { activate: async () => { throw new Error('activate boom') } }
`

const SUBSCRIBE_JS = `
module.exports = {
  activate: async (host) => {
    host.events.on('workspaceChanged', (data) => { globalThis.__pluginEvt = data })
    return { ipc: { ping: async () => 'pong' } }
  },
}
`

/** v2.5 增量（PLAN §3.3）：handler 抛带 code 属性的业务错误（host.files 同形态）——不得计数熔断 */
const BUSINESS_ERROR_JS = `
module.exports = {
  activate: async () => ({
    ipc: {
      boom: async () => {
        const e = new Error('business fail: file too large')
        e.code = 'TOO_LARGE'
        throw e
      },
    },
  }),
}
`

/** P1-A1：handler 抛带 code 属性但非业务码的原生 Node 错误（ENOENT 同形态）——应计入熔断 */
const NODE_ERROR_JS = `
module.exports = {
  activate: async () => ({
    ipc: {
      boom: async () => {
        const e = new Error("ENOENT: no such file or directory")
        e.code = 'ENOENT'
        throw e
      },
    },
  }),
}
`

/** loader 测试用 createHost：host.ts 真实实现（含 state 缓存）；
 *  v2.5 增量：account/accountAccess 注入（缺省空实现 + 无权限门控） */
function makeCreateHost(bus: HostEventBus, overrides: Partial<Parameters<typeof createPluginHost>[0]> = {}) {
  return (id: string, manifest: PluginManifest) =>
    createPluginHost({
      pluginId: id,
      ipcPrefix: manifest.ipcPrefix,
      stateDir: path.join(root, id, 'state'),
      bus,
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
      ...overrides,
    })
}

function makeRegistry(): PluginRegistry {
  const r = new PluginRegistry({ root, hostVersion: '2.5.0' })
  r.scan()
  return r
}

// ==================== registry ====================

describe('PluginRegistry：发现与校验', () => {
  it('空目录（未安装任何插件）→ 空清单', () => {
    expect(makeRegistry().list()).toEqual([])
  })

  it('发现扫描：多插件登记、PluginText 解析、installedAt、state 映射', () => {
    writePlugin('com.qihe.a')
    writePlugin('com.qihe.b', { name: { default: '示例B', en: 'Sample B' } })
    const list = makeRegistry().list()
    expect(list).toHaveLength(2)
    const a = list.find((x) => x.id === 'com.qihe.a')!
    expect(a.name).toBe('示例插件')
    expect(a.state).toBe('enabled')
    expect(a.kind).toEqual(['ipc'])
    expect(a.installedAt).toBeTruthy()
    expect(a.callCount).toBe(0)
    expect(a.failCount).toBe(0)
    const b = list.find((x) => x.id === 'com.qihe.b')!
    expect(b.name).toBe('示例B')
    expect(b.kind).toEqual(['ipc'])
  })

  it('清单缺失（pkg/manifest.json 不存在）→ broken', () => {
    fs.mkdirSync(path.join(root, 'com.qihe.x', PKG_DIR), { recursive: true })
    const e = makeRegistry().get('com.qihe.x')!
    expect(e.state).toBe('broken')
    expect(e.brokenReason).toContain('清单缺失')
  })

  it('manifest 非法 JSON → broken（解析失败）', () => {
    const pkg = path.join(root, 'com.qihe.x', PKG_DIR)
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'manifest.json'), '{ not json')
    fs.mkdirSync(path.join(pkg, 'main'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'main', 'index.js'), '')
    expect(makeRegistry().get('com.qihe.x')!.brokenReason).toContain('解析失败')
  })

  it('apiCompat 与宿主不相交 → broken（规则③）', () => {
    writePlugin('com.qihe.x', { apiCompat: [2, 3] })
    expect(makeRegistry().get('com.qihe.x')!.brokenReason).toContain('apiCompat')
  })

  it('transport 非法 → broken（规则⑤）', () => {
    writePlugin('com.qihe.x', { transport: 'process' })
    expect(makeRegistry().get('com.qihe.x')!.brokenReason).toContain('transport')
  })

  it('manifest.id 与安装目录不一致 → broken', () => {
    writePlugin('com.qihe.x', { id: 'com.other.x' })
    const e = makeRegistry().get('com.qihe.x')!
    expect(e.state).toBe('broken')
    expect(e.brokenReason).toContain('id 与安装目录不一致')
  })

  it('缺主进程入口 main/index.js → broken（PLAN §1.4 缺入口）', () => {
    const pkg = path.join(root, 'com.qihe.x', PKG_DIR)
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifestFor('com.qihe.x')))
    expect(makeRegistry().get('com.qihe.x')!.brokenReason).toContain('缺主进程入口')
  })

  it('minHostVersion 高于宿主 → broken', () => {
    writePlugin('com.qihe.x', { minHostVersion: '2.6.0' })
    expect(makeRegistry().get('com.qihe.x')!.brokenReason).toContain('minHostVersion')
  })

  it('ipcPrefix 全局唯一：冲突 → 后登记插件 broken', () => {
    writePlugin('com.qihe.a', { ipcPrefix: 'dup' })
    writePlugin('com.qihe.b', { ipcPrefix: 'dup' })
    const registry = makeRegistry()
    expect(registry.get('com.qihe.a')!.state).toBe('enabled')
    expect(registry.get('com.qihe.b')!.state).toBe('broken')
    expect(registry.get('com.qihe.b')!.brokenReason).toContain('ipcPrefix 冲突')
  })

  it('页面路径校验与冲突：非 /plugin/ 前缀拒绝（协议收紧） / 插件间重叠', () => {
    // ① 非 '/plugin/' 前缀 → 清单校验失败（v2.5 协议收紧：宿主统一 /plugin/* 通配分发，PLAN-v2.5）
    writePlugin('com.qihe.a', {
      kind: ['ipc', 'pages'],
      pages: [{ path: '/settings/blocked', label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }],
    })
    writePlugin('com.qihe.b', {
      kind: ['ipc', 'pages'],
      pages: [{ path: '/plugin/x', label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }],
    })
    writePlugin('com.qihe.c', {
      kind: ['ipc', 'pages'],
      pages: [{ path: '/plugin/x/sub', label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }],
    })
    // ④ 根路径（无 /plugin/ 前缀）→ 校验失败
    writePlugin('com.qihe.d', {
      kind: ['ipc', 'pages'],
      pages: [{ path: '/', label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }],
    })
    const registry = makeRegistry()
    expect(registry.get('com.qihe.a')!.brokenReason).toContain('须以 "/plugin/" 开头')
    expect(registry.get('com.qihe.b')!.state).toBe('enabled')
    expect(registry.get('com.qihe.c')!.brokenReason).toContain('页面路径冲突') // 与 b 的 /plugin/x 子树重叠
    expect(registry.get('com.qihe.d')!.brokenReason).toContain('须以 "/plugin/" 开头')
  })

  it('config 启停覆盖 manifest.enabled；setEnabled 持久化并在新实例读回', async () => {
    writePlugin('com.qihe.a') // manifest.enabled=true
    const cfgPath = path.join(root, 'config.json')
    fs.writeFileSync(cfgPath, JSON.stringify({ 'com.qihe.a': false }))
    let registry = makeRegistry()
    expect(registry.get('com.qihe.a')!.state).toBe('disabled')
    expect(registry.get('com.qihe.a')!.enabled).toBe(false)
    // 管理页启用 → config.json 落盘
    await registry.setEnabled('com.qihe.a', true)
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, boolean>
    expect(persisted['com.qihe.a']).toBe(true)
    // 新 registry 实例（模拟重启）读回
    registry = makeRegistry()
    expect(registry.get('com.qihe.a')!.state).toBe('enabled')
  })

  it('broken 非法转移：校验失败不可启用；熔断原因可重置（重试语义）', async () => {
    writePlugin('com.qihe.x', { apiCompat: [2, 3] })
    const registry = makeRegistry()
    await expect(registry.setEnabled('com.qihe.x', true)).rejects.toThrow('校验失败无法启用')
    await expect(registry.setEnabled('com.qihe.x', false)).rejects.toThrow('broken 状态')
    // 熔断 broken：setEnabled(true) 清 failCount 重新启用
    writePlugin('com.qihe.y')
    const registry2 = makeRegistry()
    registry2.recordFail('com.qihe.y')
    registry2.recordFail('com.qihe.y')
    registry2.markBroken('com.qihe.y', '熔断：连续失败 3 次')
    expect(registry2.get('com.qihe.y')!.state).toBe('broken')
    await registry2.setEnabled('com.qihe.y', true)
    expect(registry2.get('com.qihe.y')!.state).toBe('enabled')
    expect(registry2.get('com.qihe.y')!.failCount).toBe(0)
    expect(registry2.get('com.qihe.y')!.brokenReason).toBeUndefined()
  })

  it('resolvePluginText / versionAtLeast 工具', () => {
    expect(resolvePluginText('abc')).toBe('abc')
    expect(resolvePluginText({ default: '默认', en: 'EN' })).toBe('默认')
    expect(versionAtLeast('2.5.0', '2.5.0')).toBe(true)
    expect(versionAtLeast('2.5.0', '2.5.1')).toBe(false)
    expect(versionAtLeast('2.10.0', '2.9.9')).toBe(true)
    expect(versionAtLeast('3.0.0', '2.9.9')).toBe(true)
  })

  it('syncScope 透传：global → PluginInfo.syncScope；缺省不输出（v2.5 增量，PLAN §3.1）', () => {
    writePlugin('com.qihe.scope', { syncScope: 'global' })
    writePlugin('com.qihe.scope2', { syncScope: 'local' })
    writePlugin('com.qihe.scope3')
    const registry = makeRegistry()
    expect(registry.info('com.qihe.scope')!.syncScope).toBe('global')
    expect(registry.info('com.qihe.scope2')!.syncScope).toBe('local')
    expect(registry.info('com.qihe.scope3')!.syncScope).toBeUndefined()
  })

  it('permissions.account 镜像透传（v2.5 增量，PLAN §3.2）', () => {
    writePlugin('com.qihe.acc', { permissions: { account: true, network: ['api.qihe.com'] } })
    const registry = makeRegistry()
    expect(registry.info('com.qihe.acc')!.permissions).toEqual({ account: true, network: ['api.qihe.com'] })
  })
})

// ==================== loader ====================

describe('PluginLoader：惰性加载 / 握手 / 熔断', () => {
  function makeLoader(bus: HostEventBus): { loader: PluginLoader; registry: PluginRegistry } {
    const registry = makeRegistry()
    const loader = new PluginLoader({ registry, root, createHost: makeCreateHost(bus), importer: cjsImporter, log: () => {} })
    return { loader, registry }
  }

  beforeEach(() => {
    g.__pluginAct = 0
    g.__pluginDispose = 0
    g.__pluginEvt = undefined
  })

  it('IPC 首达惰性加载：首次调用才 activate，重复调用不重新加载，计数正确', async () => {
    writePlugin('com.qihe.a')
    const { loader, registry } = makeLoader(new HostEventBus())
    const r1 = await loader.call('com.qihe.a', 'echo', { x: 1 })
    expect(r1).toEqual({ pong: { x: 1 } })
    expect(g.__pluginAct).toBe(1)
    await loader.call('com.qihe.a', 'echo', { y: 2 })
    expect(g.__pluginAct).toBe(1) // 不重复加载
    const info = registry.info('com.qihe.a')!
    expect(info.callCount).toBe(2)
    expect(info.activationMs!).toBeGreaterThanOrEqual(0)
  })

  it('激活握手超时：测试注入短超时并导出默认契约', async () => {
    let resolveGate!: (value: unknown) => void
    g.__pluginActivationStarted = false
    g.__pluginActivationGate = new Promise<unknown>((resolve) => {
      resolveGate = resolve
    })
    writePlugin(
      'com.qihe.timeout',
      {},
      `module.exports = {
  activate: async () => {
    globalThis.__pluginActivationStarted = true
    return await globalThis.__pluginActivationGate
  },
}`,
    )
    const registry = makeRegistry()
    const loader = new PluginLoader({
      registry,
      root,
      createHost: makeCreateHost(new HostEventBus()),
      importer: cjsImporter,
      log: () => {},
      activateTimeoutMs: 10,
    })
    const activation = loader.call('com.qihe.timeout', 'ping', null).catch((err) => err)

    try {
      for (let i = 0; i < 100 && !g.__pluginActivationStarted; i++) await sleep(1)
      expect(g.__pluginActivationStarted).toBe(true)
      const outcome = await Promise.race([activation, sleep(100).then(() => '仍在等待激活')])
      expect(outcome).toMatchObject({ code: 'ACTIVATE_TIMEOUT', name: 'PluginActivateTimeoutError' })
      expect(registry.get('com.qihe.timeout')!.failCount).toBe(1)
      const loaderModule = (await import('../../src/main/plugins/loader')) as unknown as Record<string, unknown>
      expect(loaderModule.DEFAULT_ACTIVATE_TIMEOUT_MS).toBe(15_000)
      expect(typeof loaderModule.PluginActivateTimeoutError).toBe('function')
    } finally {
      resolveGate({ ipc: { ping: async () => 'late' } })
      await activation
      delete g.__pluginActivationStarted
      delete g.__pluginActivationGate
    }
  })

  it('QIHEBOX_PLUGIN_ACTIVATE_TIMEOUT_MS 环境变量覆盖默认超时', async () => {
    let resolveGate!: (value: unknown) => void
    g.__pluginActivationStarted = false
    g.__pluginActivationGate = new Promise<unknown>((resolve) => {
      resolveGate = resolve
    })
    writePlugin(
      'com.qihe.envtimeout',
      {},
      `module.exports = {
  activate: async () => {
    globalThis.__pluginActivationStarted = true
    return await globalThis.__pluginActivationGate
  },
}`,
    )
    const prev = process.env.QIHEBOX_PLUGIN_ACTIVATE_TIMEOUT_MS
    process.env.QIHEBOX_PLUGIN_ACTIVATE_TIMEOUT_MS = '10'
    const registry = makeRegistry()
    try {
      const loader = new PluginLoader({
        registry,
        root,
        createHost: makeCreateHost(new HostEventBus()),
        importer: cjsImporter,
        log: () => {},
      })
      const activation = loader.call('com.qihe.envtimeout', 'ping', null).catch((err) => err)

      for (let i = 0; i < 100 && !g.__pluginActivationStarted; i++) await sleep(1)
      const outcome = await Promise.race([activation, sleep(100).then(() => '仍在等待激活')])
      expect(outcome).toMatchObject({ code: 'ACTIVATE_TIMEOUT' })
      expect(registry.get('com.qihe.envtimeout')!.failCount).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.QIHEBOX_PLUGIN_ACTIVATE_TIMEOUT_MS
      else process.env.QIHEBOX_PLUGIN_ACTIVATE_TIMEOUT_MS = prev
      resolveGate({ ipc: { ping: async () => 'late' } })
      delete g.__pluginActivationStarted
      delete g.__pluginActivationGate
    }
  })

  it('激活超时后迟到 registration 被立即 dispose（防订阅/定时器泄漏）', async () => {
    let resolveGate!: (value: unknown) => void
    g.__pluginActivationStarted = false
    g.__lateDisposeCount = 0
    g.__pluginActivationGate = new Promise<unknown>((resolve) => {
      resolveGate = resolve
    })
    writePlugin(
      'com.qihe.late',
      {},
      `module.exports = {
  activate: async () => {
    globalThis.__pluginActivationStarted = true
    await globalThis.__pluginActivationGate
    return {
      ipc: { ping: async () => 'late' },
      dispose: () => { globalThis.__lateDisposeCount = (globalThis.__lateDisposeCount || 0) + 1 },
    }
  },
}`,
    )
    const registry = makeRegistry()
    const loader = new PluginLoader({
      registry,
      root,
      createHost: makeCreateHost(new HostEventBus()),
      importer: cjsImporter,
      log: () => {},
      activateTimeoutMs: 10,
    })
    const activation = loader.call('com.qihe.late', 'ping', null).catch((err) => err)

    try {
      for (let i = 0; i < 100 && !g.__pluginActivationStarted; i++) await sleep(1)
      const outcome = await Promise.race([activation, sleep(100).then(() => '仍在等待激活')])
      expect(outcome).toMatchObject({ code: 'ACTIVATE_TIMEOUT' })

      // 放行迟到 registration → 应立即被 dispose，不得落地
      resolveGate(undefined)
      for (let i = 0; i < 100 && !g.__lateDisposeCount; i++) await sleep(1)
      expect(g.__lateDisposeCount).toBe(1)

      // 超时已释放实例：再次调用可重新激活成功（新实例不受迟到对象影响）
      await expect(loader.call('com.qihe.late', 'ping', null)).resolves.toBe('late')
    } finally {
      resolveGate(undefined)
      delete g.__pluginActivationStarted
      delete g.__pluginActivationGate
      delete g.__lateDisposeCount
    }
  })

  it('disposeAll 同步释放：调用返回时 registration.dispose 已执行（不延后到微任务）', async () => {
    writePlugin(
      'com.qihe.sync',
      {},
      `module.exports = {
  activate: async () => ({
    ipc: { ping: async () => 'pong' },
    dispose: () => { globalThis.__regDisposeSync = true },
  }),
}`,
    )
    const { loader } = makeLoader(new HostEventBus())
    await loader.call('com.qihe.sync', 'ping', null)
    delete g.__regDisposeSync

    loader.disposeAll()
    expect(g.__regDisposeSync).toBe(true)

    // 同步清理后可正常重新激活
    await expect(loader.call('com.qihe.sync', 'ping', null)).resolves.toBe('pong')
    delete g.__regDisposeSync
  })

  it('熔断走幂等 deactivate：连续失败满阈值时 registration.dispose 与 hostDispose 均执行', async () => {
    writePlugin(
      'com.qihe.brk',
      {},
      `module.exports = {
  activate: async () => ({
    ipc: { boom: async () => { throw new Error('boom') } },
    dispose: () => { globalThis.__brkRegDispose = (globalThis.__brkRegDispose || 0) + 1 },
  }),
}`,
    )
    delete g.__brkRegDispose

    let hostDisposeCount = 0
    const bus = new HostEventBus()
    const baseCreateHost = makeCreateHost(bus)
    const registry = makeRegistry()
    const loader = new PluginLoader({
      registry,
      root,
      createHost: async (id: string, manifest: PluginManifest) => {
        const created = await baseCreateHost(id, manifest)
        return { ...created, dispose: () => { hostDisposeCount += 1; created.dispose() } }
      },
      importer: cjsImporter,
      log: () => {},
    })

    await loader.call('com.qihe.brk', 'boom', null).catch(() => 'fail1')
    await loader.call('com.qihe.brk', 'boom', null).catch(() => 'fail2')
    await loader.call('com.qihe.brk', 'boom', null).catch(() => 'fail3')

    expect(registry.get('com.qihe.brk')!.state).toBe('broken')
    expect(g.__brkRegDispose).toBe(1)
    expect(hostDisposeCount).toBe(1)

    // 幂等：再次 deactivate 不再重复释放
    loader.deactivate('com.qihe.brk')
    expect(g.__brkRegDispose).toBe(1)
    expect(hostDisposeCount).toBe(1)
    delete g.__brkRegDispose
  })

  it('activate 抛错按加载失败处理：本次报错，下次重试；连续 3 次熔断 broken，可手动重置', async () => {
    writePlugin('com.qihe.b', {}, THROW_ACTIVATE_JS)
    const { loader, registry } = makeLoader(new HostEventBus())
    for (let i = 1; i <= BREAK_THRESHOLD; i++) {
      await expect(loader.call('com.qihe.b', 'echo', null)).rejects.toThrow('activate boom')
      if (i < BREAK_THRESHOLD) expect(registry.get('com.qihe.b')!.state).toBe('enabled')
    }
    expect(registry.get('com.qihe.b')!.state).toBe('broken')
    expect(registry.get('com.qihe.b')!.failCount).toBe(3)
    expect(registry.get('com.qihe.b')!.brokenReason).toContain('熔断')
    // 重试 = setEnabled(id, true)（清 failCount 重新启用）→ 再次失败重新计数
    await registry.setEnabled('com.qihe.b', true)
    await expect(loader.call('com.qihe.b', 'echo', null)).rejects.toThrow('activate boom')
    expect(registry.get('com.qihe.b')!.failCount).toBe(1)
  })

  it('停用：registration.dispose + hostDispose；重新启用后再次激活', async () => {
    writePlugin('com.qihe.c')
    const { loader } = makeLoader(new HostEventBus())
    await loader.call('com.qihe.c', 'echo', 1)
    expect(g.__pluginAct).toBe(1)
    loader.deactivate('com.qihe.c')
    expect(g.__pluginDispose).toBe(1)
    await loader.call('com.qihe.c', 'echo', 2)
    expect(g.__pluginAct).toBe(2) // 重新激活
  })

  it('未安装 / 未启用调用报错', async () => {
    writePlugin('com.qihe.a', { enabled: false })
    const { loader } = makeLoader(new HostEventBus())
    await expect(loader.call('com.nope', 'x', null)).rejects.toThrow('插件未安装')
    await expect(loader.call('com.qihe.a', 'x', null)).rejects.toThrow('插件未启用')
  })

  it('onEvent 触发惰性激活（activation 声明 onEvent:<ipcPrefix>:<channel> 匹配才激活）', async () => {
    writePlugin('com.qihe.d', { activation: ['onEvent:d:change'] })
    const { loader } = makeLoader(new HostEventBus())
    expect(g.__pluginAct).toBe(0)
    loader.onHostEvent('change')
    await sleep(30)
    expect(g.__pluginAct).toBe(1)
    loader.onHostEvent('other') // 不匹配 → 不触发新激活
    await sleep(10)
    expect(g.__pluginAct).toBe(1)
  })

  it('host.events.on 订阅宿主事件；停用后订阅解除（无泄漏）', async () => {
    writePlugin('com.qihe.e', {}, SUBSCRIBE_JS)
    const bus = new HostEventBus()
    const { loader } = makeLoader(bus)
    await loader.call('com.qihe.e', 'ping', null) // 激活 → 订阅
    bus.emitHost('workspaceChanged', { a: 1 })
    expect(g.__pluginEvt).toEqual({ a: 1 })
    loader.deactivate('com.qihe.e') // 停用 → hostDispose 解订阅
    bus.emitHost('workspaceChanged', { b: 2 })
    expect(g.__pluginEvt).toEqual({ a: 1 }) // 不再收到
  })

  it('activate 返回非 PluginRegistration → 报错并计数失败', async () => {
    writePlugin('com.qihe.f', {}, 'module.exports = { activate: async () => 42 }')
    const { loader, registry } = makeLoader(new HostEventBus())
    await expect(loader.call('com.qihe.f', 'x', null)).rejects.toThrow('PluginRegistration')
    expect(registry.get('com.qihe.f')!.failCount).toBe(1)
  })

  it('带 code 的业务错误不计数熔断（v2.5 增量，PLAN §3.3 r2-性能P1-2）', async () => {
    writePlugin('com.qihe.g', {}, BUSINESS_ERROR_JS)
    const { loader, registry } = makeLoader(new HostEventBus())
    for (let i = 0; i < BREAK_THRESHOLD + 1; i++) {
      await expect(loader.call('com.qihe.g', 'boom', null)).rejects.toThrow('business fail')
    }
    // 超过阈值次数仍不熔断、failCount 保持 0（业务错误只影响本次调用）
    expect(registry.get('com.qihe.g')!.state).toBe('enabled')
    expect(registry.get('com.qihe.g')!.failCount).toBe(0)
    expect(registry.get('com.qihe.g')!.brokenReason).toBeUndefined()
  })

  it('原生 Node 错误（ENOENT 带 code 但非业务码）计入熔断——3 次 broken（P1-A1）', async () => {
    writePlugin('com.qihe.node', {}, NODE_ERROR_JS)
    const { loader, registry } = makeLoader(new HostEventBus())
    for (let i = 1; i <= BREAK_THRESHOLD; i++) {
      await expect(loader.call('com.qihe.node', 'boom', null)).rejects.toThrow('ENOENT')
      if (i < BREAK_THRESHOLD) expect(registry.get('com.qihe.node')!.state).toBe('enabled')
    }
    expect(registry.get('com.qihe.node')!.state).toBe('broken')
    expect(registry.get('com.qihe.node')!.failCount).toBe(3)
    expect(registry.get('com.qihe.node')!.brokenReason).toContain('熔断')
  })

  it('业务错误码白名单（INVALID_NAME）不熔断——超阈值仍 enabled、failCount 0（P1-A1）', async () => {
    writePlugin(
      'com.qihe.biz',
      {},
      `module.exports = {
  activate: async () => ({
    ipc: { boom: async () => { const e = new Error('invalid name'); e.code = 'INVALID_NAME'; throw e } },
  }),
}`,
    )
    const { loader, registry } = makeLoader(new HostEventBus())
    for (let i = 0; i < BREAK_THRESHOLD + 1; i++) {
      await expect(loader.call('com.qihe.biz', 'boom', null)).rejects.toThrow('invalid name')
    }
    expect(registry.get('com.qihe.biz')!.state).toBe('enabled')
    expect(registry.get('com.qihe.biz')!.failCount).toBe(0)
  })

  it('激活期间停用 → 宿主 dispose + registration.dispose 均执行、无孤儿实例（P1-A2）', async () => {
    let resolveGate!: (v: unknown) => void
    g.__activateGate = new Promise((r) => {
      resolveGate = r
    })
    g.__activateStarted = false
    g.__pluginDispose = 0
    writePlugin(
      'com.qihe.race',
      {},
      `module.exports = {
  activate: async () => { globalThis.__activateStarted = true; return await globalThis.__activateGate },
}`,
    )
    const bus = new HostEventBus()
    const registry = makeRegistry()
    let hostDisposed = 0
    const baseCreateHost = makeCreateHost(bus)
    const loader = new PluginLoader({
      registry,
      root,
      createHost: async (id, manifest) => {
        const inst = await baseCreateHost(id, manifest)
        const orig = inst.dispose.bind(inst)
        inst.dispose = () => {
          hostDisposed++
          orig()
        }
        return inst
      },
      importer: cjsImporter,
      log: () => {},
    })
    const p = loader.call('com.qihe.race', 'ping', null)
    // 等待 activate 进入挂起（createHost + activate 已启动）
    for (let i = 0; i < 200 && !g.__activateStarted; i++) await sleep(5)
    expect(g.__activateStarted).toBe(true)
    // 激活挂起期间停用 → 打取消标记
    loader.deactivate('com.qihe.race')
    // 放行 activate 返回 registration
    resolveGate({ ipc: { ping: async () => 'pong' }, dispose: () => { g.__pluginDispose = ((g.__pluginDispose as number) || 0) + 1 } })
    await expect(p).rejects.toThrow('激活中止')
    expect(g.__pluginDispose).toBe(1) // registration.dispose 被调用
    expect(hostDisposed).toBe(1) // 宿主 dispose 被调用（无孤儿实例）
    // 取消不计熔断（非插件失败）
    expect(registry.get('com.qihe.race')!.failCount).toBe(0)
  })
})

// ==================== P1-A4：importComplete 宿主事件接线 ====================

describe('importComplete 宿主事件接线（P1-A4）', () => {
  it('HostEventBus 投递 importComplete → 订阅回调收到（白名单通道）', () => {
    const bus = new HostEventBus()
    const got: unknown[] = []
    bus.pluginOn('importComplete', (d) => got.push(d))
    bus.emitHost('importComplete', { success: true, count: 1, cancelled: false })
    expect(got).toEqual([{ success: true, count: 1, cancelled: false }])
    expect((HOST_EVENT_WHITELIST as readonly string[]).includes('importComplete')).toBe(true)
  })

  // 装配层（src/main/index.ts + src/main/ipc.ts）import electron，无法 node 直测——采用源包含断言
  // （与 sideload.gate 的 DEV_MODE_REQUIRED 断言同口径）：files 导入完成处经 onImportComplete 钩子
  // 回调投递宿主事件 importComplete，删除接线即红。
  it('装配层接线：files 导入完成经 onImportComplete 钩子投递宿主事件（源包含断言）', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const ipcSrc = fs.readFileSync(path.join(repoRoot, 'src/main/ipc.ts'), 'utf-8')
    const indexSrc = fs.readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf-8')
    expect(ipcSrc).toContain('onImportComplete')
    expect(indexSrc).toContain("emitHostEvent('importComplete'")
  })
})

// ==================== installer ====================

describe('PluginInstaller：.qbox 侧载安装 / 卸载', () => {
  function makeInstaller(): { installer: PluginInstaller; registry: PluginRegistry } {
    const registry = makeRegistry()
    return { installer: new PluginInstaller({ root, registry, log: () => {} }), registry }
  }

  const OK_MAIN = 'module.exports = { activate: async () => ({ ipc: { ping: async () => "pong" } }) }'
  const RENDERER_MAIN = 'export default function Main() { return null }'

  /** 组装 .qbox（manifest.json 平铺 + main/ + renderer/ 目录） */
  async function buildQbox(
    qboxPath: string,
    manifest: Record<string, unknown> | null,
    mainJs = OK_MAIN,
    renderer?: Record<string, string>,
  ): Promise<void> {
    const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'qbox-staging-'))
    const sources: string[] = []
    if (manifest) {
      const mPath = path.join(staging, 'manifest.json')
      await fsp.writeFile(mPath, JSON.stringify(manifest))
      sources.push(mPath)
    }
    const mainDir = path.join(staging, 'main')
    await fsp.mkdir(mainDir, { recursive: true })
    await fsp.writeFile(path.join(mainDir, 'index.js'), mainJs)
    sources.push(mainDir)
    const rendererRoot = path.join(staging, 'renderer')
    for (const [rel, content] of Object.entries(renderer ?? {})) {
      const p = path.join(rendererRoot, rel)
      await fsp.mkdir(path.dirname(p), { recursive: true })
      await fsp.writeFile(p, content)
    }
    if (renderer) {
      await fsp.mkdir(rendererRoot, { recursive: true })
      sources.push(rendererRoot)
    }
    await compressToZip(sources, qboxPath)
    await fsp.rm(staging, { recursive: true, force: true })
  }

  it('合法包安装：Schema+SHA-256、pkg/ 落盘、.qbox.sha256 防篡改记录、登记启用', async () => {
    const qbox = path.join(root, 'com.qihe.hello.qbox')
    await buildQbox(
      qbox,
      manifestFor('com.qihe.hello', {
        kind: ['ipc', 'pages', 'commands'],
        pages: [{ path: '/plugin/hello', label: '示例', icon: 'i', group: 'g', component: 'renderer/pages/Main.js' }],
        commands: [{ id: 'ping', label: '示例命令', scope: 'file' }],
      }),
      OK_MAIN,
      { 'pages/Main.js': RENDERER_MAIN },
    )
    const { installer, registry } = makeInstaller()
    const r = await installer.install(qbox)
    expect(r.id).toBe('com.qihe.hello')
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.sha256).toBe(await sha256OfFile(qbox)) // 独立重算比对
    const pkg = path.join(root, 'com.qihe.hello', 'pkg')
    expect(fs.existsSync(path.join(pkg, 'main', 'index.js'))).toBe(true)
    expect(fs.existsSync(path.join(pkg, 'renderer', 'pages', 'Main.js'))).toBe(true)
    expect(fs.readFileSync(path.join(root, 'com.qihe.hello', '.qbox.sha256'), 'utf-8')).toBe(r.sha256)
    const info = registry.info('com.qihe.hello')
    expect(info?.state).toBe('enabled')
    expect(info?.installedAt).toBeTruthy()
  })

  it('缺 manifest.json → 拒绝且临时目录清理（无 .tmp-install-* 残留）', async () => {
    const qbox = path.join(root, 'bad.qbox')
    await buildQbox(qbox, null)
    const { installer, registry } = makeInstaller()
    await expect(installer.install(qbox)).rejects.toThrow('缺少 manifest.json')
    expect(fs.readdirSync(root).filter((n) => n.startsWith('.tmp-install-'))).toEqual([])
    expect(registry.list()).toHaveLength(0)
  })

  it('清单 Schema 校验失败（apiCompat 不相交）→ 拒绝', async () => {
    const qbox = path.join(root, 'bad2.qbox')
    await buildQbox(qbox, manifestFor('com.qihe.bad', { apiCompat: [2, 3] }))
    const { installer } = makeInstaller()
    await expect(installer.install(qbox)).rejects.toThrow('apiCompat')
  })

  it('zip-slip：../evil.txt 条目被跳过，不逃逸到包外', async () => {
    const qbox = path.join(root, 'evil.qbox')
    const evil = buildStoreZip([
      { name: Buffer.from('../evil.txt'), data: Buffer.from('escape') },
      { name: Buffer.from('main/index.js'), data: Buffer.from(OK_MAIN) },
      { name: Buffer.from('manifest.json'), data: Buffer.from(JSON.stringify(manifestFor('com.qihe.evil'))) },
    ])
    await fsp.writeFile(qbox, evil)
    const { installer } = makeInstaller()
    await installer.install(qbox)
    // 恶意条目被跳过：不落盘（包内 / 包外均无）
    expect(fs.existsSync(path.join(root, 'com.qihe.evil', 'pkg', 'evil.txt'))).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(root), 'evil.txt'))).toBe(false)
  })

  it('覆盖安装（方案 A）：同 id 重装成功、pkg 替换、state 保留、replaced=true', async () => {
    const qbox = path.join(root, 'com.qihe.dup.qbox')
    await buildQbox(qbox, manifestFor('com.qihe.dup'))
    const { installer } = makeInstaller()
    const first = await installer.install(qbox)
    expect(first.replaced).toBeUndefined() // 首次安装非覆盖
    // 插件业务状态（state/ 与 pkg/ 分离；覆盖安装不得清空）
    const stateDir = path.join(root, 'com.qihe.dup', 'state')
    await fsp.mkdir(stateDir, { recursive: true })
    await fsp.writeFile(path.join(stateDir, 'msg.1.json'), JSON.stringify({ id: 1 }))
    // 第二次安装同 id → 覆盖成功，state 保留
    const second = await installer.install(qbox)
    expect(second.id).toBe('com.qihe.dup')
    expect(second.replaced).toBe(true)
    expect(fs.existsSync(path.join(stateDir, 'msg.1.json')), 'state/ 文件应保留').toBe(true)
    expect(fs.readFileSync(path.join(stateDir, 'msg.1.json'), 'utf-8')).toBe(JSON.stringify({ id: 1 }))
    // pkg/ 为新包（main 入口存在）
    expect(fs.existsSync(path.join(root, 'com.qihe.dup', 'pkg', 'main', 'index.js'))).toBe(true)
    // 无备份残留
    expect(fs.readdirSync(root).filter((n) => n.startsWith('.pkg-old-'))).toEqual([])
  })

  it('覆盖安装失败回滚：新包登记 broken → 恢复旧 pkg、state 保留', async () => {
    // 先写入占位插件（合法 id 且目录名排序在前 → 先扫描占住覆盖包要用的 ipcPrefix → 全局冲突）
    writePlugin('com.qihe.aaa', { ipcPrefix: 'shared-dup2' })
    const firstQbox = path.join(root, 'com.qihe.dup2.qbox')
    await buildQbox(firstQbox, manifestFor('com.qihe.dup2'))
    const { installer, registry } = makeInstaller()
    await installer.install(firstQbox)
    const stateDir = path.join(root, 'com.qihe.dup2', 'state')
    await fsp.mkdir(stateDir, { recursive: true })
    await fsp.writeFile(path.join(stateDir, 'k.json'), JSON.stringify({ v: 1 }))
    // 覆盖包带全局冲突（ipcPrefix 已被 com.qihe.aaa 占用）→ 覆盖被拒并回滚旧 pkg
    const badQbox = path.join(root, 'com.qihe.dup2b.qbox')
    await buildQbox(badQbox, manifestFor('com.qihe.dup2', { ipcPrefix: 'shared-dup2' }))
    await expect(installer.install(badQbox)).rejects.toThrow('覆盖安装被拒绝')
    expect(fs.existsSync(path.join(stateDir, 'k.json')), '回滚后 state 仍保留').toBe(true)
    expect(fs.existsSync(path.join(root, 'com.qihe.dup2', 'pkg', 'main', 'index.js')), '旧 pkg 已恢复').toBe(true)
    expect(registry.get('com.qihe.dup2')?.state).toBe('enabled')
    expect(fs.readdirSync(root).filter((n) => n.startsWith('.pkg-old-'))).toEqual([])
  })

  it('全局冲突回滚：ipcPrefix 被占用 → 拒绝且目录清理、registry 无残留', async () => {
    writePlugin('com.qihe.first', { ipcPrefix: 'shared' })
    makeRegistry() // first 已登记
    const qbox = path.join(root, 'com.qihe.second.qbox')
    await buildQbox(qbox, manifestFor('com.qihe.second', { ipcPrefix: 'shared' }))
    const { installer, registry } = makeInstaller()
    await expect(installer.install(qbox)).rejects.toThrow('ipcPrefix 冲突')
    expect(fs.existsSync(path.join(root, 'com.qihe.second'))).toBe(false) // 回滚清理
    expect(registry.get('com.qihe.second')).toBeUndefined()
  })

  it('卸载：删 pkg/ 与 state/、清启停覆盖、registry 清空', async () => {
    const qbox = path.join(root, 'com.qihe.rm.qbox')
    await buildQbox(qbox, manifestFor('com.qihe.rm'))
    const { installer, registry } = makeInstaller()
    await installer.install(qbox)
    await registry.setEnabled('com.qihe.rm', false) // 写 config 覆盖
    // 插件业务状态（state/ 与 pkg/ 分离）
    await fsp.mkdir(path.join(root, 'com.qihe.rm', 'state'), { recursive: true })
    await fsp.writeFile(path.join(root, 'com.qihe.rm', 'state', 'foo.json'), '{"a":1}')
    await installer.uninstall('com.qihe.rm')
    expect(fs.existsSync(path.join(root, 'com.qihe.rm'))).toBe(false) // pkg+state 一并删除
    expect(registry.get('com.qihe.rm')).toBeUndefined()
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8')) as Record<string, boolean>
    expect(cfg['com.qihe.rm']).toBeUndefined()
    await expect(installer.uninstall('com.qihe.rm')).rejects.toThrow('插件未安装')
  })
})

// ==================== host（storage / events） ====================

describe('createPluginHost：storage 限界与 events 约束', () => {
  function makeDeps(bus: HostEventBus, emitToRenderer: (c: string, d: unknown) => void = () => {}) {
    return {
      pluginId: 'com.qihe.h',
      ipcPrefix: 'hello',
      stateDir: path.join(root, 'com.qihe.h', 'state'),
      bus,
      log: () => {},
      workspace: { currentPath: () => null, list: () => null },
      dialog: { openFile: async () => '', openDirectory: async () => '' },
      notify: () => false,
      emitToRenderer,
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
    }
  }

  it('storage get/set 往返；新实例激活时读入内存缓存（盘读回）', async () => {
    const bus = new HostEventBus()
    const inst = await createPluginHost(makeDeps(bus))
    await inst.host.storage.set('k', { a: 1, b: [1, 2] })
    expect(await inst.host.storage.get('k')).toEqual({ a: 1, b: [1, 2] })
    expect(fs.existsSync(path.join(root, 'com.qihe.h', 'state', 'k.json'))).toBe(true)
    inst.dispose()
    const inst2 = await createPluginHost(makeDeps(bus))
    expect(await inst2.host.storage.get('k')).toEqual({ a: 1, b: [1, 2] })
    expect(await inst2.host.storage.get('missing')).toBeNull()
  })

  it('单 key 超 1MB（注入 100B 限界）→ 拒绝并报错', async () => {
    const inst = await createPluginHost(makeDeps(new HostEventBus()), { maxKeyBytes: 100 })
    await expect(inst.host.storage.set('big', 'x'.repeat(200))).rejects.toThrow('超限')
  })

  it('总容量超 64MB（注入 300B 限界）→ 拒绝并报错', async () => {
    const inst = await createPluginHost(makeDeps(new HostEventBus()), { maxKeyBytes: 200, maxTotalBytes: 300 })
    await inst.host.storage.set('a', 'x'.repeat(80))
    await inst.host.storage.set('b', 'y'.repeat(80))
    await expect(inst.host.storage.set('c', 'z'.repeat(150))).rejects.toThrow('总容量')
  })

  it('storage key 路径逃逸拒绝（../ 绝对/分隔符）', async () => {
    const inst = await createPluginHost(makeDeps(new HostEventBus()))
    for (const bad of ['../evil', 'a/b', '..', '.', 'a\\b']) {
      await expect(inst.host.storage.set(bad, 1)).rejects.toThrow('storage key')
      await expect(inst.host.storage.get(bad)).rejects.toThrow('storage key')
    }
  })

  it('events.on 白名单强校验；events.emit 必须 ipcPrefix 开头（防冒充本体事件）', async () => {
    const sent: Array<[string, unknown]> = []
    const inst = await createPluginHost(makeDeps(new HostEventBus(), (c, d) => sent.push([c, d])))
    for (const ok of HOST_EVENT_WHITELIST) {
      expect(() => inst.host.events.on(ok, () => {})).not.toThrow()
    }
    expect(() => inst.host.events.on('nope', () => {})).toThrow('白名单')
    expect(() => inst.host.events.on('qihebox:event:update:available', () => {})).toThrow('白名单')
    expect(() => inst.host.events.emit('workspaceChanged', 1)).toThrow('ipcPrefix')
    expect(() => inst.host.events.emit('hello:ok', 1)).not.toThrow()
    expect(sent).toEqual([['hello:ok', 1]])
  })

  it('dispose：解除事件订阅、释放状态缓存（无泄漏）', async () => {
    const bus = new HostEventBus()
    const inst = await createPluginHost(makeDeps(bus))
    const got: unknown[] = []
    inst.host.events.on('workspaceChanged', (d) => got.push(d))
    bus.emitHost('workspaceChanged', 1)
    expect(got).toEqual([1])
    await inst.host.storage.set('k', 42)
    inst.dispose()
    bus.emitHost('workspaceChanged', 2)
    expect(got).toEqual([1]) // 订阅已解除
    // 缓存已释放：新 get 从盘读（值仍保留在 state/）
    const inst2 = await createPluginHost(makeDeps(bus))
    expect(await inst2.host.storage.get('k')).toBe(42)
  })
})

// ==================== 工具：手写 store 法 zip（zip-slip 用例） ====================

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

/** 手写 store 法 zip（条目名可传原始字节，用于 zip-slip 场景） */
function buildStoreZip(entries: { name: Buffer; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const u16 = (v: number): Buffer => {
    const b = Buffer.alloc(2)
    b.writeUInt16LE(v)
    return b
  }
  const u32 = (v: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v)
    return b
  }
  for (const e of entries) {
    const size = e.data.length
    const crc = crc32(e.data)
    chunks.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(e.name.length),
        u16(0),
        e.name,
      ]),
    )
    chunks.push(e.data)
    central.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(e.name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        e.name,
      ]),
    )
    offset += 30 + e.name.length + size
  }
  const cd = Buffer.concat(central)
  return Buffer.concat([
    ...chunks,
    cd,
    Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(cd.length),
      u32(offset),
      u16(0),
    ]),
  ])
}

// ==================== v2.5 增量：host.files 能力域（PLAN §3.3） ====================

describe('createPluginHost：host.files 能力域（v2.5 增量，PLAN §3.3）', () => {
  let wsDir = ''

  beforeEach(async () => {
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-host-files-ws-'))
    await fsp.mkdir(path.join(wsDir, '导出'), { recursive: true })
  })

  function makeDeps(overrides: Partial<Parameters<typeof createPluginHost>[0]> = {}) {
    return {
      pluginId: 'com.qihe.files',
      ipcPrefix: 'files',
      stateDir: path.join(root, 'com.qihe.files', 'state'),
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
      ...overrides,
    }
  }

  /** 执行后返回错误 code（成功 → undefined） */
  async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p
      return undefined
    } catch (err) {
      return (err as { code?: string }).code
    }
  }

  it('读：工作区内往返（readText UTF-8 / readBuffer 字节一致）', async () => {
    await fsp.writeFile(path.join(wsDir, 'a.txt'), '你好 hello', 'utf-8')
    await fsp.writeFile(path.join(wsDir, 'bin.dat'), Buffer.from([0, 1, 2, 0xff]))
    const inst = await createPluginHost(makeDeps())
    expect(await inst.host.files.readText('a.txt')).toBe('你好 hello')
    expect(await inst.host.files.readBuffer('bin.dat')).toEqual(Buffer.from([0, 1, 2, 0xff]))
  })

  it("读：'..' 逃逸 / 绝对路径 → OUT_OF_WORKSPACE；非字符串 → INVALID_NAME", async () => {
    const inst = await createPluginHost(makeDeps())
    expect(await codeOf(inst.host.files.readText('../secret.txt'))).toBe('OUT_OF_WORKSPACE')
    expect(await codeOf(inst.host.files.readText('/etc/passwd'))).toBe('OUT_OF_WORKSPACE')
    expect(await codeOf(inst.host.files.readText(42 as unknown as string))).toBe('INVALID_NAME')
  })

  it('读：symlink 逃逸 → OUT_OF_WORKSPACE；不存在 → NOT_FOUND；无工作区 → NO_WORKSPACE', async () => {
    const outside = path.join(path.dirname(wsDir), 'outside-secret.txt')
    await fsp.writeFile(outside, 'secret')
    await fsp.symlink(outside, path.join(wsDir, 'evil-link.txt'))
    const inst = await createPluginHost(makeDeps())
    expect(await codeOf(inst.host.files.readText('evil-link.txt'))).toBe('OUT_OF_WORKSPACE')
    expect(await codeOf(inst.host.files.readText('missing.txt'))).toBe('NOT_FOUND')
    const noWs = await createPluginHost(makeDeps({ workspace: { currentPath: () => null, list: () => null } }))
    expect(await codeOf(noWs.host.files.readText('a.txt'))).toBe('NO_WORKSPACE')
  })

  it('读：超限 → TOO_LARGE（注入缩小限界，先 fstat 后读）', async () => {
    await fsp.writeFile(path.join(wsDir, 'big.txt'), 'x'.repeat(200))
    const inst = await createPluginHost(makeDeps(), { maxReadTextBytes: 100, maxReadBufferBytes: 100 })
    expect(await codeOf(inst.host.files.readText('big.txt'))).toBe('TOO_LARGE')
    expect(await codeOf(inst.host.files.readBuffer('big.txt'))).toBe('TOO_LARGE')
  })

  it('写：平铺命名 导出/<pluginId>_<fileName>（字符串与二进制往返）', async () => {
    const inst = await createPluginHost(makeDeps())
    await inst.host.files.writeExport('report.txt', 'hello-export')
    expect(await fsp.readFile(path.join(wsDir, '导出', 'com.qihe.files_report.txt'), 'utf-8')).toBe('hello-export')
    await inst.host.files.writeExport('bin.dat', new Uint8Array([9, 8, 7]))
    expect(await fsp.readFile(path.join(wsDir, '导出', 'com.qihe.files_bin.dat'))).toEqual(Buffer.from([9, 8, 7]))
  })

  it('写：非法文件名 → INVALID_NAME；超限 → TOO_LARGE（注入限界）；非字符串数据 → INVALID_NAME', async () => {
    const inst = await createPluginHost(makeDeps(), { maxExportBytes: 100 })
    expect(await codeOf(inst.host.files.writeExport('../evil.txt', 'x'))).toBe('INVALID_NAME')
    expect(await codeOf(inst.host.files.writeExport('a/b.txt', 'x'))).toBe('INVALID_NAME')
    expect(await codeOf(inst.host.files.writeExport('con.txt', 'x'))).toBe('INVALID_NAME')
    expect(await codeOf(inst.host.files.writeExport('ok.txt', 'x'.repeat(200)))).toBe('TOO_LARGE')
    expect(await codeOf(inst.host.files.writeExport('ok.txt', 42 as unknown as string))).toBe('INVALID_NAME')
  })

  it('\\0（NUL）路径/文件名 → INVALID_NAME（不抛无 code 裸异常，对齐业务错误码承诺）', async () => {
    const inst = await createPluginHost(makeDeps())
    expect(await codeOf(inst.host.files.readText('a\0b.txt'))).toBe('INVALID_NAME')
    expect(await codeOf(inst.host.files.readBuffer('a\0b.txt'))).toBe('INVALID_NAME')
    expect(await codeOf(inst.host.files.writeExport('a\0b.txt', 'x'))).toBe('INVALID_NAME')
    expect(await codeOf(inst.host.files.readText('\0'))).toBe('INVALID_NAME')
    expect(await codeOf(inst.host.files.writeExport('\0', 'x'))).toBe('INVALID_NAME')
  })
})

// ==================== v2.5 增量：host.account 权限门控 + entitlement 占位（PLAN §3.2/§3.4） ====================

describe('createPluginHost：host.account 权限门控与 entitlement 占位（v2.5 增量）', () => {
  function makeDeps(overrides: Partial<Parameters<typeof createPluginHost>[0]> = {}) {
    return {
      pluginId: 'com.qihe.acc',
      ipcPrefix: 'acc',
      stateDir: path.join(root, 'com.qihe.acc', 'state'),
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
      ...overrides,
    }
  }

  it('permissions.account 声明（accountAccess=true）→ 接通真实账号（getToken/isLoggedIn 往返）', async () => {
    const inst = await createPluginHost(makeDeps({ account: { getToken: () => 'jwt-abc', isLoggedIn: () => true }, accountAccess: true }))
    expect(inst.host.account.getToken()).toBe('jwt-abc')
    expect(inst.host.account.isLoggedIn()).toBe(true)
  })

  it('permissions.account 未声明 → 恒 null / false（空实现注入）', async () => {
    const inst = await createPluginHost(makeDeps({ account: { getToken: () => 'jwt-abc', isLoggedIn: () => true }, accountAccess: false }))
    expect(inst.host.account.getToken()).toBeNull()
    expect(inst.host.account.isLoggedIn()).toBe(false)
  })

  it('未登录：getToken null / isLoggedIn false', async () => {
    const inst = await createPluginHost(makeDeps({ account: { getToken: () => null, isLoggedIn: () => false }, accountAccess: true }))
    expect(inst.host.account.getToken()).toBeNull()
    expect(inst.host.account.isLoggedIn()).toBe(false)
  })

  it('entitlement：恒 free 占位 + 字段形状（红线 4：本体零订阅逻辑）', async () => {
    const inst = await createPluginHost(makeDeps())
    expect(inst.host.entitlement.status()).toEqual({ tier: 'free', expiresAt: null, quota: null })
  })
})

// ==================== v2.5 增量：开发者模式设置（PLAN §3.5） ====================

describe('createSettings：开发者模式读写与持久化（v2.5 增量，PLAN §3.5）', () => {
  let settingsDir = ''

  beforeEach(async () => {
    settingsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-settings-test-'))
  })

  it('默认关（settings.json 缺失）', () => {
    expect(createSettings(settingsDir).getDevMode()).toBe(false)
  })

  it('读写往返 + 落盘 userData/settings.json', async () => {
    const s = createSettings(settingsDir)
    expect(s.getDevMode()).toBe(false)
    await s.setDevMode(true)
    expect(s.getDevMode()).toBe(true)
    const raw = JSON.parse(await fsp.readFile(path.join(settingsDir, 'settings.json'), 'utf-8')) as { devMode?: boolean }
    expect(raw.devMode).toBe(true)
  })

  it('重启持久化：新实例读回（模拟重启，重启后仍关）', async () => {
    await createSettings(settingsDir).setDevMode(true)
    expect(createSettings(settingsDir).getDevMode()).toBe(true)
    await createSettings(settingsDir).setDevMode(false)
    expect(createSettings(settingsDir).getDevMode()).toBe(false)
  })

  it('损坏的 settings.json → 回退默认（不阻塞启动）', async () => {
    await fsp.writeFile(path.join(settingsDir, 'settings.json'), '{ not json')
    expect(createSettings(settingsDir).getDevMode()).toBe(false)
  })
})
