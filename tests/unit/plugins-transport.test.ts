/**
 * transport 解耦契约测试（v2.5 打磨轮 T5 / PLAN-v2.5-polish.md §四）。
 *
 * 守护承诺（docs/PLUGIN.md §十）：插件协议 v1 的 transport 仅有 'inproc'（进程内），
 * 但协议语义应与传输层解耦——未来 'process'（独立进程）/ 'http'（loopback 桥接）下
 * `activate(host)` / `PluginRegistration` 语义不变，仅传输层变化。
 *
 * 三个视角（对应 PLAN §四 T5 原要求「同一 activate/PluginRegistration 经模拟 transport
 * 往返语义等价」）：
 *
 * 1. 序列化往返保真——为什么这样测：
 *    PluginRegistration 拆成两半：可跨进程序列化的「数据面」（ipc action 键名 /
 *    commands id 键名 / pages 元信息）与进程内「函数绑定」（ipc handler / commands
 *    handler / dispose）。模拟传输层对数据面做 JSON 序列化往返（进程间真实原语是
 *    structured clone，JSON 模拟其数据子集），再把函数按键重绑定。断言往返后各字段
 *    语义保留（ipc 键集、pages 元信息、commands 键集、dispose 可调用）——这直接回答
 *    「传输可替换」：同一 registration 换个传输层，数据不丢、能力键集不变。
 *
 * 2. 函数传输语义边界——为什么这样测：
 *    JSON 会静默丢弃函数、structured clone 会抛 DataCloneError。二者共同固化一个
 *    诚实边界：当前契约里 registration 直接携带函数（loader.assertRegistration 校验
 *    的正是「ipc/commands 值为函数」），未来 process/http transport 落地时函数不能
 *    直接过传输层，必须 RPC 包装（宿主侧代理 → 插件侧真实函数）。这条测试把这个
 *    「协议预留点」钉死，防止有人误以为函数可以直接跨进程。
 *
 * 3. 激活流程传输无关性——为什么这样测：
 *    activate(host) 的入口签名（恰好一个 host 参数）与 host 能力白名单（方法集合）
 *    是「能力名 + 签名」的纯数据描述，不含任何传输特定项（socket / 进程句柄 /
 *    postMessage）。types 面（apiSurface 提取 PluginHost 顶层成员）与运行时面
 *    （loader 注入的 host 对象自有键）必须同等于 §5.1 手写白名单——无论 transport
 *    取何值，插件拿到的 host 面清单不变。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { PluginHost, PluginRegistration } from '../../src/plugins/types'
import { PluginLoader } from '../../src/main/plugins/loader'
import { PluginRegistry, PKG_DIR, MAIN_ENTRY } from '../../src/main/plugins/registry'
import { createPluginHost, HostEventBus } from '../../src/main/plugins/host'
import { extractApiSurface } from './helpers/apiSurface'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const PUBLIC_PLUGIN_MD = path.join(repoRoot, 'docs/PLUGIN.md')

/**
 * §5.1 PluginHost 顶层能力白名单（手写权威清单，与 docs/PLUGIN.md §5.1 逐项一致，已排序）。
 * 传输无关：inproc / process / http 下 activate(host) 注入的 host 能力面恒为此集合——
 * 白名单只描述「能力名 + 签名」，不含任何传输特定项。
 */
const HOST_WHITELIST = [
  'account',
  'apiVersion',
  'dialog',
  'entitlement',
  'events',
  'files',
  'log',
  'notify',
  'storage',
  'workspace',
]

/** 从 API 面 types 节提取 PluginHost 接口顶层成员名（仅第一层，嵌套成员如 storage.get 不计）。 */
function extractTopLevelHostMembers(types: string[]): string[] {
  const names = new Set<string>()
  for (const line of types) {
    const m = /^PluginHost\.([A-Za-z0-9_]+)[(:]/.exec(line)
    if (m) names.add(m[1])
  }
  return [...names].sort()
}

/**
 * 模拟传输层（process/http 未来形态）。
 * - 数据面（wire）：可跨进程序列化——ipc action 键名 / commands id 键名 / pages 元信息，
 *   做 JSON 序列化往返（structured clone 的数据子集）；
 * - 函数绑定（local）：进程内函数（ipc handler / commands handler / dispose），
 *   数据面往返后按键重绑定。真实 process transport 下这半会换成 RPC 代理（见函数边界测试）。
 */
function simulatedTransport(reg: PluginRegistration): PluginRegistration {
  const wire = {
    ipcActions: reg.ipc ? Object.keys(reg.ipc).sort() : undefined,
    commandIds: reg.commands ? Object.keys(reg.commands).sort() : undefined,
    pages: reg.pages,
  }
  const roundTripped = JSON.parse(JSON.stringify(wire)) as typeof wire
  return {
    ipc: roundTripped.ipcActions
      ? Object.fromEntries(roundTripped.ipcActions.map((k) => [k, reg.ipc![k]]))
      : undefined,
    pages: roundTripped.pages,
    commands: roundTripped.commandIds
      ? Object.fromEntries(roundTripped.commandIds.map((k) => [k, reg.commands![k]]))
      : undefined,
    dispose: reg.dispose,
  }
}

// ==================== 1. 序列化往返保真 ====================

describe('PluginRegistration 序列化往返保真（transport 可替换）', () => {
  it('典型 registration（ipc+pages+commands+dispose）经模拟 transport 往返后各字段语义等价', async () => {
    const disposals: string[] = []
    const calls: Array<[string, unknown]> = []
    const reg: PluginRegistration = {
      ipc: {
        echo: async (args: unknown) => {
          calls.push(['echo', args])
          return { pong: args }
        },
        sum: async (args: unknown) => {
          const ns = args as number[]
          calls.push(['sum', ns])
          return ns.reduce((a, b) => a + b, 0)
        },
      },
      pages: [
        {
          path: '/plugin/transport',
          label: { default: '传输', en: 'Transport' }, // PluginText map 形态须原样保留
          icon: 'swap',
          group: '示例',
          component: 'renderer/pages/Main.js',
        },
      ],
      commands: {
        copy: async (ctx) => {
          calls.push(['copy', ctx.filePaths])
        },
      },
      dispose: () => {
        disposals.push('disposed')
      },
    }

    const rt = simulatedTransport(reg)

    // ipc 键集保真（往返不增不减、不重排）
    expect(Object.keys(rt.ipc ?? {}).sort()).toEqual(['echo', 'sum'])
    // pages 元信息保真（含 PluginText map 形态，深比较）
    expect(rt.pages).toEqual(reg.pages)
    // commands 键集保真
    expect(Object.keys(rt.commands ?? {}).sort()).toEqual(['copy'])
    // dispose 可调用
    rt.dispose!()
    expect(disposals).toEqual(['disposed'])
    // 往返后的 handler 语义不变：仍可调用、返回值一致、commands 收到 ctx.filePaths
    await expect(rt.ipc!.echo({ x: 1 })).resolves.toEqual({ pong: { x: 1 } })
    await expect(rt.ipc!.sum([1, 2, 3])).resolves.toBe(6)
    await rt.commands!.copy({ filePaths: ['a.png', 'b.jpg'], host: {} as PluginHost })
    expect(calls).toEqual([
      ['echo', { x: 1 }],
      ['sum', [1, 2, 3]],
      ['copy', ['a.png', 'b.jpg']],
    ])
  })

  it('最小 registration（仅 ipc+dispose）往返：可选字段缺省保真（不凭空造 pages/commands）', () => {
    const reg: PluginRegistration = {
      ipc: { ping: async () => 'pong' },
      dispose: () => {},
    }
    const rt = simulatedTransport(reg)
    expect(Object.keys(rt.ipc ?? {})).toEqual(['ping'])
    expect(rt.pages).toBeUndefined()
    expect(rt.commands).toBeUndefined()
    expect(typeof rt.dispose).toBe('function')
  })
})

// ==================== 2. 函数传输语义边界 ====================

describe('函数传输语义边界（未来 process transport 下函数须 RPC 化）', () => {
  const reg: PluginRegistration = {
    ipc: { echo: async (args: unknown) => ({ pong: args }) },
    commands: { copy: async (ctx) => { void ctx.filePaths } },
    dispose: () => {},
  }

  it('JSON 序列化丢弃函数：ipc/commands 的 handler 值被丢、dispose 键被整体丢弃（数据面无法携带函数）', () => {
    const wire = JSON.parse(JSON.stringify(reg)) as Record<string, unknown>
    // JSON.stringify 丢弃函数值：ipc 变空对象（echo 值被丢）、commands 变空对象、dispose 键消失
    expect(wire.ipc).toEqual({})
    expect(wire.commands).toEqual({})
    expect('dispose' in wire).toBe(false)
  })

  it('结构化克隆（structuredClone，进程间传输实际原语）遇函数抛 DataCloneError', () => {
    expect(() => structuredClone(reg)).toThrow()
  })

  it('契约文档 §十 固化「语义不变、仅传输层变化」预留点（函数须 RPC 化的语义边界锚定）', () => {
    const md = fs.readFileSync(PUBLIC_PLUGIN_MD, 'utf-8')
    // §十：process/http 两条路径下 activate/PluginRegistration 语义不变，仅传输层变化
    expect(md).toContain('语义不变，仅传输层变化')
    expect(md).toContain("transport: 'process'")
    expect(md).toContain("transport: 'http'")
    // §六 诚实说明：插件代码实质隔离依赖 v2.7 transport='process'（函数跨进程须 RPC 化的实现前提）
    expect(md).toContain("v2.7 `transport='process'`")
  })
})

// ==================== 3. 激活流程传输无关性 ====================

const cjsRequire = createRequire(import.meta.url)

/** 写一个临时插件包并用真实 loader 加载（activate 记录入口签名与注入 host 能力面）。 */
async function makeLoader(mainJs: string): Promise<{ loader: PluginLoader }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-transport-'))
  const id = 'com.qihe.transport'
  const pkg = path.join(root, id, PKG_DIR)
  fs.mkdirSync(path.join(pkg, 'main'), { recursive: true })
  fs.writeFileSync(
    path.join(pkg, 'manifest.json'),
    JSON.stringify({ id, name: 'x', version: '0.1.0', apiVersion: 1, enabled: true, kind: ['ipc'], ipcPrefix: 'transport' }),
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
      }),
    importer: (url) => Promise.resolve(cjsRequire(fileURLToPath(url))),
    log: () => {},
  })
  return { loader }
}

describe('激活流程传输无关性（activate 入口签名 + host 能力白名单）', () => {
  it('host 能力白名单（types 面）=== §5.1 手写清单，与 transport 无关', () => {
    expect(extractTopLevelHostMembers(extractApiSurface().types)).toEqual(HOST_WHITELIST)
  })

  it('activate(host) 入口签名：loader 以恰好一个参数调用 activate，注入 host 运行时能力面 === §5.1 白名单', async () => {
    const g = globalThis as Record<string, unknown>
    g.__transportArgCount = -1
    g.__transportHostKeys = []
    const { loader } = await makeLoader(`
      module.exports = {
        activate: async function (host) {
          globalThis.__transportArgCount = arguments.length
          globalThis.__transportHostKeys = Object.keys(host).sort()
          return { ipc: { ping: async () => 'pong' } }
        },
      }
    `)
    await loader.call('com.qihe.transport', 'ping', null)
    expect(g.__transportArgCount).toBe(1) // activate(host) 单参入口签名，与传输层无关
    expect(g.__transportHostKeys).toEqual(HOST_WHITELIST) // 注入能力白名单 = §5.1，与传输层无关
  })
})
