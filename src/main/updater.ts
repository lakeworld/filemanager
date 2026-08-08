/**
 * 自动更新（对照原 Go internal/updater）
 * 阶段 8 完善：保留 /version.json 检查机制。当前提供版本检查与下载的骨架。
 */
export interface UpdateInfo {
  version: string
  download_url: string
  checksum: string
  release_notes: string
}

/** 检查更新：从 /version.json 拉取最新版本信息，无更新返回 null */
export async function checkUpdate(_currentVersion: string): Promise<UpdateInfo | null> {
  // TODO(阶段8): 读取发布源 /version.json 并对比版本
  return null
}

export async function downloadUpdate(_info: UpdateInfo): Promise<string> {
  throw new Error('更新下载尚未就绪')
}

export async function applyUpdate(_installerPath: string, _checksum: string): Promise<void> {
  throw new Error('更新安装尚未就绪')
}
