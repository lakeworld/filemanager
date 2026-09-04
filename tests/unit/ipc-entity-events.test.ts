/**
 * IPC 写路径 → 宿主事件投递行为单测（v2.5.7 补丁：供应商关联镜像漏抄修复的钉）
 *
 * 背景（2026-09-04 真机侧载取证）：业务脉络图谱在「供应商 → 关联产品集」后不刷新。
 * 根因不是装配层逻辑，而是 `qihebox:suppliers:linkRelation` / `unlinkRelation` 两个 handler
 * 未投 `supplierUpdated`——客户侧同名通道投了（v2.5.1 A1），供应商侧 v2.4.9 打磨 M8「镜像客户」
 * 时漏抄了事件投递那一行。图谱因此只能等 TTL/重启才看得到新关联。
 *
 * 手法：vi.mock('electron') 把 ipcMain.handle 换成注册表捕获，其余（BoxService/工作区/档案）
 * 全用真实现 + tmp 目录，断言真实的「成功路径投事件、失败路径不投」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const captured = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}))

vi.mock('electron', () => {
  const noop = (): void => {}
  const Stub = class {
    static getAllWindows(): unknown[] {
      return []
    }
    static getFocusedWindow(): null {
      return null
    }
  }
  return {
    ipcMain: {
      handle: (ch: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
        captured.handlers.set(ch, fn)
      },
      on: noop,
      removeListener: noop,
    },
    app: {
      getPath: (): string => os.tmpdir(),
      getName: (): string => 'qihebox-test',
      getVersion: (): string => '0.0.0',
      isPackaged: false,
      on: noop,
      quit: noop,
      hide: noop,
      whenReady: (): Promise<void> => Promise.resolve(),
      setLoginItemSettings: noop,
      getLoginItemSettings: (): Record<string, unknown> => ({}),
    },
    BrowserWindow: Stub,
    Tray: Stub,
    Notification: Stub,
    Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({ popup: noop }) },
    dialog: {
      showOpenDialog: async (): Promise<unknown> => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async (): Promise<unknown> => ({ canceled: true, filePath: '' }),
      showMessageBox: async (): Promise<unknown> => ({ response: 0 }),
      showErrorBox: noop,
    },
    shell: {
      openPath: async (): Promise<string> => '',
      showItemInFolder: noop,
      openExternal: async (): Promise<void> => {},
    },
    screen: {
      getPrimaryDisplay: (): unknown => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1 }),
      getAllDisplays: (): unknown[] => [],
    },
    powerMonitor: { on: noop, removeAllListeners: noop },
    clipboard: { writeText: noop, clear: noop, readText: (): string => '' },
    nativeImage: { createFromPath: (): unknown => ({ isEmpty: () => true, toPNG: () => Buffer.from('') }) },
    protocol: { handle: noop, registerFileProtocol: noop },
    net: { fetch: async (): Promise<Response> => new Response('{}') },
    globalShortcut: { register: (): boolean => true, unregisterAll: noop },
  }
})

const { registerIpc } = await import('../../src/main/ipc')
const { buildTestBox } = await import('./helpers')
const { AccountService } = await import('../../src/main/account')

/** 与 src/shared/types.ts ApiResult 对齐（success/data/error 三字段） */
interface Res {
  success: boolean
  data: unknown
  error: string | null
}

/** 调某已注册 handler（首参是假 event） */
function invoke(channel: string, ...args: unknown[]): Promise<Res> {
  const fn = captured.handlers.get(channel)
  if (!fn) throw new Error(`handler 未注册：${channel}（已捕获 ${captured.handlers.size} 个）`)
  return fn({} as unknown, ...args) as Promise<Res>
}

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-ipc-events-'))
}

describe('IPC 写路径 → 宿主事件投递', () => {
  // BoxService 公开面巨大，本测只调其中若干方法，宽松类型免掉无意义断言
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let box: any
  let supplierEvents: Array<[string, { name: string; oldName?: string }]>
  let customerEvents: Array<[string, { name: string; oldName?: string }]>

  beforeEach(async () => {
    captured.handlers.clear()
    supplierEvents = []
    customerEvents = []
    box = buildTestBox(await tmp())
    const ws = await tmp()
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.suppliers.create({ name: '甲供应商' })
    await box.clients.create({ name: '甲客户' })
    registerIpc(
      box,
      new AccountService({
        accountFile: path.join(ws, 'account.json'),
        baseUrl: 'http://127.0.0.1:1',
        encrypt: (plain) => plain,
        decrypt: (encoded) => encoded,
        version: () => '0.0.0',
      }),
      {
        isTrayReady: () => false,
        onSupplierEvent: (event, payload) => supplierEvents.push([event, payload]),
        onCustomerEvent: (event, payload) => customerEvents.push([event, payload]),
      },
    )
  })

  it('供应商 linkRelation / unlinkRelation 成功 → 投 supplierUpdated（v2.5.7 补丁：补客户侧对称投递）', async () => {
    const link = await invoke('qihebox:suppliers:linkRelation', '甲供应商', '系列A')
    expect(link.error).toBeNull()
    expect(link.success).toBe(true)
    expect(supplierEvents).toEqual([['supplierUpdated', { name: '甲供应商' }]])

    const unlink = await invoke('qihebox:suppliers:unlinkRelation', '甲供应商', '系列A')
    expect(unlink.success).toBe(true)
    expect(supplierEvents).toEqual([
      ['supplierUpdated', { name: '甲供应商' }],
      ['supplierUpdated', { name: '甲供应商' }],
    ])
  })

  it('客户 linkRelation / unlinkRelation 投 customerUpdated（对照基准，防两域再次不对称）', async () => {
    expect((await invoke('qihebox:clients:linkRelation', '甲客户', '系列A')).success).toBe(true)
    expect((await invoke('qihebox:clients:unlinkRelation', '甲客户', '系列A')).success).toBe(true)
    expect(customerEvents).toEqual([
      ['customerUpdated', { name: '甲客户' }],
      ['customerUpdated', { name: '甲客户' }],
    ])
  })

  it('linkRelation 失败路径不投事件（产品集不存在 / 档案不存在 → success=false 且事件为零）', async () => {
    expect((await invoke('qihebox:suppliers:linkRelation', '甲供应商', '不存在集')).success).toBe(false)
    expect((await invoke('qihebox:suppliers:linkRelation', '没这个供应商', '系列A')).success).toBe(false)
    expect((await invoke('qihebox:clients:linkRelation', '甲客户', '不存在集')).success).toBe(false)
    expect(supplierEvents).toEqual([])
    expect(customerEvents).toEqual([])
  })

  it('供应商 建/改/改名 投递不回归（v2.5.4 C-3 既有行为）', async () => {
    expect((await invoke('qihebox:suppliers:create', { name: '乙供应商' })).success).toBe(true)
    expect((await invoke('qihebox:suppliers:update', { name: '乙供应商', phone: '13800000000' })).success).toBe(true)
    expect((await invoke('qihebox:suppliers:rename', '乙供应商', '丙供应商')).success).toBe(true)
    expect(supplierEvents.map(([e, p]) => [e, p.name])).toEqual([
      ['supplierCreated', '乙供应商'],
      ['supplierUpdated', '乙供应商'],
      ['supplierUpdated', '丙供应商'],
    ])
  })
})
