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
 * 生成 .desktop 内容：Type=Application / Name=启禾文件管理 /
 * Exec 含 AUTOSTART_ARGS 全量（路径可能含空格，恒用双引号包裹）/ X-GNOME-Autostart-enabled=true
 */
export function buildDesktopEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=启禾文件管理',
    `Exec="${execPath}" ${AUTOSTART_ARGS.join(' ')}`,
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}
