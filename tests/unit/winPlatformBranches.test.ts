/**
 * Windows 平台分支单测（W0，2026-09-08 Windows 测试约定 Task 1）
 *
 * 钉的是 main 里 `process.platform === 'win32'` 分支的**行为**：调什么外部命令、参数怎么拼、
 * 失败怎么降级。这些分支过去在 Linux 上永不执行（CI/e2e 全在 Linux），属零覆盖区。
 *
 * 手法：stub `process.platform` + mock `electron` / `node:child_process`，
 * 断言「命令名 + 参数 + 转义 + 降级路径」，不真起进程。
 * 真实 Windows 运行时行为（PowerShell 是否真在、SHOpenFolderAndSelectItems 是否真选中）
 * 由 W1b wine 冒烟与 W2 真机清单分别承担，见 docs/INTERNAL/WINTEST-SOP.md。
 *
 * 注：`autoLaunchMain.ts` 的 win32 分支由 tests/unit/autoLaunch.test.ts（platform 参数化注入）覆盖；
 *     WM_POWERBROADCAST 的 wParam 解析由 tests/unit/wake.test.ts 覆盖；本文件不重复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** spawn 调用捕获（模块 mock 需在 import 前声明 ⇒ vi.hoisted） */
const h = vi.hoisted(() => {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = []
  // `stdout` = 被测进程的标准输出内容（读剪贴板分支要用；其余用例留空串，行为与改造前一致）
  const state = { exitCode: 0, emitError: false, stdout: '' }
  return { calls, state }
})

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => {
    h.calls.push({ cmd, args, opts })
    const child: Record<string, unknown> = {
      unref: () => {},
      kill: () => {},
      stdin: { end: () => {} },
      // 读侧（`runCapture`）要拿 stdout：`setEncoding` 空实现 + 有内容时在 exit 之前吐一次 data
      stdout: {
        setEncoding: () => {},
        on: (ev: string, cb: (arg?: unknown) => void) => {
          if (ev === 'data' && h.state.stdout) setTimeout(() => cb(h.state.stdout), 0)
        },
      },
      on: (ev: string, cb: (arg?: unknown) => void) => {
        if (ev === 'error' && h.state.emitError) {
          setTimeout(() => cb(new Error('ENOENT')), 0)
          return
        }
        if (ev === 'error') return // 正常路径不触发 error
        if (ev === 'close' || ev === 'exit') {
          const code = h.state.emitError ? null : h.state.exitCode
          setTimeout(() => cb(code), 0)
        }
      },
    }
    return child
  },
}))

const { showItemInFolder, openPath, readBuffer } = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  openPath: vi.fn(() => Promise.resolve('')),
  readBuffer: vi.fn(() => Buffer.alloc(0)),
}))
vi.mock('electron', () => ({
  shell: { showItemInFolder, openPath, openExternal: vi.fn() },
  clipboard: { writeBuffer: vi.fn(), readBuffer },
}))

import { showFilesInExplorer } from '../../src/main/explorer'
import { buildCFHDropBuffer, copyFilesToClipboard, readClipboardFilePaths } from '../../src/main/clipboard'
import { openFileWithDefaultApp } from '../../src/main/open'

/** 宿主平台替身：三个被测模块都在调用时读 process.platform，故按用例切换即可 */
const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
function usePlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...(platformDesc as object), value: p, configurable: true })
}

beforeEach(() => {
  h.calls.length = 0
  h.state.exitCode = 0
  h.state.emitError = false
  h.state.stdout = ''
  showItemInFolder.mockClear()
  openPath.mockClear()
  openPath.mockResolvedValue('')
  readBuffer.mockClear()
  readBuffer.mockImplementation(() => Buffer.alloc(0))
  delete process.env.QIHEBOX_E2E
})

afterEach(() => {
  if (platformDesc) Object.defineProperty(process, 'platform', platformDesc)
})

/** 从 powershell 参数里取脚本文本（explorer 用 -Command，clipboard 用 -EncodedCommand base64/utf16le） */
function decodedScript(args: string[]): string {
  const i = args.indexOf('-EncodedCommand')
  if (i >= 0) return Buffer.from(args[i + 1], 'base64').toString('utf16le')
  const j = args.indexOf('-Command')
  return j >= 0 ? args[j + 1] : ''
}

describe('explorer.ts Windows 分支：单文件走 shell，多文件走 PowerShell 选中', () => {
  beforeEach(() => usePlatform('win32'))

  it('单文件：调 shell.showItemInFolder，不碰 PowerShell', async () => {
    await showFilesInExplorer(['C:\\ws\\图包\\主图\\a.jpg'])
    expect(showItemInFolder).toHaveBeenCalledTimes(1)
    expect(showItemInFolder).toHaveBeenCalledWith('C:\\ws\\图包\\主图\\a.jpg')
    expect(h.calls).toHaveLength(0)
  })

  // 说明：本模块的分组用 path.dirname/basename = **宿主语义**。在 Linux 上跑 win32 分支时，
  // 正斜杠形状的 Windows 路径（C:/ws/a.jpg，Windows API 同样接受）才可被正确拆分；
  // 反斜杠形状的塌缩单独钉在下方「台账 W-03」用例里，不混进行为断言。
  it('同目录多文件：一次 powershell 调用，脚本内按目录分组且文件名走单引号转义', async () => {
    await showFilesInExplorer(['C:/ws/图包/a.jpg', 'C:/ws/图包/b.jpg'])
    expect(showItemInFolder).not.toHaveBeenCalled()
    expect(h.calls).toHaveLength(1)
    const { cmd, args } = h.calls[0]
    expect(cmd).toBe('powershell')
    expect(args.slice(0, 2)).toEqual(['-NoProfile', '-Command'])
    const script = decodedScript(args)
    // v2.4.2（S3）修复面：必须单引号包裹（双引号会被 PowerShell 插值 → $ 文件名即命令注入）
    expect(script).toContain("'a.jpg','b.jpg'")
    expect(script).toContain(`Select('C:/ws/图包'`)
    expect(script).toContain('SHOpenFolderAndSelectItems')
  })

  it('含 $ 与单引号的文件名不得被插值/逃逸出字符串（命令注入锚）', async () => {
    await showFilesInExplorer(["C:/ws/a'$(calc).jpg", 'C:/ws/b.jpg'])
    const script = decodedScript(h.calls[0].args)
    expect(script).toContain("'a''$(calc).jpg'") // 名内单引号成对转义，整体仍在同一字面量内
    expect(script).not.toContain('"$(calc)') // 不得出现双引号形态（双引号会被 PowerShell 插值）
    // 目录参数同样转义
    await showFilesInExplorer(["C:/ws''x/a.jpg", "C:/ws''x/b.jpg"])
    expect(decodedScript(h.calls[1].args)).toContain(`Select('C:/ws''''x'`)
  })

  it('跨目录多文件：按目录分组，每个目录各一次 PowerShell', async () => {
    await showFilesInExplorer(['C:/ws/图包/a.jpg', 'C:/ws/证书/b.pdf'])
    expect(h.calls).toHaveLength(2)
    expect(decodedScript(h.calls[0].args)).toContain("'a.jpg'")
    expect(decodedScript(h.calls[1].args)).toContain("'b.pdf'")
  })

  it('台账 W-03 锚：反斜杠 Windows 路径在 POSIX 宿主上分组塌成 "."（真机 Windows 不受影响）', async () => {
    // 病根：win32 分支的 dirname/basename 走宿主 path ⇒ Linux 上反斜杠不是分隔符，
    // 所有文件同归 '.'，basename 退化成整串。真机 Windows（path=win32）无此问题，
    // 但「跨机传来的 Windows 路径字符串」在本机会走这条退化路（LAN 同步/R3 场景需留意）。
    // 由 W1b wine 冒烟在真 win32 语义下复验；此处只钉住现状，防被误当成已修。
    await showFilesInExplorer(['C:\\ws\\图包\\a.jpg', 'C:\\ws\\证书\\b.pdf'])
    expect(h.calls).toHaveLength(1) // 两个不同目录被塌成同一组
    const script = decodedScript(h.calls[0].args)
    expect(script).toContain(`Select('.', @('C:\\ws\\图包\\a.jpg','C:\\ws\\证书\\b.pdf'))`)
  })

  it('PowerShell 非零退出 → 逐个回退 shell.showItemInFolder（不静默失败）', async () => {
    h.state.exitCode = 1
    await showFilesInExplorer(['C:\\ws\\a.jpg', 'C:\\ws\\b.jpg'])
    expect(showItemInFolder).toHaveBeenCalledTimes(2)
  })

  it('无 PowerShell（spawn error）→ 同样回退，且不抛出', async () => {
    h.state.emitError = true
    await expect(showFilesInExplorer(['C:\\ws\\a.jpg', 'C:\\ws\\b.jpg'])).resolves.toBeUndefined()
    expect(showItemInFolder).toHaveBeenCalledTimes(2)
  })

  it('空路径列表：不动 shell 不起进程', async () => {
    await showFilesInExplorer([])
    expect(showItemInFolder).not.toHaveBeenCalled()
    expect(h.calls).toHaveLength(0)
  })
})

describe('clipboard.ts Windows 分支：Set-Clipboard -LiteralPath（-EncodedCommand 免疫引号）', () => {
  beforeEach(() => usePlatform('win32'))

  it('命令与参数形状正确，脚本内是 -LiteralPath 数组', async () => {
    await copyFilesToClipboard(['C:\\ws\\a.jpg', 'C:\\ws\\b.jpg'])
    expect(h.calls).toHaveLength(1)
    const { cmd, args, opts } = h.calls[0]
    expect(cmd).toBe('powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(opts).toEqual({ stdio: 'ignore' })
    expect(decodedScript(args)).toBe(
      `Set-Clipboard -LiteralPath @('C:\\ws\\a.jpg','C:\\ws\\b.jpg') -ErrorAction Stop`,
    )
  })

  it('文件名含单引号 → 成对转义，不脱离字符串', async () => {
    await copyFilesToClipboard(["C:\\ws\\it's.jpg"])
    expect(decodedScript(h.calls[0].args)).toBe(`Set-Clipboard -LiteralPath @('C:\\ws\\it''s.jpg') -ErrorAction Stop`)
  })

  it('PowerShell 非零退出 → 明确报错（不假成功）', async () => {
    h.state.exitCode = 1
    await expect(copyFilesToClipboard(['C:\\ws\\a.jpg'])).rejects.toThrow(/Set-Clipboard 退出码 1/)
  })

  it('PowerShell 不存在（spawn error）→ 明确报错并带原因', async () => {
    h.state.emitError = true
    await expect(copyFilesToClipboard(['C:\\ws\\a.jpg'])).rejects.toThrow(/调用 PowerShell 失败/)
  })

  it('buildCFHDropBuffer：DROPFILES 头 20 字节 / fWide=1 / UTF-16LE / 双空结尾（旧实现留档）', () => {
    const buf = buildCFHDropBuffer(['C:\\ws\\a.jpg'])
    expect(buf.readUInt32LE(0)).toBe(20) // pFiles
    expect(buf.readUInt32LE(16)).toBe(1) // fWide = UTF-16
    const body = buf.subarray(20).toString('utf16le')
    expect(body).toBe('C:\\ws\\a.jpg\0\0')
  })
})

/**
 * 读侧（v2.5.8 D19 / 体验批 B3「Ctrl+V 粘贴导入」）。
 * 工具链与上面的写侧严格镜像：Win 走 PowerShell（写 Set-Clipboard / 读 Get-Clipboard），
 * Linux 走 xclip → xsel → wl-paste → Electron。这几条分支在 Linux 宿主上永不执行，
 * 所以按 W0 的约定在这里钉「调什么命令、参数怎么拼、失败怎么降级」。
 */
describe('clipboard.ts 读侧 Windows 分支：Get-Clipboard -Format FileDropList', () => {
  beforeEach(() => usePlatform('win32'))

  it('一次 powershell.exe 调用；脚本取 FileDropList 并把输出编码钉成 UTF-8', async () => {
    h.state.stdout = 'C:\\ws\\a.jpg\nC:\\ws\\b.jpg\n'
    const paths = await readClipboardFilePaths()
    expect(h.calls).toHaveLength(1)
    const { cmd, args, opts } = h.calls[0]
    expect(cmd).toBe('powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    // 与写侧唯一的形状差异：读侧必须把 stdout 接成管道（写侧是 stdio: 'ignore'）
    expect(opts).toEqual({ stdio: ['ignore', 'pipe', 'ignore'] })
    const script = decodedScript(args)
    expect(script).toContain('Get-Clipboard -Format FileDropList')
    // 不设 OutputEncoding，中文文件名会被 PowerShell 按控制台代码页转义成 '?' ⇒ 拿到一串坏路径
    expect(script).toContain('[Console]::OutputEncoding')
    expect(paths).toEqual(['C:\\ws\\a.jpg', 'C:\\ws\\b.jpg'])
  })

  it('中文路径原样回来（PowerShell 输出按 UTF-8 解码）', async () => {
    h.state.stdout = 'C:\\ws\\图包\\主图\\产品 图.jpg\n'
    expect(await readClipboardFilePaths()).toEqual(['C:\\ws\\图包\\主图\\产品 图.jpg'])
  })

  it('剪贴板里没有文件（stdout 空）→ 空数组，不算错误（渲染层据此静默不动作）', async () => {
    h.state.stdout = '\n  \n'
    expect(await readClipboardFilePaths()).toEqual([])
  })

  it('相对路径条目丢弃、重复条目去重（拼接目标位置不能靠猜）', async () => {
    h.state.stdout = 'a.png\nC:\\ws\\a.png\nC:\\ws\\a.png\n'
    expect(await readClipboardFilePaths()).toEqual(['C:\\ws\\a.png'])
  })

  it('PowerShell 非零退出 → 明确报错（不能把"读挂了"糊成"剪贴板是空的"）', async () => {
    h.state.exitCode = 1
    await expect(readClipboardFilePaths()).rejects.toThrow(/PowerShell 退出码 1/)
  })

  it('PowerShell 不存在（spawn error）→ 报错带原因', async () => {
    h.state.emitError = true
    await expect(readClipboardFilePaths()).rejects.toThrow(/PowerShell 不可用/)
  })
})

describe('open.ts Windows 分支：shell.openPath 的 resolve/reject 与 e2e 短路', () => {
  beforeEach(() => usePlatform('win32'))

  it('openPath 返回空串 = 成功', async () => {
    await expect(openFileWithDefaultApp('C:\\ws\\a.pdf')).resolves.toBeUndefined()
    expect(openPath).toHaveBeenCalledWith('C:\\ws\\a.pdf')
  })

  it('openPath 返回错误文本 = 抛错（Windows 用返回值表失败，不 reject）', async () => {
    openPath.mockResolvedValueOnce('No application found')
    await expect(openFileWithDefaultApp('C:\\ws\\no-app.bin')).rejects.toThrow(/No application found/)
  })

  it('2s 内同路径重复打开只发一次（去重窗口，防弹多窗口）', async () => {
    const p = 'C:\\ws\\dup.jpg'
    await openFileWithDefaultApp(p)
    await openFileWithDefaultApp(p)
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 台账锚：QIHEBOX_E2E=1 时 win32 分支被整体短路（wine 冒烟测不到真 openPath）', async () => {
    // spike-2026-09-08 §三.2 的发现：e2e 隔离模式为防子进程残留，在平台分支之前 return。
    // ⇒ W1b 冒烟不得声称「已验证用默认应用打开文件」；该面由本例 + W2 真机清单负责。
    process.env.QIHEBOX_E2E = '1'
    await expect(openFileWithDefaultApp('C:\\ws\\e2e.jpg')).resolves.toBeUndefined()
    expect(openPath).not.toHaveBeenCalled()
    delete process.env.QIHEBOX_E2E
  })
})

describe('非 Windows 宿主不得走进 win32 分支（防平台判定被改反）', () => {
  it('linux：explorer 不调 shell.showItemInFolder 的 Windows 通道', async () => {
    usePlatform('linux')
    await showFilesInExplorer(['C:\\ws\\a.jpg']).catch(() => undefined)
    // Linux 走文件管理器外部命令；关键是不经 Windows 的 PowerShell 选中脚本
    const scripts = h.calls.map((c) => decodedScript(c.args)).join('\n')
    expect(scripts).not.toContain('SHOpenFolderAndSelectItems')
  })

  it('linux：clipboard 不调 powershell.exe Set-Clipboard', async () => {
    usePlatform('linux')
    await copyFilesToClipboard(['/ws/a.jpg']).catch(() => undefined)
    expect(h.calls.some((c) => c.cmd === 'powershell.exe')).toBe(false)
  })

  it('linux：读侧按 xclip → xsel → wl-paste 的顺序试，且不碰 PowerShell', async () => {
    usePlatform('linux')
    h.state.exitCode = 1 // 三个工具都不可用 → 全部试过才回退
    await readClipboardFilePaths()
    expect(h.calls.map((c) => c.cmd)).toEqual(['xclip', 'xsel', 'wl-paste'])
    expect(h.calls.some((c) => c.cmd === 'powershell.exe')).toBe(false)
  })

  it('linux：xclip 一上来就成功即止（不多调两个工具），参数是 text/uri-list 读法', async () => {
    usePlatform('linux')
    h.state.stdout = 'file:///ws/a.jpg\n'
    expect(await readClipboardFilePaths()).toEqual(['/ws/a.jpg'])
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].args).toEqual(['-selection', 'clipboard', '-t', 'text/uri-list', '-o'])
  })

  it('linux：三个工具都不在 → 回退 Electron readBuffer（与写侧的 fallbackWrite 镜像）', async () => {
    usePlatform('linux')
    h.state.emitError = true
    readBuffer.mockReturnValueOnce(Buffer.from('file:///ws/%E4%B8%BB%E5%9B%BE/a.png\n', 'utf-8'))
    expect(await readClipboardFilePaths()).toEqual(['/ws/主图/a.png'])
  })

  it('linux：连 Electron 也读不到东西 → 空数组而不是报错（"没有文件"与"读取失败"是两件事）', async () => {
    usePlatform('linux')
    h.state.emitError = true
    expect(await readClipboardFilePaths()).toEqual([])
  })
})
