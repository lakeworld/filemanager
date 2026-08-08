/**
 * 全局搜索（对照原 Go search.go）
 * 纯 TS 业务层。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { PRODUCT_SETS_DIR, IMAGES_DIR, CERTS_DIR } from './paths'
import { WorkspaceService, countFiles, formatTime, ProductSetInfo } from './workspace'
import { FilesService, FileEntry } from './files'

export interface SearchResult {
  files: FileEntry[]
  product_sets: ProductSetInfo[]
}

export class SearchService {
  constructor(
    private workspace: WorkspaceService,
    private files: FilesService,
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

    for (const set of entries) {
      if (!set.isDirectory()) continue
      const setName = set.name
      const setMatched = setName.toLowerCase().includes(q)

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
          tags: [],
          notes: '',
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
        if (f.name.toLowerCase().includes(q)) {
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
