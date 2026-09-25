/**
 * 插件宿主装配真链单测（v2.6.1）：registerPluginHost 的 workspace 注入口径。
 *
 * 为什么单独立文件：`host.workspace.currentPath()` 的契约是 `string | null`，而底层
 * `WorkspaceService.currentWorkspacePath()` 在「没开工作区」时返回**空串**；两个值之间的归一
 * 住在装配闭包（`src/main/plugins/ipc.ts` 的 `currentPath: () => box.workspace.currentWorkspacePath()`）。
 * 既有 workspace 测试全部直接用 createPluginHost 注入桩（桩给 null）——装配那行改了也没人守着。
 * 本文件补的正是这一段：mock electron（只保留装配需要的面）+ **真 BoxService**（tmp 家目录、
 * 未打开任何工作区）+ tmp userData + 真插件包（main/index.js），从 `qihebox:plugins:call`
 * 一路打到插件里 `host.workspace.currentPath()` 的返回值。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  userData: '',
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
    app: {
      getPath: (name: string): string => (name === 'userData' ? mockState.userData : os.tmpdir()),
      getAppPath: (): string => os.tmpdir(),
      getName: (): string => 'qihebox-test',
      getVersion: (): string => '2.6.1-test',
      isPackaged: false,
      on: noop,
      quit: noop,
      hide: noop,
      whenReady: (): Promise<void> => Promise.resolve(),
      setLoginItemSettings: noop,
      getLoginItemSettings: (): Record<string, unknown> => ({}),
    },
    ipcMain: {
      handle: (ch: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
        mockState.handlers.set(ch, fn)
      },
      on: noop,
      removeListener: noop,
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
    safeStorage: { isEncryptionAvailable: (): boolean => false, encryptString: (s: string) => Buffer.from(s) },
  }
})

const { registerPluginHost } = await import('../../src/main/plugins/ipc')
const { buildTestBox } = await import('./helpers')

/** 真插件包：activate 注册一个 IPC，回读 host.workspace.currentPath()（值在调用时现读） */
async function writeProbePlugin(id: string, ipcPrefix: string): Promise<void> {
  const pkg = path.join(mockState.userData, 'plugins', id, 'pkg')
  await fsp.mkdir(path.join(pkg, 'main'), { recursive: true })
  await fsp.writeFile(
    path.join(pkg, 'manifest.json'),
    JSON.stringify({ id, name: '装配真链探针', version: '0.0.1', apiVersion: 1, enabled: true, kind: ['ipc'], ipcPrefix }),
    'utf-8',
  )
  await fsp.writeFile(
    path.join(pkg, 'main', 'index.js'),
    "module.exports = { activate: async (host) => ({ ipc: { probe: async () => ({ path: host.workspace.currentPath() }) } }) }\n",
    'utf-8',
  )
}

/** 调某已注册 handler（首参是假 event，与真实 IPC 调用同形） */
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = mockState.handlers.get(channel)
  if (!fn) throw new Error(`handler 未注册：${channel}（已捕获 ${mockState.handlers.size} 个）`)
  return fn({} as unknown, ...args)
}

describe('registerPluginHost：workspace 注入真链（v2.6.1）', () => {
  afterEach(() => {
    mockState.handlers.clear()
    mockState.userData = ''
  })

  it('无工作区：插件经装配真链拿到的 currentPath 是 null，不是空串', async () => {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-plugin-assembly-home-'))
    mockState.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-plugin-assembly-ud-'))
    await writeProbePlugin('com.qihe.wsprobe', 'wsprobe')

    const box = buildTestBox(homeDir)
    // 底层现实：没开工作区就是空串——这正是装配层要归一的输入（契约承诺 string | null）
    expect(box.workspace.currentWorkspacePath()).toBe('')

    const handle = registerPluginHost(
      box,
      { getToken: () => null, isLoggedIn: () => false, getDeviceId: () => null },
      { getDevMode: () => false, getAll: () => ({}) },
      '',
    )
    try {
      const r = (await invoke('qihebox:plugins:call', 'com.qihe.wsprobe', 'probe', {})) as {
        success: boolean
        data: { path: string | null }
      }
      expect(r.success).toBe(true)
      expect(r.data).toEqual({ path: null })
    } finally {
      await handle.dispose()
    }
  })

  it('有工作区：同一条真链原样返回工作区路径（归一不伤真值）', async () => {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-plugin-assembly-home-'))
    mockState.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-plugin-assembly-ud-'))
    await writeProbePlugin('com.qihe.wsprobe', 'wsprobe')

    const box = buildTestBox(homeDir)
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-plugin-assembly-ws-'))
    await box.workspace.create(wsDir)

    const handle = registerPluginHost(
      box,
      { getToken: () => null, isLoggedIn: () => false, getDeviceId: () => null },
      { getDevMode: () => false, getAll: () => ({}) },
      '',
    )
    try {
      const r = (await invoke('qihebox:plugins:call', 'com.qihe.wsprobe', 'probe', {})) as {
        success: boolean
        data: { path: string | null }
      }
      expect(r.success).toBe(true)
      expect(r.data.path).toBe(box.workspace.currentWorkspacePath())
      expect(r.data.path).not.toBeNull()
    } finally {
      await handle.dispose()
    }
  })
})