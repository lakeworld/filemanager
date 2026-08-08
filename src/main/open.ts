/** 用系统默认应用打开文件（对照原 Go files.go OpenFileWithDefaultApp） */
import { spawn } from 'node:child_process'

export function openFileWithDefaultApp(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows：shell.openPath 正常 resolve（不挂起）
      import('electron').then(({ shell }) => {
        shell.openPath(filePath).then((err) => {
          if (err) reject(new Error(err))
          else resolve()
        })
      })
      return
    }
    // Linux：用 xdg-open 子进程，避免 shell.openPath 因 GUI 应用不退出而挂起 IPC
    const child = spawn('xdg-open', [filePath])
    let errOut = ''
    child.stderr?.on('data', (d) => (errOut += d.toString()))
    child.on('error', () => reject(new Error('未找到 xdg-open')))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`xdg-open 退出码 ${code}${errOut ? `: ${errOut.trim()}` : ''}`))
    })
  })
}
