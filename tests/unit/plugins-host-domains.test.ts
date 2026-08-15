/**
 * host customers/share 能力域单测（v2.5.1 A1+A2，PLAN-v2.6-v2.7 §3.1/§3.2）
 * 覆盖：
 * - PERMISSION_DENIED 门控（permissions.customers/share !== true → 全部方法抛业务错误）
 * - 错误码透传（NOT_FOUND / STALE / FIELD_DENIED 映射，不计熔断——带 code 属性）
 * - customer 域：list/get/writeErpExt/syncProfile/relation.link/unlink 经适配器委托
 * - share 域：listProductSets/listCustomers/listTree/getMetadata/readFileChunk/writePulledFile/ensure 系列/mergePulledMetadata
 * - 事件白名单 +3（customerCreated/customerUpdated/fileArchived）可订阅；非白名单仍拒绝
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { createPluginHost, HostEventBus, HOST_EVENT_WHITELIST, mapCoreError } from '../../src/main/plugins/host'
import { buildTestBox } from './helpers'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihe-host-domains-'))
}

interface AdapterSet {
  customers?: Record<string, unknown>
  customersAccess?: boolean
  share?: Record<string, unknown>
  shareAccess?: boolean
}

async function makeDeps(overrides: AdapterSet = {}) {
  const home = await tmp()
  const wsDir = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(wsDir)
  return {
    deps: {
      pluginId: 'com.qihe.domains',
      ipcPrefix: 'domains',
      stateDir: path.join(home, 'state'),
      bus: new HostEventBus(),
      log: () => {},
      workspace: { currentPath: () => wsDir, list: () => null },
      dialog: { openFile: async () => '', openDirectory: async () => '' },
      notify: () => false,
      emitToRenderer: () => {},
      account: { getToken: () => null, isLoggedIn: () => false },
      accountAccess: false,
      // A1/A2 适配器注入（host.ts 增列；权限门控与适配器分离，测试可分别控制）
      customers: overrides.customers ?? {
        list: async () => [],
        get: async () => null,
        writeErpExt: async () => {},
        syncProfile: async () => ({ applied: true }),
        relation: { link: async () => {}, unlink: async () => {} },
      },
      customersAccess: overrides.customersAccess ?? true,
      share: overrides.share ?? {
        listProductSets: async () => [],
        listCustomers: async () => [],
        listTree: async () => [],
        getMetadata: async () => ({ tags: [], notes: '' }),
        statFile: async () => ({ size: 0, mtime: '' }),
        readFileChunk: async () => new Uint8Array(0),
        writePulledFile: async () => {},
        ensureProductSet: async () => 'exists' as const,
        ensureCustomer: async () => 'exists' as const,
        mergePulledMetadata: async () => ({ conflicts: [] }),
      },
      shareAccess: overrides.shareAccess ?? true,
    },
    wsDir,
    box,
  }
}

/** 执行后返回错误 code（成功 → undefined）；无 code 的裸异常 → 'NO_CODE' */
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE'
  }
}

describe('mapCoreError（装配层错误码映射，core 裸错误 → 契约 code）', () => {
  it('消息模式 → 错误码映射', () => {
    expect(mapCoreError(new Error('客户不存在'))?.code).toBe('NOT_FOUND')
    expect(mapCoreError(new Error('文件不存在'))?.code).toBe('NOT_FOUND')
    expect(mapCoreError(new Error('未打开工作区'))?.code).toBe('NO_WORKSPACE')
    expect(mapCoreError(new Error('syncProfile 含白名单外字段'))?.code).toBe('FIELD_DENIED')
    expect(mapCoreError(new Error('隐藏目录不可写'))?.code).toBe('HIDDEN')
    expect(mapCoreError(new Error('路径超出工作区'))?.code).toBe('OUT_OF_WORKSPACE')
    expect(mapCoreError(new Error('名称不能为空'))?.code).toBe('INVALID_NAME')
    expect(mapCoreError(new Error('未知错误'))?.code).toBe('IO_ERROR')
  })

  it('已带 code 的错误原样保留（不重映射）', () => {
    const e = new Error('x') as Error & { code: string }
    e.code = 'STALE'
    expect(mapCoreError(e)?.code).toBe('STALE')
  })

  it('非 Error 异常 → IO_ERROR', () => {
    expect(mapCoreError('string-error')?.code).toBe('IO_ERROR')
  })
})

describe('createPluginHost：host.customer 能力域（v2.5.1 A1）', () => {
  type CustomerHost = {
    customer: {
      list(): Promise<unknown>
      get(n: string): Promise<unknown>
      writeErpExt(n: string, e: Record<string, unknown>): Promise<void>
      syncProfile(r: { name: string; updated_at: string }): Promise<{ applied: boolean }>
      relation: { link(c: string, p: string): Promise<void>; unlink(c: string, p: string): Promise<void> }
    }
  }
  it('PERMISSION_DENIED：permissions.customers !== true → 全部方法抛 PERMISSION_DENIED（读方法亦抛）', async () => {
    const { deps } = await makeDeps({ customersAccess: false })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CustomerHost
    const fns: (() => Promise<unknown>)[] = [
      () => h.customer.list(),
      () => h.customer.get('x'),
      () => h.customer.writeErpExt('x', {}),
      () => h.customer.syncProfile({ name: 'x', updated_at: '2026-01-01T00:00:00.000Z' }),
      () => h.customer.relation.link('x', 'y'),
      () => h.customer.relation.unlink('x', 'y'),
    ]
    for (const fn of fns) {
      expect(await codeOf(fn())).toBe('PERMISSION_DENIED')
    }
  })

  it('适配器委托：list/get/writeErpExt/syncProfile/relation 往返（参数原样透传）', async () => {
    const calls: string[] = []
    const { deps } = await makeDeps({
      customers: {
        list: async () => [{ name: '张三' }],
        get: async (name: string) => ({ name }),
        writeErpExt: async (name: string, ext: unknown) => {
          calls.push(`writeErpExt:${name}:${JSON.stringify(ext)}`)
        },
        syncProfile: async (req: unknown) => {
          calls.push(`syncProfile:${JSON.stringify(req)}`)
          return { applied: true }
        },
        relation: {
          link: async (c: string, p: string) => {
            calls.push(`link:${c}:${p}`)
          },
          unlink: async (c: string, p: string) => {
            calls.push(`unlink:${c}:${p}`)
          },
        },
      },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as {
      customer: {
        list(): Promise<unknown>
        get(n: string): Promise<unknown>
        writeErpExt(n: string, e: unknown): Promise<void>
        syncProfile(r: unknown): Promise<{ applied: boolean }>
        relation: { link(c: string, p: string): Promise<void>; unlink(c: string, p: string): Promise<void> }
      }
    }
    expect(await h.customer.list()).toEqual([{ name: '张三' }])
    expect(await h.customer.get('李四')).toEqual({ name: '李四' })
    await h.customer.writeErpExt('张三', { code: 'C1' })
    await h.customer.syncProfile({ name: '张三', updated_at: '2026-01-01T00:00:00.000Z' })
    await h.customer.relation.link('张三', 'PS1')
    await h.customer.relation.unlink('张三', 'PS1')
    expect(calls).toHaveLength(4)
    expect(calls[0]).toBe('writeErpExt:张三:{"code":"C1"}')
    expect(calls[2]).toBe('link:张三:PS1')
  })

  it('适配器抛错 → 带 code 透传（NOT_FOUND/STALE/FIELD_DENIED 由 core 或适配器抛）', async () => {
    const { deps } = await makeDeps({
      customers: {
        list: async () => [],
        get: async () => {
          const e = new Error('客户不存在') as Error & { code: string }
          e.code = 'NOT_FOUND'
          throw e
        },
        writeErpExt: async () => {
          const e = new Error('stale') as Error & { code: string }
          e.code = 'STALE'
          throw e
        },
        syncProfile: async () => {
          const e = new Error('白名单') as Error & { code: string }
          e.code = 'FIELD_DENIED'
          throw e
        },
        relation: { link: async () => {}, unlink: async () => {} },
      },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as CustomerHost
    expect(await codeOf(h.customer.get('x'))).toBe('NOT_FOUND')
    expect(await codeOf(h.customer.writeErpExt('x', {}))).toBe('STALE')
    expect(await codeOf(h.customer.syncProfile({ name: 'x', updated_at: 'x' }))).toBe('FIELD_DENIED')
  })

  it('事件白名单 +3：customerCreated/customerUpdated/fileArchived 可订阅，非白名单仍拒绝', async () => {
    const { deps } = await makeDeps()
    const inst = await createPluginHost(deps as never)
    for (const ch of ['customerCreated', 'customerUpdated', 'fileArchived']) {
      expect(HOST_EVENT_WHITELIST).toContain(ch)
      expect(() => inst.host.events.on(ch, () => {})).not.toThrow()
    }
    expect(() => inst.host.events.on('customerDeleted', () => {})).toThrow('白名单')
  })
})

describe('createPluginHost：host.share 能力域（v2.5.1 A2）', () => {
  type ShareHost = {
    share: {
      listProductSets(): Promise<unknown>
      listCustomers(): Promise<unknown>
      listTree(p?: string): Promise<unknown>
      getMetadata(p: string): Promise<unknown>
      statFile(p: string): Promise<unknown>
      readFileChunk(p: string, o: number, l: number): Promise<unknown>
      writePulledFile(p: string, c: Uint8Array, o: number): Promise<void>
      ensureProductSet(n: string): Promise<unknown>
      ensureCustomer(n: string): Promise<unknown>
      mergePulledMetadata(e: unknown[]): Promise<unknown>
    }
  }
  it('PERMISSION_DENIED：permissions.share !== true → 全部方法抛 PERMISSION_DENIED', async () => {
    const { deps } = await makeDeps({ shareAccess: false })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as ShareHost
    const fns: (() => Promise<unknown>)[] = [
      () => h.share.listProductSets(),
      () => h.share.listCustomers(),
      () => h.share.listTree(),
      () => h.share.getMetadata('x'),
      () => h.share.statFile('x'),
      () => h.share.readFileChunk('x', 0, 1),
      () => h.share.writePulledFile('x', new Uint8Array(1), 0),
      () => h.share.ensureProductSet('x'),
      () => h.share.ensureCustomer('x'),
      () => h.share.mergePulledMetadata([]),
    ]
    for (const fn of fns) {
      expect(await codeOf(fn())).toBe('PERMISSION_DENIED')
    }
  })

  it('适配器委托：share 十方法往返', async () => {
    const { deps } = await makeDeps({
      share: {
        listProductSets: async () => [{ name: 'PS1' }],
        listCustomers: async () => [{ name: '张三' }],
        listTree: async () => [{ name: '产品集', kind: 'dir', size: 0, mtime: '' }],
        getMetadata: async () => ({ tags: ['t'], notes: 'n' }),
        statFile: async () => ({ size: 3, mtime: '2026-01-01T00:00:00.000Z' }),
        readFileChunk: async () => new Uint8Array([1, 2]),
        writePulledFile: async () => {},
        ensureProductSet: async () => 'created' as const,
        ensureCustomer: async () => 'created' as const,
        mergePulledMetadata: async () => ({ conflicts: ['a'] }),
      },
    })
    const inst = await createPluginHost(deps as never)
    const h = inst.host as unknown as {
      share: {
        listProductSets(): Promise<unknown>
        listCustomers(): Promise<unknown>
        listTree(p?: string): Promise<unknown>
        getMetadata(p: string): Promise<unknown>
        statFile(p: string): Promise<unknown>
        readFileChunk(p: string, o: number, l: number): Promise<unknown>
        writePulledFile(p: string, c: Uint8Array, o: number): Promise<void>
        ensureProductSet(n: string): Promise<unknown>
        ensureCustomer(n: string): Promise<unknown>
        mergePulledMetadata(e: unknown[]): Promise<unknown>
      }
    }
    expect(await h.share.listProductSets()).toEqual([{ name: 'PS1' }])
    expect(await h.share.listCustomers()).toEqual([{ name: '张三' }])
    expect(await h.share.listTree('产品集')).toEqual([{ name: '产品集', kind: 'dir', size: 0, mtime: '' }])
    expect(await h.share.getMetadata('产品集/PS1')).toEqual({ tags: ['t'], notes: 'n' })
    expect(await h.share.statFile('x')).toEqual({ size: 3, mtime: '2026-01-01T00:00:00.000Z' })
    expect(await h.share.readFileChunk('x', 0, 2)).toEqual(new Uint8Array([1, 2]))
    await h.share.writePulledFile('产品集/PS1/图包/a.jpg', new Uint8Array([1]), 0)
    expect(await h.share.ensureProductSet('PS2')).toBe('created')
    expect(await h.share.ensureCustomer('李四')).toBe('created')
    expect(await h.share.mergePulledMetadata([{ path: 'a', tags: [], notes: '' }])).toEqual({ conflicts: ['a'] })
  })

  it('真实 core 整链：buildTestBox + ShareViewService 经适配器（writePulledFile 落盘 / merge 两级）', async () => {
    const { deps, wsDir, box } = await makeDeps({
      share: undefined as never, // 占位防类型错误——真实适配器在装配层；此处验证 core 而非薄壳
    })
    // 直接用 core 验证（薄壳是纯透传，见上用例）
    const { ShareViewService } = await import('../../src/main/core/shareView')
    const svc = new ShareViewService(box)
    await box.workspace.productSetCreate({ name: 'PS1', tags: ['ps'], notes: 'ps-local' })
    await svc.writePulledFile('产品集/PS1/图包/a.jpg', new Uint8Array([1, 2, 3]), 0)
    const p = path.join(wsDir, '产品集', 'PS1', '图包', 'a.jpg')
    expect((await fsp.readFile(p)).length).toBe(3)
    const r = await svc.mergePulledMetadata([{ path: '产品集/PS1', tags: ['ps2'], notes: 'ps-remote' }])
    expect(r.conflicts).toContain('产品集/PS1')
    void deps
  })
})
