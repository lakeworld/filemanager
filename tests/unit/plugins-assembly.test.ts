/**
 * 插件宿主装配真链单测（v2.6.1）：registerPluginHost 的 workspace / dialog 注入口径。
 *
 * 为什么单独立文件：`host.workspace.currentPath()` 的契约是 `string | null`，而底层
 * `WorkspaceService.currentWorkspacePath()` 在「没开工作区」时返回**空串**；两个值之间的归一
 * 住在装配闭包（`src/main/plugins/ipc.ts` 的 `currentPath: () => box.workspace.currentWorkspacePath()`）。
 * 既有 workspace 测试全部直接用 createPluginHost 注入桩（桩给 null）——装配那行改了也没人守着。
 * 本文件补的正是这一段：mock electron（只保留装配需要的面）+ **真 BoxService**（tmp 家目录、
 * 未打开任何工作区）+ tmp userData + 真插件包（main/index.js），从 `qihebox:plugins:call`
 * 一路打到插件里 `host.workspace.currentPath()` 的返回值。
 *
 * v2.6.1（B8）扩到 dialog：同一条真链打到 `host.dialog.openFiles`——多选原样回、取消回 []、
 * >200 截断（P1 拍板）、失败抛带 code 错误，四种形态都由**装配层真实接线**的
 * `createDialogCapability` 产出（pure 语义另在 plugins-dialog.test.ts 逐条钉）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  userData: '',
  /** dialog 桩的命令：'cancel' | 'throw' | 具体 filePaths（数组）——每次 showOpenDialog 现读 */
  dialogReply: 'cancel' as 'cancel' | 'throw' | string[],
  /** showOpenDialog 收到的实参（断言 properties/title/filters 真递给了 electron 面） */
  dialogCalls: [] as Array<{ win: unknown; opts: { title?: string; properties?: string[]; filters?: unknown } }>,
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
      // v2.6.1（B8）：命令式桩——按 mockState.dialogReply 现读应答（真 electron 面是异步函数，同形）
      showOpenDialog: async (a: unknown, b: unknown): Promise<unknown> => {
        mockState.dialogCalls.push({ win: b === undefined ? null : a, opts: (b ?? a) as { title?: string; properties?: string[]; filters?: unknown } })
        if (mockState.dialogReply === 'throw') throw new Error('GTK: cannot open display')
        if (mockState.dialogReply === 'cancel') return { canceled: true, filePaths: [] }
        return { canceled: false, filePaths: mockState.dialogReply }
      },
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
const { createSettings } = await import('../../src/main/settings')
const { OPEN_FILES_MAX } = await import('../../src/main/plugins/dialog')

/** 真插件包：activate 注册探针 IPC——workspace 现读 + dialog 三档（失败折成 code 回报） */
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
    `module.exports = { activate: async (host) => ({ ipc: {
  probe: async () => ({ path: host.workspace.currentPath() }),
  pickFiles: async (opts) => {
    try { return { ok: true, files: await host.dialog.openFiles(opts) } }
    catch (e) { return { ok: false, code: e && e.code, message: e && e.message } }
  },
} }) }\n`,
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
    mockState.dialogReply = 'cancel'
    mockState.dialogCalls = []
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
      // 真 settings（未写过 → 真默认；defaultPath 指针为空）
      createSettings(path.join(mockState.userData, 'settings')),
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
      createSettings(path.join(mockState.userData, 'settings')),
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

describe('registerPluginHost：dialog.openFiles 注入真链（v2.6.1 B8）', () => {
  afterEach(() => {
    mockState.handlers.clear()
    mockState.userData = ''
    mockState.dialogReply = 'cancel'
    mockState.dialogCalls = []
  })

  /** 起装配 + 插件 + 调一次 pickFiles（各例共用；返回值形状 = 探针插件回包） */
  async function pickFiles(opts: unknown): Promise<{ ok: boolean; files?: string[]; code?: string; message?: string }> {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-plugin-dlg-home-'))
    mockState.userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'qh-plugin-dlg-ud-'))
    await writeProbePlugin('com.qihe.dlgprobe', 'dlgprobe')
    const box = buildTestBox(homeDir)
    const handle = registerPluginHost(
      box,
      { getToken: () => null, isLoggedIn: () => false, getDeviceId: () => null },
      createSettings(path.join(mockState.userData, 'settings')),
      '',
    )
    try {
      const r = (await invoke('qihebox:plugins:call', 'com.qihe.dlgprobe', 'pickFiles', opts)) as {
        success: boolean
        data: { ok: boolean; files?: string[]; code?: string; message?: string }
      }
      expect(r.success).toBe(true)
      return r.data
    } finally {
      await handle.dispose()
    }
  }

  it('多选：选了 3 条原样回 3 条裸路径；properties/filters 真递到 electron 面（不是信封）', async () => {
    mockState.dialogReply = ['/p/a.jpg', '/p/b.png', '/p/c.webp']
    const r = await pickFiles({ title: '选择图片', filters: [{ name: '图片', extensions: ['jpg', 'png', 'webp'] }] })
    expect(r.ok).toBe(true)
    expect(r.files).toEqual(['/p/a.jpg', '/p/b.png', '/p/c.webp'])
    expect(mockState.dialogCalls).toHaveLength(1)
    expect(mockState.dialogCalls[0].opts.properties).toEqual(['openFile', 'multiSelections'])
    expect(mockState.dialogCalls[0].opts.title).toBe('选择图片')
    expect(mockState.dialogCalls[0].opts.filters).toEqual([{ name: '图片', extensions: ['jpg', 'png', 'webp'] }])
  })

  it('取消：回 []（不是空串、不是 undefined、不抛）——插件侧按「取消」静默合法', async () => {
    mockState.dialogReply = 'cancel'
    const r = await pickFiles({})
    expect(r.ok).toBe(true)
    expect(r.files).toEqual([])
  })

  it('>200：装配层截断到 200（P1 拍板上限住宿主侧，插件拿不到第 201 条）', async () => {
    mockState.dialogReply = Array.from({ length: 250 }, (_, i) => `/p/${i}.jpg`)
    const r = await pickFiles({})
    expect(r.ok).toBe(true)
    expect(r.files).toHaveLength(OPEN_FILES_MAX)
    expect(r.files![0]).toBe('/p/0.jpg')
    expect(r.files![OPEN_FILES_MAX - 1]).toBe(`/p/${OPEN_FILES_MAX - 1}.jpg`)
  })

  it('失败：对话框抛错 → 插件拿到带 code 的 DIALOG_FAILED（与取消可分辨；英文原文不外泄）', async () => {
    mockState.dialogReply = 'throw'
    const r = await pickFiles({})
    expect(r.ok).toBe(false)
    expect(r.code).toBe('DIALOG_FAILED')
    expect(r.message).not.toContain('GTK')
  })
})