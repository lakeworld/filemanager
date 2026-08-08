/**
 * 文件元数据（对照原 Go metadata.go）
 * 纯 TS 业务层：key 格式 `产品集/文件名` 与原实现一致。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { metadataPath, writeJsonAtomic, ensureWorkspaceDirs } from './paths'
import { WorkspaceService } from './workspace'

export interface FileMetadata {
  cert_type: string
  expiry_date: string
  tags: string[]
  notes: string
  added_at: string
}

interface MetadataStore {
  files: Record<string, FileMetadata>
}

function emptyMetadata(): FileMetadata {
  return { cert_type: '', expiry_date: '', tags: [], notes: '', added_at: '' }
}

export interface MetadataUpdateRequest {
  product_set: string
  file_name: string
  cert_type?: string
  expiry_date?: string
  tags?: string[]
  notes?: string
}

export function currentTimeString(): string {
  return new Date().toISOString()
}

export class MetadataService {
  /** 内存缓存：按工作区路径缓存 store，避免大 metadata.json 反复全量解析 */
  private cache = new Map<string, MetadataStore>()

  constructor(private workspace: WorkspaceService) {}

  private requireWS(): string {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    return ws
  }

  /** 读取元数据存储；损坏时自动备份原文件并降级为空库（稳定性增强，原 Go 无备份） */
  async loadMetadataStore(ws?: string): Promise<MetadataStore> {
    const w = ws ?? this.requireWS()
    const hit = this.cache.get(w)
    if (hit) return hit
    const store = await this.readFromDisk(w)
    this.cache.set(w, store)
    return store
  }

  private async readFromDisk(w: string): Promise<MetadataStore> {
    const p = metadataPath(w)
    let raw: string
    try {
      raw = await fsp.readFile(p, 'utf-8')
    } catch {
      return { files: {} } // 文件不存在视为空库
    }
    try {
      const parsed = JSON.parse(raw) as MetadataStore
      if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
        return parsed
      }
      throw new Error('结构非法')
    } catch {
      // 损坏：备份原文件（不丢数据），降级为空库
      try {
        await fsp.copyFile(p, `${p}.corrupt-${Date.now()}`)
      } catch {
        // 备份失败不阻断
      }
      return { files: {} }
    }
  }

  async saveMetadataStore(store: MetadataStore, ws?: string): Promise<void> {
    const w = ws ?? this.requireWS()
    // 写入时同步更新缓存，保持读一致性
    this.cache.set(w, store)
    ensureWorkspaceDirs(w)
    await writeJsonAtomic(metadataPath(w), store)
  }

  fileMetadataKey(productSet: string, fileName: string): string {
    return path.join(productSet, fileName)
  }

  async get(productSet: string, fileName: string): Promise<FileMetadata> {
    this.requireWS()
    const store = await this.loadMetadataStore()
    const meta = store.files[this.fileMetadataKey(productSet, fileName)]
    if (!meta) return emptyMetadata()
    return meta
  }

  async update(req: MetadataUpdateRequest): Promise<void> {
    const ws = this.requireWS()
    const store = await this.loadMetadataStore()
    const key = this.fileMetadataKey(req.product_set, req.file_name)
    const existing = store.files[key] ?? emptyMetadata()
    if (!existing.added_at) existing.added_at = currentTimeString()
    existing.cert_type = (req.cert_type ?? '').trim()
    existing.expiry_date = (req.expiry_date ?? '').trim()
    existing.tags = req.tags ?? []
    existing.notes = (req.notes ?? '').trim()
    store.files[key] = existing
    await this.saveMetadataStore(store, ws)
  }

  async setFileMetadata(productSet: string, fileName: string, meta: FileMetadata): Promise<void> {
    const ws = this.requireWS()
    const store = await this.loadMetadataStore()
    store.files[this.fileMetadataKey(productSet, fileName)] = meta
    await this.saveMetadataStore(store, ws)
  }

  async removeFileMetadata(productSet: string, fileName: string): Promise<void> {
    const ws = this.requireWS()
    const store = await this.loadMetadataStore()
    const key = this.fileMetadataKey(productSet, fileName)
    if (!store.files[key]) return
    delete store.files[key]
    await this.saveMetadataStore(store, ws)
  }

  async removeFileMetadataForProductSet(productSet: string): Promise<void> {
    const ws = this.requireWS()
    const store = await this.loadMetadataStore()
    const prefix = productSet + path.sep
    let changed = false
    for (const key of Object.keys(store.files)) {
      if (key.startsWith(prefix)) {
        delete store.files[key]
        changed = true
      }
    }
    if (!changed) return
    await this.saveMetadataStore(store, ws)
  }
}
