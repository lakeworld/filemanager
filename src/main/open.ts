/** 用系统默认应用打开文件（对照原 Go files.go OpenFileWithDefaultApp）
 *  v2.3.2：同路径 2s 内重复打开直接跳过，避免渲染层快速重复调用弹出多个窗口 */
import { spawn } from 'node:child_process'

/** 最近打开记录（filePath → 时间戳），用于短时间去重 */
const lastOpened = new Map<string, number>()
/** 去重窗口：2s 内同路径重复打开视为一次 */
const DEDUP_WINDOW_MS = 2000
/** 记录条数上限，超过即清空，防止长期运行内存增长 */
const MAX_RECORDS = 200

export function openFileWithDefaultApp(filePath: string): Promise<void> {
  // 短时间去重：命中则直接 resolve（不记录本次，保持原记录生效）
  const now = Date.now()
  const last = lastOpened.get(filePath)
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return Promise.resolve()
  // 真正执行前记录本次打开时间
  lastOpened.set(filePath, now)
  if (lastOpened.size > MAX_RECORDS) lastOpened.clear()

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
    // v2.4.0：无桌面环境（CI/SSH）下 xdg-open 可能等待默认应用不退出 → 5s 超时 kill 并视为已发起；
    // child.unref() 防止子进程句柄阻塞主进程退出（否则 app.close() 挂起）
    const child = spawn('xdg-open', [filePath], { stdio: 'ignore' })
    child.unref()
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, 5000)
    child.on('error', () => {
      clearTimeout(timer)
      reject(new Error('未找到 xdg-open'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`xdg-open 退出码 ${code}`))
    })
  })
}
