/**
 * BoxService：业务层组装（对应原 Go App 的高层 API 面）
 * 纯 TS：不 import electron，可在 node 环境直接测试。
 *
 * 依赖注入：
 * - ThumbnailProvider（缩略图）由 main 层提供（sharp 实现）
 * - 平台能力（剪贴板/资源管理器/默认应用打开/对话框）不属于 core，由 main 层 ipc 直接处理
 */
import { WorkspaceService } from './workspace'
import type { ProductSetInfo } from './workspace'
import { MetadataService } from './metadata'
import { FilesService, ThumbnailProvider } from './files'
import { DashboardService } from './dashboard'
import { SearchService } from './search'
import { XlsxService } from './xlsx'
import { PRODUCT_SETS_DIR, CUSTOMERS_DIR, SUPPLIERS_DIR, isPathInsideWorkspaceReal, classifyFileType } from './paths'
import { TagService } from './tags'
import { TrashService } from './trash'
import { ArchiveService } from './archive'
import { InvoicesService } from './invoices'
import { InboundService } from './inbound'
import { ExchangeService } from './exchange'
import { ClientsService } from './clients'
import { SuppliersService } from './suppliers'
import { QuotesService } from './quotes'
import type { Logger } from './logger'
import path from 'node:path'
import fsp from 'node:fs/promises'

export class BoxService {
  workspace: WorkspaceService
  metadata: MetadataService
  files: FilesService
  dashboard: DashboardService
  search: SearchService
  xlsx: XlsxService
  tags: TagService
  trash: TrashService
  archive: ArchiveService
  /** v2.4.7：发票台账（PLAN §6） */
  invoices: InvoicesService
  /** v2.4.7：客户维度（客户/ 目录 + customers.json 档案，PLAN §5） */
  clients: ClientsService
  /** v2.4.9 S2：供应商维度（供应商/ 目录 + suppliers.json 档案，镜像客户范式） */
  suppliers: SuppliersService
  /** v2.4.9 S3：报价单台账（报价.json + 报价/<YYYY>/ 归档，对齐客迹 keji Quotation） */
  quotes: QuotesService
  /** v2.4.7：入库单（PLAN §7） */
  inbound: InboundService
  /** v2.4.7：交换区投递（PLAN §8）——文件归集内置；发票/入库台账经 ledger sink 接入（见构造器） */
  exchange: ExchangeService
  private thumbs: ThumbnailProvider

  constructor(thumbs: ThumbnailProvider, workspace?: WorkspaceService, logger?: Logger) {
    this.workspace = workspace ?? new WorkspaceService()
    this.metadata = new MetadataService(this.workspace)
    this.clients = new ClientsService(this.workspace)
    // v2.4.9 S2：供应商服务注入 Logger（S6 core 接口；测试传 MemoryLogger 断言）
    this.suppliers = new SuppliersService(this.workspace, logger)
    // v2.4.9 S3：报价服务注入 Logger（S6 core 接口；测试传 MemoryLogger 断言）
    this.quotes = new QuotesService(this.workspace, logger)
    this.trash = new TrashService(this.workspace, this.metadata, thumbs, this.clients, this.suppliers)
    this.files = new FilesService(this.workspace, this.metadata, thumbs, this.trash)
    this.dashboard = new DashboardService(this.workspace, this.metadata, this.files)
    this.search = new SearchService(this.workspace, this.files, this.metadata)
    this.xlsx = new XlsxService(this.workspace)
    this.invoices = new InvoicesService(this.workspace, this.trash, this.xlsx)
    this.inbound = new InboundService(this.workspace, this.trash)
    // v2.4.7（§8.2）：交换区 ledger sink 由台账服务提供——查重等账务规则单点落在台账服务
    // （PLAN §6.2「创建/编辑/交换区三入口同函数」）；投递发票默认状态 待报销（§6.3 流转起点）
    this.exchange = new ExchangeService(this.workspace, {
      createInvoice: async (d, archived) => {
        await this.invoices.create({
          number: d.number,
          code: d.code,
          date: d.date,
          amount: d.amount,
          seller: d.seller,
          buyer: d.buyer,
          customer: d.customer,
          due_date: d.due_date,
          status: '待报销',
          file_path: archived[0] ?? '',
        })
      },
      createInbound: async (d, archived) => {
        await this.inbound.create({
          id: d.id,
          date: d.date,
          supplier: d.supplier,
          product_set: d.product_set,
          amount: d.amount,
          notes: d.notes,
          file_path: archived[0] ?? '',
        })
      },
    })
    this.tags = new TagService(this.workspace, this.metadata)
    this.archive = new ArchiveService(this.workspace)
    this.thumbs = thumbs
    // v2.4.7（§5.1）：发票台账标签引用源注册——rename/delete/adopt/计数自动覆盖，无手写传播
    this.tags.registerSource('invoices', {
      id: 'invoices',
      list: () => this.invoices.listTagEntries(),
      save: (entries) => this.invoices.saveTagEntries(entries),
    })
    // v2.4.7（§5.1）：客户标签引用源注册——rename/delete/adopt/计数自动覆盖（tags.ts T7 投资的兑现）
    this.tags.registerSource('customers', {
      id: 'customers',
      list: async () => {
        const store = await this.clients.loadCustomersInfo()
        return Object.entries(store).map(([name, ex]) => ({ name, tags: [...(ex.tags ?? [])] }))
      },
      save: async (entries) => {
        const ws = this.workspace.currentWorkspacePath()
        if (!ws) return
        const store = await this.clients.loadCustomersInfo()
        let changed = false
        for (const { name, tags } of entries) {
          const ex = store[name]
          if (!ex) continue
          if (JSON.stringify(ex.tags ?? []) !== JSON.stringify(tags)) {
            ex.tags = tags
            changed = true
          }
        }
        if (changed) await this.clients.saveCustomersInfo(ws, store)
      },
    })
  }

  async xlsxExportTemplate(filePath: string): Promise<void> {
    return this.xlsx.exportTemplate(filePath)
  }

  async xlsxImport(filePath: string): Promise<ProductSetInfo[]> {
    return this.xlsx.importProductSets(filePath)
  }

  /** 删除产品集（v2.3.1：移入回收站；目录移走即从列表消失，extra 保留供恢复后还原 tags/notes） */
  async deleteProductSet(name: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    const dir = path.join(ws, PRODUCT_SETS_DIR, name.trim())
    await fsp.stat(dir)
    await this.trash.trashItem(ws, dir, 'productSet')
  }

  /**
   * 删除客户（v2.4.7 §4.4：移入回收站，kind='customer'，仿 deleteProductSet 编排）。
   * customers.json 条目保留（恢复即复原）；彻底删除（purge）时由 TrashService 清理条目与元数据前缀。
   */
  async deleteCustomer(name: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    const dir = path.join(ws, CUSTOMERS_DIR, name.trim())
    await fsp.stat(dir)
    await this.trash.trashItem(ws, dir, 'customer')
  }

  /**
   * 删除供应商（v2.4.9 S2：移入回收站，kind='supplier'，仿 deleteCustomer 编排）。
   * suppliers.json 条目保留（恢复即复原）；彻底删除（purge）时由 TrashService 四清理
   * （目录 + metadata 前缀 + 缩略图 + 条目；inbound.supplier_id 留字面值不级联）。
   */
  async deleteSupplier(name: string): Promise<void> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    const dir = path.join(ws, SUPPLIERS_DIR, name.trim())
    await fsp.stat(dir)
    await this.trash.trashItem(ws, dir, 'supplier')
  }

  /**
   * 重命名供应商（v2.4.9 S2 编排）：目录迁移 + 档案 key 迁移（suppliers.rename），
   * 随后级联更新 inbound.supplier_id 名字引用（inbound.renameSupplierId；不校验存在性）。
   */
  async renameSupplier(oldName: string, newName: string): Promise<void> {
    await this.suppliers.rename(oldName, newName)
    await this.inbound.renameSupplierId(oldName.trim(), newName.trim())
  }

  /**
   * 重命名客户（v2.4.9 S3 编排）：目录迁移 + 档案 key 迁移（clients.rename），
   * 随后级联更新报价台账 customer 名字引用（quotes.renameCustomer；幂等，不校验存在性）。
   * ipc.ts 的 qihebox:clients:rename 改调本包装在 S3b 做（本任务只加 core 编排）。
   */
  async renameCustomer(oldName: string, newName: string): Promise<void> {
    await this.clients.rename(oldName, newName)
    await this.quotes.renameCustomer(oldName.trim(), newName.trim())
  }

  /** 确保图片/PDF 缩略图存在（缺失自动生成，mtime 命中直接返回），返回缩略图路径 */
  async ensureThumbnailFor(filePath: string, origin: 'browse' | 'background' = 'browse'): Promise<string> {
    const ws = this.workspace.currentWorkspacePath()
    if (!ws) throw new Error('未打开工作区')
    if (!(await isPathInsideWorkspaceReal(ws, filePath))) throw new Error('只能访问工作区内的文件')
    const t = classifyFileType(filePath)
    if (t !== 'image' && t !== 'pdf') return ''
    return this.thumbs.ensureThumbnail(filePath, origin)
  }

  /**
   * v2.4.2（修复 2）：切文件夹入口调用——作废所有排队中的浏览缩略图任务，
   * 旧文件夹积压立即清空，新文件夹请求优先拿到生成槽位（根治切文件夹后图片长时间不渲染）。
   */
  beginBrowse(): void {
    this.thumbs.cancelPendingBrowse?.()
  }

  // —— v2.4.4：视频帧缩略图（能力由 ThumbnailProvider 可选方法提供）——

  videoThumbPathFor(filePath: string): string {
    return this.thumbs.videoThumbPath?.(filePath) ?? ''
  }

  async saveVideoFrame(filePath: string, data: Buffer): Promise<string> {
    const t = classifyFileType(filePath)
    if (t !== 'video') return ''
    // v2.4.6：修复脱绑调用（旧写法 const fn = this.thumbs.saveVideoFrame; fn(...) 丢失 this，
    // SharpThumbnailService 方法内部依赖 this.workspace → 缓存写入一直静默失败，每次访问重抓帧）
    return this.thumbs.saveVideoFrame ? this.thumbs.saveVideoFrame(filePath, data) : ''
  }

  async videoThumbnail(filePath: string): Promise<string> {
    const t = classifyFileType(filePath)
    if (t !== 'video') return ''
    // v2.4.6：同上修复脱绑调用（缓存读取静默失败 → mtime 命中永不生效）
    return this.thumbs.videoThumbnail ? this.thumbs.videoThumbnail(filePath) : ''
  }

  /** v2.4.6：图片预览降采样副本（能力由 ThumbnailProvider 可选方法提供；IPC 层已做工作区边界校验） */
  async ensurePreviewFor(filePath: string): Promise<string> {
    if (classifyFileType(filePath) !== 'image') return ''
    return this.thumbs.ensurePreview ? this.thumbs.ensurePreview(filePath) : ''
  }
}
