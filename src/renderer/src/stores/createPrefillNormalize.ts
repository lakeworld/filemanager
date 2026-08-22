/**
 * 全业务新建预填载荷归一化（PLAN-v2.5.4 §3.3，纯 TS 零依赖，tests/unit 直测）。
 *
 * 规则：已知键通过（trim）、未知键忽略、枚举/类型非法丢键、批量单批 ≤ PREFILL_BATCH_CAP、
 * 自然键去重（保留先出现者；缺键条目保留）。**只归一化，不校验业务必填**——
 * 保存时仍走各实体既有 create 校验（预填只是填表单，不绕过任何校验）。
 */

/** 单批上限（P1-2 拍板） */
export const PREFILL_BATCH_CAP = 50

export type PrefillEntity = 'customer' | 'productSet' | 'supplier' | 'quote' | 'invoice' | 'inbound'

export interface CustomerPrefill {
  name?: string
  alias?: string
  country?: string
  contact?: string
  source?: string
  /** 仅「企业/个人」（对齐 core clients type 枚举） */
  type?: string
  phone?: string
  email?: string
  address?: string
  tags?: string[]
  notes?: string
  related_product_sets?: string[]
}

export interface ProductSetPrefill {
  name?: string
  tags?: string[]
  notes?: string
}

export interface SupplierPrefill {
  name?: string
  contact?: string
  phone?: string
  email?: string
  address?: string
  notes?: string
  tags?: string[]
  related_product_sets?: string[]
}

export interface QuoteLinePrefill {
  product?: string
  sku?: string
  qty?: number
  unit_price?: number
}

export interface QuotePrefill {
  quotation_no?: string
  date?: string
  customer?: string
  lines?: QuoteLinePrefill[]
  notes?: string
  file_path?: string
}

export interface InvoicePrefill {
  number?: string
  code?: string
  date?: string
  amount?: number
  seller?: string
  buyer?: string
  customer?: string
  due_date?: string
  file_path?: string
  tags?: string[]
  notes?: string
}

export interface InboundPrefill {
  id?: string
  date?: string
  supplier?: string
  supplier_id?: string
  product_set?: string
  amount?: number
  notes?: string
  file_path?: string
}

export type CreatePrefillPayload =
  | CustomerPrefill
  | ProductSetPrefill
  | SupplierPrefill
  | QuotePrefill
  | InvoicePrefill
  | InboundPrefill

/** 各实体去重自然键（P1-2） */
const NATURAL_KEY: Record<PrefillEntity, string> = {
  customer: 'name',
  productSet: 'name',
  supplier: 'name',
  quote: 'quotation_no',
  invoice: 'number',
  inbound: 'id',
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 字符串字段：string → trim → 非空才收；其余丢弃 */
function pickString(src: Record<string, unknown>, key: string, out: Record<string, unknown>): void {
  const v = src[key]
  if (typeof v !== 'string') return
  const t = v.trim()
  if (t) out[key] = t
}

/** 字符串数组字段：只收数组；元素非字符串/空丢弃；元素 trim */
function pickStringArray(src: Record<string, unknown>, key: string, out: Record<string, unknown>): void {
  const v = src[key]
  if (!Array.isArray(v)) return
  const arr = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  if (arr.length > 0) out[key] = arr
}

/** 数值字段：finite number 直收；数值字符串转换；其余丢弃（0 合法） */
function pickNumber(src: Record<string, unknown>, key: string, out: Record<string, unknown>): void {
  const v = src[key]
  if (typeof v === 'number' && Number.isFinite(v)) {
    out[key] = v
    return
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) out[key] = n
  }
}

const CUSTOMER_TYPES = new Set(['企业', '个人'])

function normalizeCustomer(src: Record<string, unknown>): CustomerPrefill {
  const out: Record<string, unknown> = {}
  for (const k of ['name', 'alias', 'country', 'contact', 'source', 'phone', 'email', 'address', 'notes']) {
    pickString(src, k, out)
  }
  const t = src.type
  if (typeof t === 'string' && CUSTOMER_TYPES.has(t.trim())) out.type = t.trim()
  pickStringArray(src, 'tags', out)
  pickStringArray(src, 'related_product_sets', out)
  return out as CustomerPrefill
}

function normalizeProductSet(src: Record<string, unknown>): ProductSetPrefill {
  const out: Record<string, unknown> = {}
  pickString(src, 'name', out)
  pickString(src, 'notes', out)
  pickStringArray(src, 'tags', out)
  return out as ProductSetPrefill
}

function normalizeSupplier(src: Record<string, unknown>): SupplierPrefill {
  const out: Record<string, unknown> = {}
  for (const k of ['name', 'contact', 'phone', 'email', 'address', 'notes']) pickString(src, k, out)
  pickStringArray(src, 'tags', out)
  pickStringArray(src, 'related_product_sets', out)
  return out as SupplierPrefill
}

function normalizeQuoteLine(line: unknown): QuoteLinePrefill | null {
  if (!isPlainObject(line)) return null
  const out: Record<string, unknown> = {}
  pickString(line, 'product', out)
  pickString(line, 'sku', out)
  pickNumber(line, 'qty', out)
  pickNumber(line, 'unit_price', out)
  return out as QuoteLinePrefill
}

function normalizeQuote(src: Record<string, unknown>): QuotePrefill {
  const out: Record<string, unknown> = {}
  for (const k of ['quotation_no', 'date', 'customer', 'notes', 'file_path']) pickString(src, k, out)
  if (Array.isArray(src.lines)) {
    // 非对象行丢弃（跳过），对象行保留（行内非法键丢键）
    const lines = src.lines.map(normalizeQuoteLine).filter((l): l is QuoteLinePrefill => l !== null)
    if (lines.length > 0) out.lines = lines
  }
  return out as QuotePrefill
}

function normalizeInvoice(src: Record<string, unknown>): InvoicePrefill {
  const out: Record<string, unknown> = {}
  for (const k of ['number', 'code', 'date', 'seller', 'buyer', 'customer', 'due_date', 'file_path', 'notes']) {
    pickString(src, k, out)
  }
  pickNumber(src, 'amount', out)
  pickStringArray(src, 'tags', out)
  // status 不在预填面：新建恒「待报销」（PLAN §3.1）
  return out as InvoicePrefill
}

function normalizeInbound(src: Record<string, unknown>): InboundPrefill {
  const out: Record<string, unknown> = {}
  for (const k of ['id', 'date', 'supplier', 'supplier_id', 'product_set', 'notes', 'file_path']) {
    pickString(src, k, out)
  }
  pickNumber(src, 'amount', out)
  return out as InboundPrefill
}

const NORMALIZERS: Record<PrefillEntity, (src: Record<string, unknown>) => CreatePrefillPayload> = {
  customer: normalizeCustomer,
  productSet: normalizeProductSet,
  supplier: normalizeSupplier,
  quote: normalizeQuote,
  invoice: normalizeInvoice,
  inbound: normalizeInbound,
}

/** 单条归一化：非对象输入返回空对象；非法 entity 抛 TypeError（编程错误早暴露） */
export function normalizePrefill(entity: PrefillEntity, input: unknown): CreatePrefillPayload {
  const fn = NORMALIZERS[entity]
  if (!fn) throw new TypeError(`未知预填实体: ${String(entity)}`)
  if (!isPlainObject(input)) return {}
  return fn(input)
}

/** 批量归一化：非数组包装为单条；非对象条目跳过；>CAP 截断；自然键去重（缺键保留） */
export function normalizePrefillBatch(entity: PrefillEntity, input: unknown): CreatePrefillPayload[] {
  const fn = NORMALIZERS[entity]
  if (!fn) throw new TypeError(`未知预填实体: ${String(entity)}`)
  const list = (Array.isArray(input) ? input : [input]).filter(isPlainObject).slice(0, PREFILL_BATCH_CAP)
  const key = NATURAL_KEY[entity]
  const seen = new Set<string>()
  const out: CreatePrefillPayload[] = []
  for (const item of list) {
    const normalized = fn(item) as Record<string, unknown>
    const k = normalized[key]
    if (typeof k === 'string' && k) {
      if (seen.has(k)) continue
      seen.add(k)
    }
    out.push(normalized as CreatePrefillPayload)
  }
  return out
}

/**
 * 编辑预填归一化（v2.5.4 弹一 C-6，`ui.openEditPrefill`）：单条制（不批量、不去重），
 * payload = 「建议改动」字段（与 create 同 schema；是否含自然键均可，原值由弹窗按 key 加载后覆盖）。
 * 非法 entity 抛 TypeError（编程错误早暴露）。**只归一化不校验**——保存仍走各实体既有 edit 校验。
 */
export function normalizeEditPrefill(entity: PrefillEntity, input: unknown): CreatePrefillPayload {
  const fn = NORMALIZERS[entity]
  if (!fn) throw new TypeError(`未知预填实体: ${String(entity)}`)
  if (!isPlainObject(input)) return {}
  return fn(input)
}

/** 各实体编辑自然键（C-6：客户/供应商/产品集 = name，报价 = quotation_no，发票 = number，入库 = id） */
export const EDIT_NATURAL_KEY: Record<PrefillEntity, string> = NATURAL_KEY
