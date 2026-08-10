/**
 * 全局搜索（对照原 Go search.go）
 * 纯 TS 业务层。
 * v2.4.4（T1）：搜索命中标签——产品集与文件的 tags 参与关键词匹配；
 * 文件侧经 metadata 内存缓存按路径 join（不重建文件索引），命中条目附带 tags 供展示。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { PRODUCT_SETS_DIR, IMAGES_DIR, CERTS_DIR } from './paths'
import { WorkspaceService, countFiles, formatTime, ProductSetInfo } from './workspace'
import { MetadataService } from './metadata'
import { FilesService, FileEntry } from './files'
import type { SearchResult } from '../../shared/types'

export type { SearchResult } from '../../shared/types'

export class SearchService {
  constructor(
    private workspace: WorkspaceService,
    private files: FilesService,
    private metadata: MetadataService,
  ) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  async search(query: string): Promise<SearchResult> {
    const ws = this.requireWS()
    const q = query.toLowerCase().trim()
    const result: SearchResult = { files: [], product_sets: [] }
    if (!q) return result
    const seenSet = new Set<string>()

    const setsDir = path.join(ws, PRODUCT_SETS_DIR)
    const entries = await fsp.readdir(setsDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])

    // v2.4.4（T1）：一次性读元数据缓存与产品集标签，构建 文件路径 → tags 索引（内存命中，不重建文件索引）
    const [store, extra] = await Promise.all([this.metadata.loadMetadataStore(), this.workspace.loadProductSetsInfo()])
    const tagsByKey = new Map<string, string[]>()
    for (const [key, meta] of Object.entries(store.files)) {
      if (meta.tags && meta.tags.length > 0) tagsByKey.set(key, meta.tags)
    }

    const setTags = (name: string): string[] => extra[name]?.tags ?? []
    const fileTags = (f: FileEntry): string[] => {
      const key = this.metadata.fileMetadataKey(f.path)
      return key ? tagsByKey.get(key) ?? [] : []
    }
    const tagHit = (tags: string[]): boolean => tags.some((t) => t.toLowerCase().includes(q))

    for (const set of entries) {
      if (!set.isDirectory()) continue
      const setName = set.name
      const setMatched = setName.toLowerCase().includes(q) || tagHit(setTags(setName))

      const buildSetInfo = async (): Promise<ProductSetInfo> => {
        const [info, imgCount, certCount] = await Promise.all([
          fsp.stat(path.join(setsDir, setName)),
          countFiles(path.join(setsDir, setName, IMAGES_DIR)),
          countFiles(path.join(setsDir, setName, CERTS_DIR)),
        ])
        return {
          name: setName,
          image_count: imgCount,
          cert_count: certCount,
          created_at: formatTime(info.mtime),
          tags: setTags(setName),
          notes: extra[setName]?.notes ?? '',
        }
      }

      if (setMatched) {
        result.product_sets.push(await buildSetInfo())
        seenSet.add(setName)
      }

      const [imgFiles, certFiles] = await Promise.all([
        this.files.listDirFilesRecursive(path.join(setsDir, setName, IMAGES_DIR)),
        this.files.listDirFilesRecursive(path.join(setsDir, setName, CERTS_DIR)),
      ])
      for (const f of [...imgFiles, ...certFiles]) {
        const tags = fileTags(f)
        if (f.name.toLowerCase().includes(q) || tagHit(tags)) {
          if (tags.length > 0) f.tags = tags
          result.files.push(f)
          if (!seenSet.has(setName)) {
            result.product_sets.push(await buildSetInfo())
            seenSet.add(setName)
          }
        }
      }
    }
    return result
  }
}
