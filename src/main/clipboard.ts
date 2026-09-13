/**
 * 剪贴板：复制文件到系统剪贴板（对照原 Go internal/clipboard）
 * - Windows：PowerShell Set-Clipboard -LiteralPath（v2.4.2 起，替代旧 CF_HDROP writeBuffer——
 *   旧实现按名注册 'CF_HDROP' 得到 ≥0xC000 的新格式 ID 而非预定义 15，资源管理器/微信粘贴无内容）
 * - Linux：text/uri-list（file:// URI 列表），优先 xclip，依次回退 xsel / wl-copy / Electron writeBuffer（带读回验证）
 *
 * v2.5.8 D19（体验批 B3）新增**读侧** `readClipboardFilePaths`：平台与工具链与写侧一一对应
 * （Win `Get-Clipboard -Format FileDropList`、Linux xclip → xsel → wl-paste → Electron readBuffer），
 * 字符串解析那一段是纯函数，住在 `clipboardParse.ts`（零 electron 依赖，可直接单测）。
 */
import { clipboard } from 'electron'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { dedupePaths, parseFileDropList, parseUriList } from './clipboardParse'

/** 构造 CF_HDROP 缓冲区（保留纯函数，供测试/参考；生产 Windows 走 PowerShell） */
export function buildCFHDropBuffer(paths: string[]): Buffer {
  // DROPFILES 头部 20 字节：pFiles(4) + pt(8) + fNC(4) + fWide(4)
  const header = Buffer.alloc(20)
  header.writeUInt32LE(20, 0) // pFiles：文件列表偏移
  header.writeUInt32LE(0, 4) // pt.x
  header.writeUInt32LE(0, 8) // pt.y
  header.writeUInt32LE(0, 12) // fNC = false
  header.writeUInt32LE(1, 16) // fWide = true（UTF-16）

  const utf16 = (s: string): Buffer => {
    const b = Buffer.alloc(s.length * 2)
    for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2)
    return b
  }
  const list = Buffer.concat([...paths.map((p) => utf16(p + '\0')), utf16('\0')])
  return Buffer.concat([header, list])
}

function buildUriList(paths: string[]): string {
  return paths.map((p) => pathToFileURL(p).toString()).join('\n') + '\n'
}

/** 复制文件到剪贴板（跨平台）。失败抛出可读错误。 */
export function copyFilesToClipboard(paths: string[]): Promise<void> {
  if (process.platform === 'win32') {
    return winSetClipboard(paths)
  }
  return linuxCopy(paths)
}

// —— Windows：Set-Clipboard -LiteralPath（-EncodedCommand 传参，彻底免疫引号注入）——

function winSetClipboard(paths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const items = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')
    const script = `Set-Clipboard -LiteralPath @(${items}) -ErrorAction Stop`
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: 'ignore' },
    )
    child.unref()
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('设置剪贴板超时'))
    }, 10_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`调用 PowerShell 失败: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`复制到剪贴板失败（Set-Clipboard 退出码 ${code}）`))
    })
  })
}

// —— Linux：xclip → xsel → wl-copy → Electron writeBuffer（读回验证）——

function linuxCopy(paths: string[]): Promise<void> {
  const uriList = buildUriList(paths)
  return spawnTool('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list'], uriList)
    .catch(() => spawnTool('xsel', ['--clipboard', '--input'], uriList))
    .catch(() => spawnTool('wl-copy', ['--type', 'text/uri-list'], uriList))
    .catch(() => fallbackWrite(uriList))
}

/**
 * 运行外部剪贴板工具（stdin 喂数据）。
 * v2.4.2（R4）：监听 `exit` 而非 `close`——xclip 读完 stdin 后 fork 驻留进程持有剪贴板，
 * 驻留进程继承 stderr 管道写端导致 `close`（stdio 全 EOF）迟迟不触发，旧实现复制成功但 Promise 挂起。
 */
function spawnTool(cmd: string, args: string[], stdinData: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    child.unref()
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${cmd} 超时`))
    }, 10_000)
    child.on('error', () => {
      clearTimeout(timer)
      reject(new Error(`${cmd} 不可用`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${cmd} 退出码 ${code}`))
    })
    child.stdin?.end(stdinData)
  })
}

/**
 * 最终回退：Electron writeBuffer + 读回验证。
 * v2.4.2（R5）：不静默假成功——写后立即读回，内容不符即明确报错（提示安装 xclip/xsel）。
 */
async function fallbackWrite(uriList: string): Promise<void> {
  const expected = Buffer.from(uriList, 'utf-8')
  clipboard.writeBuffer('text/uri-list', expected)
  const got = clipboard.readBuffer('text/uri-list')
  if (!got.equals(expected)) {
    throw new Error(
      '复制到剪贴板失败：当前桌面环境的文件剪贴板不受支持，请安装 xclip（或 xsel）后重试',
    )
  }
}

// —— v2.5.8 D19（体验批 B3）：读侧。与上面写侧严格镜像（同一套工具、同一优先级、同样的回退）——

/**
 * 读系统剪贴板里的**文件绝对路径**（粘贴导入用）。没有文件时返回空数组，不算错误。
 *
 * 工具链与 `copyFilesToClipboard` 一一对应，就是为了避免「复制能用、粘贴报缺工具」这种
 * 只在半边装配的坑：Linux 走 xclip → xsel → wl-paste → Electron `readBuffer`；
 * Windows 走 PowerShell `Get-Clipboard -Format FileDropList`（写侧是 `Set-Clipboard`）。
 *
 * 只读不判权限：读到的路径可能是工作区外的任意文件——这正是粘贴导入的**目的**
 * （把外部文件拿进来），真正落哪里、叫什么名由既有的 `importFiles` 管道决定，
 * 那条管道自己已经把「只能在当前工作区内落地」这条红线守住了（复制侧的工作区校验不适用于读侧）。
 */
export async function readClipboardFilePaths(): Promise<string[]> {
  if (process.platform === 'win32') return dedupePaths(parseFileDropList(await winGetClipboardFiles()))
  return dedupePaths(parseUriList(await linuxReadUriList()))
}

/** Windows：PowerShell 取 FileDropList。`-EncodedCommand` 传参同写侧，免疫引号注入 */
function winGetClipboardFiles(): Promise<string> {
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    // 输出编码必须显式设成 UTF-8：PowerShell 默认跟控制台代码页走，中文文件名会被转成 '?'，
    // 拿到一串坏路径后面拼出来的目标位置只能靠猜
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);' +
    '(Get-Clipboard -Format FileDropList) -join "`n"'
  return runCapture(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    'PowerShell',
  )
}

/**
 * Linux：xclip → xsel → wl-paste → Electron readBuffer。
 * 前三者「不可用」和「剪贴板里确实没有文件」在退出码上分不开，所以一律往下退，
 * 最后由 Electron 兜底读一次；仍为空即按「没有文件」返回空串（渲染层据此静默不动作）。
 */
async function linuxReadUriList(): Promise<string> {
  for (const [cmd, args] of [
    ['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-o']],
    ['xsel', ['--clipboard', '--output']],
    ['wl-paste', ['--type', 'text/uri-list']],
  ] as Array<[string, string[]]>) {
    try {
      const out = await runCapture(cmd, args, cmd)
      if (out.trim().length > 0) return out
    } catch {
      // 该工具不在 / 没有这个格式 → 换下一个（与写侧的 .catch(() => …) 链同构）
    }
  }
  try {
    return clipboard.readBuffer('text/uri-list').toString('utf-8')
  } catch {
    return ''
  }
}

/** 跑外部命令并取 stdout（超时/起不来/退出码非零 → reject，错误里带命令名，口径同 spawnTool） */
function runCapture(cmd: string, args: string[], label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (err) {
      reject(new Error(`${label} 不可用: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    child.unref()
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${label} 超时`))
    }, 10_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${label} 不可用: ${err.message}`))
    })
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      // 上限护栏：剪贴板里理论上不会有几十万条路径，异常内容别把它全部吸进内存
      if (out.length < 1_000_000) out += chunk
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${label} 退出码 ${code}`))
    })
  })
}
