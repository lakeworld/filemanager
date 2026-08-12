/**
 * 开机自启平台薄壳（v2.4.9 S4）：electron 依赖留在此层，纯函数在 core/autoLaunch.ts（node 直测）。
 *
 * Linux：写/删 ~/.config/autostart/启禾文件管理.desktop（execPath = process.execPath）；查询 = 文件存在
 * Windows：app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: ['--autostart'] })；
 *          查询 app.getLoginItemSettings().openAtLogin（args 为 Windows 专属，注册表 Run 键带参，
 *          供登录启动的进程内 --autostart 判定）
 * macOS：args 不可用（不写入）；自启实例判定靠 wasOpenedAtLogin（isMacAutostartLaunch，index.ts 启动分支用）；
 *        设置 openAsHidden: true 兜底（自启打开不弹窗，自启态本就不建窗，双保险）。
 *        mac 非当前构建目标，分支标注「待验证」——真机验证后删除注释。
 *
 * platform 参数化注入（默认 process.platform）：单测 mock electron 后逐平台断言分支行为。
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDesktopEntry, desktopEntryPath } from './core/autoLaunch'

/** macOS 自启实例判定：args 在 macOS 不可用，wasOpenedAtLogin 为唯一来源（待真机验证） */
export function isMacAutostartLaunch(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
}

/** 设置开机自启（平台三分支薄壳） */
export function setAutoLaunch(enabled: boolean, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    // Windows：注册表 Run 键带 --autostart（启动参数判定自启态）
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--autostart'] })
    return
  }
  if (platform === 'darwin') {
    // macOS（待验证）：setLoginItemSettings 的 args 参数在 macOS 不可用（不写入）；
    // openAsHidden 兜底——自启打开不弹窗（自启态本就不建窗，双保险）；
    // 自启实例判定靠 isMacAutostartLaunch / wasOpenedAtLogin
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
    return
  }
  // Linux（默认分支）：~/.config/autostart/启禾文件管理.desktop
  const home = os.homedir()
  const entry = desktopEntryPath(process.env, home)
  if (enabled) {
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, buildDesktopEntry(process.execPath), 'utf8')
  } else {
    fs.rmSync(entry, { force: true })
  }
}

/** 查询开机自启状态（平台三分支薄壳） */
export function isAutoLaunch(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return app.getLoginItemSettings().openAtLogin
  if (platform === 'darwin') return app.getLoginItemSettings().openAtLogin
  return fs.existsSync(desktopEntryPath(process.env, os.homedir()))
}
