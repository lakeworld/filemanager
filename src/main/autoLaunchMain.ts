/**
 * 开机自启平台薄壳（v2.4.9 S4）：electron 依赖留在此层，纯函数在 core/autoLaunch.ts（node 直测）。
 *
 * Linux：写/删 ~/.config/autostart/启禾文件管理.desktop（Exec 目标由 resolveAutoLaunchTarget
 *         解析：AppImage 取 env.APPIMAGE、安装版取 execPath、未打包实例拒写并抛人话）；查询 = 文件存在
 * Windows：app.setLoginItemSettings({ openAtLogin, path: <解析出的目标>, args: ['--autostart'] })；
 *          未打包实例开自启同样抛人话（写 electron.exe 登录会弹 Electron 空窗），关自启不需目标；
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
import {
  UNPACKED_AUTOLAUNCH_MESSAGE,
  buildDesktopEntry,
  desktopEntryPath,
  entryOwnedByExec,
  resolveAutoLaunchTarget,
} from './core/autoLaunch'

/** macOS 自启实例判定：args 在 macOS 不可用，wasOpenedAtLogin 为唯一来源（待真机验证） */
export function isMacAutostartLaunch(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
}

/** 设置开机自启（平台三分支薄壳） */
export function setAutoLaunch(enabled: boolean, platform: NodeJS.Platform = process.platform): void {
  // 自启目标（AppImage 本体 / 安装版 execPath / 未打包=null）：解析口径与理由见 core 的纯函数
  const target = resolveAutoLaunchTarget({
    env: process.env,
    execPath: process.execPath,
    isPackaged: app.isPackaged,
  })
  if (platform === 'win32') {
    // Windows：注册表 Run 键带 --autostart（启动参数判定自启态）
    // 未打包时 path 会是 electron.exe（登录弹 Electron 空窗）→ 开拒写并抛人话，关（撤销）不需目标
    if (!target) {
      if (enabled) throw new Error(UNPACKED_AUTOLAUNCH_MESSAGE)
      app.setLoginItemSettings({ openAtLogin: false })
      return
    }
    app.setLoginItemSettings({ openAtLogin: enabled, path: target, args: ['--autostart'] })
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
  if (!enabled) {
    // 关 = 撤销。未打包实例只清「本实例 execPath 写出来的那条」（多为开发/预览期误开），
    // 不越权删安装版写的合法条目——此时状态未变，设置页下次挂载按 isAutoLaunch 回正
    if (!fs.existsSync(entry)) return
    if (target || entryOwnedByExec(fs.readFileSync(entry, 'utf8'), process.execPath)) {
      fs.rmSync(entry, { force: true })
    }
    return
  }
  if (!target) throw new Error(UNPACKED_AUTOLAUNCH_MESSAGE)
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, buildDesktopEntry(target), 'utf8')
}

/** 查询开机自启状态（平台三分支薄壳） */
export function isAutoLaunch(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return app.getLoginItemSettings().openAtLogin
  if (platform === 'darwin') return app.getLoginItemSettings().openAtLogin
  return fs.existsSync(desktopEntryPath(process.env, os.homedir()))
}
