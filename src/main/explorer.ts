/**
 * 资源管理器：打开文件管理器并选中指定文件（对照原 Go internal/explorer）
 * - Linux：按目录分组，优先 nautilus --select / dolphin --select，回退 xdg-open 打开目录
 * - Windows：PowerShell 调 SHOpenFolderAndSelectItems 实现多文件选中，单文件走 shell.showItemInFolder
 */
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'

export function showFilesInExplorer(paths: string[]): Promise<void> {
  if (process.platform === 'win32') {
    return showFilesWindows(paths)
  }
  return showFilesLinux(paths)
}

/** 外部命令超时（v2.4.0）：无桌面环境（CI）下文件管理器命令可能挂起，超时视为已发起并放行 */
const TOOL_TIMEOUT_MS = 5000

function execTool(args: string[], _stdinData?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // stdio 全 ignore：任何 pipe 句柄（即使 child.unref()）都会保持事件循环，
    // 导致主进程退出挂起（app.close/evaluate 超时根因）
    const child = spawn(args[0], args.slice(1), { stdio: 'ignore' })
    child.unref() // 防止子进程句柄阻塞主进程退出
    const timer = setTimeout(() => {
      child.kill()
      resolve(0) // 超时视为命令已发起（GUI 应用常驻不退出属正常）
    }, TOOL_TIMEOUT_MS)
    child.on('error', () => {
      clearTimeout(timer)
      reject(new Error(`命令不存在: ${args[0]}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
  })
}

async function showFilesLinux(paths: string[]): Promise<void> {
  // 按目录分组
  const groups = new Map<string, string[]>()
  for (const p of paths) {
    const dir = path.dirname(p)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir)!.push(p)
  }

  const desktop = (process.env['XDG_CURRENT_DESKTOP'] ?? '').toLowerCase()
  const trySelect = async (cmd: string, fileArgs: (p: string) => string[]): Promise<boolean> => {
    let any = false
    for (const [, files] of groups) {
      const args = [...fileArgs(files[0]), ...files.slice(1).map((f) => f)]
      const code = await execTool([cmd, ...args]).catch(() => -1)
      if (code === 0) any = true
    }
    return any
  }

  let ok = false
  if (desktop.includes('deepin')) {
    // Deepin：dde-file-manager --show-item 打开并选中
    for (const p of paths) {
      const code = await execTool(['dde-file-manager', '--show-item', p]).catch(() => -1)
      if (code === 0) ok = true
    }
  } else if (desktop.includes('kde')) {
    // dolphin --select 仅支持单文件，多文件逐个
    for (const p of paths) {
      const code = await execTool(['dolphin', '--select', p]).catch(() => -1)
      if (code === 0) ok = true
    }
  } else {
    // GNOME 优先 nautilus（支持多个 --select 参数）
    ok = await trySelect('nautilus', (p) => ['--select', p])
    if (!ok) ok = await trySelect('pcmanfm', (p) => ['--select', p])
  }

  // 回退：打开所在目录
  if (!ok) {
    const dirs = [...new Set(paths.map((p) => path.dirname(p)))]
    for (const d of dirs) {
      const code = await execTool(['xdg-open', d]).catch(() => -1)
      if (code === 0) ok = true
    }
  }
  if (!ok) throw new Error('未找到可用的文件管理器（尝试 nautilus/pcmanfm/xdg-open）')
}

/** Windows：单文件用 shell.showItemInFolder；同目录多文件用 PowerShell COM 选中 */
async function showFilesWindows(paths: string[]): Promise<void> {
  if (paths.length === 1) {
    shell.showItemInFolder(paths[0])
    return
  }
  const groups = new Map<string, string[]>()
  for (const p of paths) {
    const dir = path.dirname(p)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir)!.push(p)
  }
  // PowerShell 调 SHOpenFolderAndSelectItems 批量选中（Add-Type C#）
  for (const [dir, files] of groups) {
    const fileList = files.map((f) => JSON.stringify(path.basename(f))).join(',')
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FmSel {
  [DllImport("shell32.dll")] static extern void SHParseDisplayName([MarshalAs(UnmanagedType.LPWStr)] string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);
  [DllImport("shell32.dll")] static extern void SHOpenFolderAndSelectItems(IntPtr pidlFolder, uint cidl, IntPtr[] apidl, uint dwFlags);
  [DllImport("shell32.dll")] static extern void CoTaskMemFree(IntPtr pv);
  public static void Select(string folder, string[] names) {
    IntPtr folderPidl; uint attrs;
    SHParseDisplayName(folder, IntPtr.Zero, out folderPidl, 0, out attrs);
    var pidls = new IntPtr[names.Length];
    for (int i=0;i<names.Length;i++){ IntPtr p; SHParseDisplayName(System.IO.Path.Combine(folder,names[i]), IntPtr.Zero, out p, 0, out attrs); pidls[i]=p; }
    SHOpenFolderAndSelectItems(folderPidl, (uint)names.Length, pidls, 0);
    foreach (var p in pidls) CoTaskMemFree(p);
    CoTaskMemFree(folderPidl);
  }
}
"@
[FmSel]::Select('${dir.replace(/'/g, "''")}', @(${fileList}))`
    const code = await execTool(
      ['powershell', '-NoProfile', '-Command', script],
    ).catch(() => -1)
    if (code !== 0) {
      // 回退逐个选中
      for (const f of files) shell.showItemInFolder(f)
    }
  }
}
