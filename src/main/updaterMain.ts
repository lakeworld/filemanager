/**
 * 应用内更新的 **electron 薄壳**（v2.6 批 4）：electron 与 electron-updater 只住这一层。
 *
 * 分工（与 `relaunchMain.ts` / `autoLaunchMain.ts` 同一纪律）：
 * - 判据（形态三分 / 校验 / AppImage 落盘）在 `core/updatePlan.ts`（纯 TS，node 直测）；
 * - 账目（下过没下过、装完清账）在 `updater.ts`；
 * - 这里只做两件事：① 把宿主的环境事实喂给判据；② 用 electron-updater 取更新面的包。
 *
 * 为什么是 electron-updater：feed（`/updates/box/`，扁平静态目录）的读取、sha512 校验、
 * 断点/半截下载的处置都是它现成的（erp 侧发布脚本也是按「client 侧 electron-updater 自己按 feed 取」
 * 写的——见 `scripts/publish-box-installer.sh` 头注）。它同时**不做**的事：deb 自更新（本仓更新面
 * 也没有 deb 产物）→ 走 D-UP1 直链；安装动作我们只借它的 NSIS 分支（见 install）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
// electron-updater 是 **CJS**（导出挂在 defineProperty getter 上），而主进程产物是 ESM
// （package.json `type: module`）⇒ 具名 import 会在运行期炸「Named export 'autoUpdater' not found」
// （本批真机探针实测抓到，单测与 tsc 都照不出来）。取默认导入再解构：Node 给 ESM 的 default
// 就是 CJS 的 module.exports 本体，getter 语义（首次访问才挑 Updater 实现）原样保留。
import electronUpdater from 'electron-updater'
import { log } from './log'
import { relaunchApp } from './relaunchMain'
import {
  UPDATE_FEED_URL,
  replaceAppImage,
  resolveUpdateChannel,
  type DownloadedUpdate,
  type UpdateChannel,
  type UpdateEngine,
  type UpdateProgress,
} from './core/updatePlan'

const { autoUpdater } = electronUpdater

/**
 * electron-builder 给 deb/rpm/pacman 包写进 `resources/package-type` 的标记
 * （FpmTarget 产物）。读不到 = 不是这类包（AppImage/未打包）——**不猜**，交判据兜底。
 */
function readPackageType(resourcesPath: string | undefined): string | null {
  if (!resourcesPath) return null
  try {
    const value = fs.readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim()
    return value || null
  } catch {
    return null
  }
}

/** 本机更新形态（唯一判据在 core/updatePlan；这里只喂环境事实） */
export function currentUpdateChannel(): UpdateChannel {
  return resolveUpdateChannel({
    platform: process.platform,
    env: process.env,
    isPackaged: app.isPackaged,
    packageType: readPackageType(process.resourcesPath),
  })
}

let configured = false
/** 当前这次下载的进度出口（一次只有一个下载在跑） */
let progressSink: ((progress: UpdateProgress) => void) | null = null

function configure(): void {
  if (configured) return
  configured = true
  // 下载动作由用户在「我的 → 检查更新」页显式触发（不静默吃用户流量；110MB+ 的包）
  autoUpdater.autoDownload = false
  // 只有「退出并安装」才装：本条把语义钉成「手动确认安装」（设计 §五.5），
  // 否则用户只是正常退出，后台会把已下载的包顺手装上、下次启动版本就变了
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  // feed 逐字符 = 更新面（UPDATE_FEED_URL）；同时 electron-builder 也会把同一 URL
  // 写进 resources/app-update.yml，这里显式设置让运行期只认这一个常量（防双源）
  autoUpdater.setFeedURL(UPDATE_FEED_URL)
  autoUpdater.on('download-progress', (p) => {
    progressSink?.({
      phase: 'downloading',
      percent: Math.floor(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  })
  autoUpdater.on('error', (err) => {
    void log('error', `更新器错误: ${err instanceof Error ? err.message : String(err)}`)
  })
  void log('info', `应用内更新已就绪：形态=${currentUpdateChannel()}，feed=${UPDATE_FEED_URL}`)
}

/** 更新面的包取到本地（进度回流）；任何一步失败都如实抛，不留「半个可安装的包」 */
async function downloadFromFeed(
  onProgress: (progress: UpdateProgress) => void,
): Promise<DownloadedUpdate> {
  configure()
  progressSink = onProgress
  try {
    const checked = await autoUpdater.checkForUpdates()
    if (!checked) {
      throw new Error('更新服务不可用（未打包实例不支持应用内更新）')
    }
    const info = checked.updateInfo
    if (!checked.isUpdateAvailable) {
      throw new Error(`更新面还没有比 v${app.getVersion()} 更新的版本（最新 v${info.version}），请稍后重试`)
    }
    const files = await autoUpdater.downloadUpdate()
    const file = files[0]
    if (!file) throw new Error('更新包下载完成，但没拿到落盘路径')
    return { file, sha512: info.sha512, version: info.version }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`更新包下载失败：${msg}（下载未完成，可重试）`)
  } finally {
    progressSink = null
  }
}

/** 安装（进程会退出，调用方不再回来） */
function install(channel: UpdateChannel, file: string): void {
  if (channel === 'nsis') {
    // NSIS：交 electron-builder 自己的安装器协议（`--updated` + 退出后由安装器接管）。
    // quitAndInstall(isSilent=false) 时 Electron-updater 会把第二参替换成 autoRunAppAfterInstall=true
    // ⇒ 装完自动拉起新版本（源码 BaseUpdater.install:16）；退出走 app.quit() 正常路径，
    // index.ts 的 before-quit 置位 / will-quit 的插件 dispose 与热键注销照跑。
    autoUpdater.quitAndInstall()
    return
  }
  // AppImage：取 env.APPIMAGE 本体**原地同名覆盖**（判据在 core/updatePlan.replaceAppImage），
  // 然后走 v2.6 批 2 的既有重启通道（app.relaunch({execPath: APPIMAGE, args}) + app.quit()）——
  // 不另造第二套重启；也顺手保住了 linux.executableArgs 那串启动参数（electron-updater 自己
  // 的 AppImageUpdater 是用空参数 spawn 新实例的）。
  const appImage = process.env.APPIMAGE
  if (!appImage) throw new Error('APPIMAGE 环境变量缺失：无法定位要替换的 AppImage 本体')
  replaceAppImage(file, appImage)
  void log('info', `AppImage 已替换为 ${file} → ${appImage}，准备重启`)
  relaunchApp()
}

/** 真实引擎（updater.ts 缺省走它） */
export function createUpdateEngine(): UpdateEngine {
  return {
    channel: currentUpdateChannel(),
    download: downloadFromFeed,
    install: (file: string) => install(currentUpdateChannel(), file),
  }
}