/**
 * 应用内重启的平台薄壳（v2.6 批 2）：electron 依赖留在此层，判据在 core/relaunch.ts（node 直测）。
 *
 * 语义 = **正常退出路径重启**：`app.relaunch()` 排定新实例 → `app.quit()` 走正常退出
 * （index.ts 的 `before-quit` 置 quitting → 窗口正常销毁 → will-quit 里插件 dispose 与热键注销照跑），
 * 不是 `exit()` 硬退。插件是热侧载非热刷新（内部版插件契约（不进公开仓）§4.1），
 * 覆盖安装（更新）后新版本要靠这一次重启完全生效——所以必须走正常退出，别把退出清理跳过。
 */
import { app } from 'electron'
import { resolveRelaunchOptions } from './core/relaunch'

/** 重启应用：AppImage 取 env.APPIMAGE（复用自启同一判据），其余交 electron 默认 */
export function relaunchApp(): void {
  app.relaunch(
    resolveRelaunchOptions({
      env: process.env,
      execPath: process.execPath,
      isPackaged: app.isPackaged,
      argv: process.argv,
    }),
  )
  app.quit()
}