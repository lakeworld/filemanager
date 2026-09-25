/**
 * 行业文件夹模板（v2.6.1 B17）：8 款内置词表 + 五列全等判定 + 新建弹窗 placeholder 派生。
 *
 * 纯数据 + 纯函数（不 import 任何 node/electron 模块）——渲染层与 `tests/unit` 都能直接引用。
 * 边界（PLAN §一 已拍，越界即出本卡范围）：
 *  - **只含五张子文件夹清单**（image / cert / doc / customer / supplier）。一级域名（产品集/图包/证书/
 *    文档/客户/供应商）是 paths.ts 硬常量 + 插件契约（ensureSubfolder 授权写路径），模型上不存在；
 *  - 换模板只影响"以后新建实体建哪些文件夹"，存量实体零触碰；
 *  - 判定是**全等**（含顺序），不是子集——手改任意一张清单就该落回 none（界面显示「自定义」）。
 */
import type { IndustryTemplate, WorkspaceConfig } from './types'

/** 未命中模板 / 模板没给例时的兜底 placeholder（PLAN §五.5） */
export const FALLBACK_PLACEHOLDER = '如：产品/项目名称'

/**
 * 默认供应商子文件夹（词表与主进程 `paths.ts` 的 SUPPLIER_SUBFOLDERS 同源）。
 * §四 表里「同默认」两处（销售 / 医药）直接引用本常量，不重抄字面量——单测另钉它与主进程一致，
 * 防出第二处漂移源。
 */
export const DEFAULT_SUPPLIER_SUBFOLDERS: string[] = ['合同', '对账单', '往来文件']

/**
 * 8 款内置模板（词表 = PLAN §四 定稿）。
 * ⚠ 电商款五张清单必须**逐字等于**主进程 `paths.ts defaultWorkspaceConfig()`：
 * 所有老工作区一开设置页，徽标就靠这条判成「内置 · 电商」；差一个字全老用户都会看到「自定义」
 * （`tests/unit/industryTemplates.test.ts` 钉死）。
 */
export const BUILTIN_TEMPLATES: IndustryTemplate[] = [
  {
    id: 'general',
    name: '通用',
    image_subfolders: ['图片', '素材'],
    cert_subfolders: ['资质', '检测'],
    doc_subfolders: ['资料'],
    customer_subfolders: ['合同', '沟通'],
    supplier_subfolders: ['合同', '往来文件'],
    example: FALLBACK_PLACEHOLDER,
  },
  {
    id: 'ecommerce',
    name: '电商',
    image_subfolders: ['主图', '详情页', '白底图', '素材'],
    cert_subfolders: ['3C', '质检', '专利'],
    doc_subfolders: ['说明书', '参数表', '质检报告'],
    customer_subfolders: ['报价', '合同', '沟通', '其他'],
    supplier_subfolders: [...DEFAULT_SUPPLIER_SUBFOLDERS],
    example: '如：夏季T恤系列',
  },
  {
    id: 'sales',
    name: '销售',
    image_subfolders: ['产品图', '宣传图', '案例图', '素材'],
    cert_subfolders: ['资质', '授权书', '检测报告'],
    doc_subfolders: ['方案书', '合同', '交付资料'],
    customer_subfolders: ['报价', '合同', '沟通', '其他'],
    supplier_subfolders: [...DEFAULT_SUPPLIER_SUBFOLDERS],
  },
  {
    id: 'trade',
    name: '外贸',
    image_subfolders: ['产品图', '包装设计', '宣传素材'],
    cert_subfolders: ['认证', '检测报告', '授权'],
    doc_subfolders: ['报关资料', '装箱单', '合同'],
    customer_subfolders: ['报价', '合同', '单证', '沟通'],
    supplier_subfolders: ['合同', '对账单', '出货文件'],
  },
  {
    id: 'medical',
    name: '医药',
    image_subfolders: ['包装图', '样品图', '宣传物料'],
    cert_subfolders: ['注册批件', '生产许可', 'GMP'],
    doc_subfolders: ['说明书', '质量标准', '检验报告'],
    customer_subfolders: ['资质', '合同', '回款', '沟通'],
    supplier_subfolders: [...DEFAULT_SUPPLIER_SUBFOLDERS],
    example: '如：阿莫西林胶囊',
  },
  {
    id: 'hardware',
    name: '制造·五金',
    image_subfolders: ['产品图', '图纸', '工艺图', '样品图'],
    cert_subfolders: ['检测报告', '材质证明', '认证'],
    doc_subfolders: ['图纸', '工艺文件', '质检报告'],
    customer_subfolders: ['报价', '合同', '订单', '沟通'],
    supplier_subfolders: ['合同', '对账单', '来料检验'],
  },
  {
    id: 'design',
    name: '设计·广告',
    image_subfolders: ['成品图', '案例图', '灵感素材'],
    cert_subfolders: ['资质', '版权登记'],
    doc_subfolders: ['提案', '合同', '交付物'],
    customer_subfolders: ['合同', '沟通', '交付', '反馈'],
    supplier_subfolders: ['合同', '外包结算', '往来文件'],
  },
  {
    id: 'food',
    name: '食品',
    image_subfolders: ['包装图', '样品图', '宣传物料'],
    cert_subfolders: ['生产许可', '检验报告', '认证'],
    doc_subfolders: ['配料表', '执行标准', '检验报告'],
    customer_subfolders: ['报价', '合同', '回款', '沟通'],
    supplier_subfolders: ['合同', '对账单', '来料质检'],
  },
]

/** 匹配结果：内置优先于自定义；全不中 = none（界面显示「自定义」） */
export interface TemplateMatch {
  kind: 'builtin' | 'custom' | 'none'
  template?: IndustryTemplate
}

/** 五张清单按同一顺序取出（判定与预览共用，防两处各写一份列序） */
export function fiveListsOf(t: IndustryTemplate): string[][] {
  return [t.image_subfolders, t.cert_subfolders, t.doc_subfolders, t.customer_subfolders, t.supplier_subfolders]
}

/** 配置侧五张清单（缺省键按空清单读——旧 config 在 loadConfig 合并前的形状） */
export function fiveListsOfConfig(cfg: WorkspaceConfig): string[][] {
  return [
    cfg.image_subfolders ?? [],
    cfg.cert_subfolders ?? [],
    cfg.doc_subfolders ?? [],
    cfg.customer_subfolders ?? [],
    cfg.supplier_subfolders ?? [],
  ]
}

/** 五列**全等**（含顺序） */
function fiveListsEqual(a: string[][], b: string[][]): boolean {
  for (let i = 0; i < 5; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.length !== y.length) return false
    for (let j = 0; j < x.length; j += 1) if (x[j] !== y[j]) return false
  }
  return true
}

/**
 * 当前配置命中哪套模板（派生，不往 config 存"当前模板 id"——避免双源）。
 * 内置优先于自定义；`null`（config 尚未加载）判 none——调用方若在加载前渲染，界面应 gate 到加载后。
 */
export function matchTemplate(cfg: WorkspaceConfig | null | undefined): TemplateMatch {
  if (!cfg) return { kind: 'none' }
  const target = fiveListsOfConfig(cfg)
  for (const t of BUILTIN_TEMPLATES) {
    if (fiveListsEqual(fiveListsOf(t), target)) return { kind: 'builtin', template: t }
  }
  for (const t of cfg.custom_templates ?? []) {
    if (fiveListsEqual(fiveListsOf(t), target)) return { kind: 'custom', template: t }
  }
  return { kind: 'none' }
}

/** 新建产品集弹窗 placeholder：命中模板取其 example，未命中/无例回通用例 */
export function placeholderFor(cfg: WorkspaceConfig | null | undefined): string {
  const t = matchTemplate(cfg).template
  return t?.example ?? FALLBACK_PLACEHOLDER
}

/** 当前模板的展示名（未命中 = 「自定义」）；设置页徽标与新建弹窗提示块共用同一口径 */
export function currentTemplateLabel(cfg: WorkspaceConfig | null | undefined): string {
  return matchTemplate(cfg).template?.name ?? '自定义'
}