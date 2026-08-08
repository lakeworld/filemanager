import type { ThumbnailProvider } from '../../src/main/core/files'
import { WorkspaceService } from '../../src/main/core/workspace'
import { MetadataService } from '../../src/main/core/metadata'
import { FilesService } from '../../src/main/core/files'
import { BoxService } from '../../src/main/core'

/** 测试用假缩略图实现：不生成真实缩略图 */
export class FakeThumbs implements ThumbnailProvider {
  async ensureThumbnail(): Promise<string> {
    return ''
  }
  async thumbnailUrl(): Promise<string> {
    return ''
  }
  async removeThumbnail(): Promise<void> {}
  async removeThumbnailsInDir(): Promise<void> {}
}

/** 组装完整业务服务（测试用，homeDir 注入临时目录） */
export function buildTestBox(homeDir: string): BoxService {
  const workspace = new WorkspaceService(homeDir)
  return new BoxService(new FakeThumbs(), workspace)
}

export { WorkspaceService, MetadataService, FilesService }
