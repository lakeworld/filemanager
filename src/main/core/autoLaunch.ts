/**
 * 开机自启纯函数（v2.4.9 S4）：跨平台开机自启可 node 直测部分。
 * 不 import electron——平台薄壳（electron 依赖）在 src/main/autoLaunchMain.ts。
 *
 * 防漂移源头：AUTOSTART_ARGS 单点常量，与 electron-builder.yml linux.executableArgs、
 * scripts/measure-memory.mjs PROD_ARGS 三处同步（builder.yml/mjs 无法 import TS，
 * 运行期自校验空转，由单测静态锚定保证——见 tests/unit/autoLaunch.test.ts 防漂移节）。
 */
import path from 'node:path'

/** 启动参数（= measure-memory.mjs PROD_ARGS 五参 + --autostart，逐字一致；三处同步由单测锚定） */
export const AUTOSTART_ARGS = [
  '--no-zygote',
  '--no-sandbox',
  '--disable-gpu',
  '--in-process-gpu',
  '--js-flags=--max-old-space-size=768',
  '--autostart',
]

/** 命中来源：argv 含 --autostart 或 env QIHEBOX_AUTOSTART=1 */
export function isAutoLaunchMode(argv: string[], env: Record<string, string | undefined>): boolean {
  return argv.includes('--autostart') || env.QIHEBOX_AUTOSTART === '1'
}

/** Linux 自启目录：XDG_CONFIG_HOME（空串视为未设，按 XDG 规范回退）?? ~/.config（参数化注入，node 直测） */
export function autostartDir(env: Record<string, string | undefined>, homeDir: string): string {
  return env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
}

/**
 * .desktop 文件路径 = autostartDir + '/autostart/启禾文件管理.desktop'
 * （XDG autostart 规范：自启项在 $XDG_CONFIG_HOME/autostart/ 下，默认 ~/.config/autostart/；
 *  task-4-brief §一 与 §六 e2e 断言表述有出入，以 §六 e2e 断言 + XDG 规范为准）
 */
export function desktopEntryPath(env: Record<string, string | undefined>, homeDir: string): string {
  return path.join(autostartDir(env, homeDir), 'autostart', '启禾文件管理.desktop')
}

/**
 * 生成 .desktop 内容：Type/Name/Exec（含 AUTOSTART_ARGS 全量，路径可能含空格恒用双引号包裹）
 * + 桌面项常规字段。字段口径对齐安装器产物 `/usr/share/applications/qihe-box.desktop`
 * （Icon=qihe-box / Terminal=false / StartupWMClass=qihe-box / Categories=Office;）——
 * 缺 Icon 会让 DE 启动项面板把它显示成通用齿轮，缺 Terminal=false 部分 DE 按终端程序处理。
 * 注：不带安装器那行的 `%U`（自启不接文件参数，且 Exec 逐字断言由单测锚定）。
 */
export function buildDesktopEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=启禾文件管理',
    'Comment=启禾文件管理（BOX 项目）—— Electron 重构版：电商产品图包与证书管理',
    `Exec="${execPath}" ${AUTOSTART_ARGS.join(' ')}`,
    'Terminal=false',
    'Icon=qihe-box',
    'StartupWMClass=qihe-box',
    'Categories=Office;',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

/** 未打包实例（dev / `electron .` 预览）开自启的拒写话术：目标不可解析，宁可不写也不写坏 */
export const UNPACKED_AUTOLAUNCH_MESSAGE =
  '当前为未打包实例（开发/预览），开机自启仅在安装版（deb / AppImage / Windows 安装包）中生效'

/**
 * 解析「登录时该执行哪个文件」（v2.5.8 缺陷修）：
 * ① AppImage 形态 → `env.APPIMAGE`（AppImage 本体路径稳定）——此形态下 `process.execPath` 住在
 *    `/tmp/.mount_XXXX/` 挂载点内，**每次启动目录名都变**，写它 = 下次登录找不到文件；
 * ② 其余已打包（deb / NSIS）→ `execPath`；
 * ③ 未打包 → null：`execPath` 是 `node_modules/electron/dist/electron` 裸二进制，应用路径住在
 *    argv 里且不会被带进自启项，登录只会弹 Electron 默认空窗（用户实测报「自启启动的是 Electron
 *    窗口，不是本应用」的根因）。
 * APPIMAGE 空串视为未设置（与 autostartDir 的 XDG 宽松口径一致）。
 * `QIHEBOX_AUTOSTART_FORCE=1`：开发/测试旁路，按安装版形态对待（未打包实例本不该静默开自启，
 * 但 e2e 要验「设置页开关 → IPC → .desktop 内容」这条链，只能显式放行——同 QIHEBOX_E2E 惯例，
 * 真实用户环境不会有这个变量）。
 */
export function resolveAutoLaunchTarget(opts: {
  env: Record<string, string | undefined>
  execPath: string
  isPackaged: boolean
}): string | null {
  const appimage = opts.env.APPIMAGE
  if (appimage) return appimage
  if (opts.env.QIHEBOX_AUTOSTART_FORCE === '1') return opts.execPath
  return opts.isPackaged ? opts.execPath : null
}

/**
 * 判定一条 .desktop 是否由「该 execPath 的实例」写的（`entryOwnedByExec`）。
 * 未打包实例只敢清自己写坏的那条，不越权删安装版（deb/AppImage）写的合法条目。
 */
export function entryOwnedByExec(content: string, execPath: string): boolean {
  return content.includes(`Exec="${execPath}"`)
}
