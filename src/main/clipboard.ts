/**
 * 剪贴板：复制文件到系统剪贴板（对照原 Go internal/clipboard）
 * - Windows：CF_HDROP（DROPFILES 结构 + UTF-16 路径列表）
 * - Linux：text/uri-list（file:// URI 列表），优先 xclip，回退 Electron clipboard
 */
import { clipboard } from 'electron'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 构造 CF_HDROP 缓冲区（纯函数，供测试）。paths 为文件绝对路径。 */
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
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      try {
        const buffer = buildCFHDropBuffer(paths)
        clipboard.writeBuffer('CF_HDROP', buffer)
        resolve()
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      return
    }

    // Linux：text/uri-list，优先 xclip
    const uriList = buildUriList(paths)
    const xclip = spawn('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let errOut = ''
    xclip.stderr?.on('data', (d) => (errOut += d.toString()))
    xclip.on('error', () => {
      // xclip 不存在 → 回退 Electron clipboard.writeBuffer
      fallbackWrite(uriList, resolve, reject)
    })
    xclip.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        fallbackWrite(uriList, resolve, reject, errOut)
      }
    })
    xclip.stdin?.end(uriList)
  })
}

function fallbackWrite(
  uriList: string,
  resolve: () => void,
  reject: (err: Error) => void,
  detail = '',
): void {
  try {
    clipboard.writeBuffer('text/uri-list', Buffer.from(uriList, 'utf-8'))
    resolve()
  } catch (err) {
    reject(
      new Error(
        `复制文件到剪贴板失败（无 xclip 且 Electron 回退失败）${detail ? `: ${detail.trim()}` : ''}`,
      ),
    )
  }
}
