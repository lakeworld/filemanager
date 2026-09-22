/**
 * 应用内重启的**纯判据**（v2.6 批 2，「插件更新即重启」通道 `qihebox:app:relaunch` 的决策面）。
 *
 * 为什么复用 `resolveAutoLaunchTarget`：这是本仓唯一一处「该执行哪个文件」的权威判据——
 * AppImage 形态下 `process.execPath` 住在 `/tmp/.mount_XXXX/` 挂载点内（每次启动目录名都变，
 * 重启写它会找不到文件），必须回到 `.AppImage` 本体（`env.APPIMAGE`）。再立一份判据 = 双源漂移。
 *
 * 出口语义：
 * - AppImage（target 与 execPath 不同）→ `{ execPath: <AppImage 本体>, args: <原启动参数> }`；
 * - 安装版 deb/NSIS（target === execPath）→ `{}`：交回 electron 默认（`app.relaunch()` 用 process.execPath）；
 * - 未打包（target === null，开发/预览）→ `{}`：同默认，便于开发期验证「重启」按钮不砖。
 *
 * 纯 TS：不 import electron（shell 见 main/relaunchMain.ts）→ node 直测。
 */
import { resolveAutoLaunchTarget } from './autoLaunch'

export interface RelaunchOptions {
  /** 新实例可执行文件（缺省 = 交回 electron 默认） */
  execPath?: string
  /** 新实例启动参数（仅 AppImage 分支显式给出；argv[0] 是本体，不重复带） */
  args?: string[]
}

/**
 * 解析重启参数。`argv` = 当前进程 `process.argv`（argv[0] 为本体路径，不传给新实例）。
 */
export function resolveRelaunchOptions(opts: {
  env: Record<string, string | undefined>
  execPath: string
  isPackaged: boolean
  argv: string[]
}): RelaunchOptions {
  const target = resolveAutoLaunchTarget({
    env: opts.env,
    execPath: opts.execPath,
    isPackaged: opts.isPackaged,
  })
  if (!target || target === opts.execPath) return {}
  return { execPath: target, args: opts.argv.slice(1) }
}