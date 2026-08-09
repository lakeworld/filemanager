/**
 * 剪贴板：复制文件到系统剪贴板（对照原 Go internal/clipboard）
 * - Windows：PowerShell Set-Clipboard -LiteralPath（v2.4.2 起，替代旧 CF_HDROP writeBuffer——
 *   旧实现按名注册 'CF_HDROP' 得到 ≥0xC000 的新格式 ID 而非预定义 15，资源管理器/微信粘贴无内容）
 * - Linux：text/uri-list（file:// URI 列表），优先 xclip，依次回退 xsel / wl-copy / Electron writeBuffer（带读回验证）
 */
import { clipboard } from 'electron'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

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
