/**
 * 全业务新建/编辑通用预填 store（PLAN-v2.5.4 §3.3 + 弹一 C-6）。
 *
 * 链路：preload `ui.openCreatePrefill` / `ui.openEditPrefill` → window CustomEvent → 本 store
 * normalize/入队/导航 → 目标页 `createEffect` 消费（填表单 + 开弹窗）。
 * 新建：批量逐条（创建成功 `advance`、取消 `clear`）；编辑：单条制（key + 建议改动，开弹窗后 clear）。
 *
 * 永不自动建档（Q4 克制原则）：本 store 只填表单，建档/保存始终由用户在弹窗手点确认。
 */
import { createSignal } from 'solid-js'
import {
  normalizeEditPrefill,
  normalizePrefillBatch,
  type CreatePrefillPayload,
  type PrefillEntity,
} from './createPrefillNormalize'

/** 内部传输事件名（实现细节，不进公开契约；preload/index.ts 同名） */
const EVENT_NAME = 'qihebox:ui:open-create-prefill'

/** v2.5.4（弹一 C-6）：编辑预填内部传输事件名（preload/index.ts 同名） */
const EDIT_EVENT_NAME = 'qihebox:ui:open-edit-prefill'

/** v2.5.7（协议增量 E3）：openEntity 导航桥内部传输事件名（preload/index.ts 同名） */
const OPEN_ENTITY_EVENT_NAME = 'qihebox:ui:open-entity'

/** 实体 → 新建入口路由（PLAN §二 落点表） */
const ENTITY_ROUTE: Record<PrefillEntity, string> = {
  customer: '/clients',
  productSet: '/product-sets',
  supplier: '/suppliers',
  quote: '/quotes',
  invoice: '/invoices',
  inbound: '/invoices',
}

/** 实体 → 编辑入口路由（v2.5.4 弹一 C-6；key = 自然键；detail 页承载编辑弹窗，invoice/inbound 回列表页） */
const ENTITY_EDIT_ROUTE: Record<PrefillEntity, (key: string) => string> = {
  customer: (k) => `/clients/${encodeURIComponent(k)}`,
  productSet: (k) => `/product-sets/${encodeURIComponent(k)}`,
  supplier: (k) => `/suppliers/${encodeURIComponent(k)}`,
  quote: (k) => `/quotes/${encodeURIComponent(k)}`,
  invoice: () => '/invoices',
  inbound: () => '/invoices',
}

/** v2.5.7（协议增量 E3）：openEntity 导航桥路由——有详情页的实体去详情（key 定位），invoice/inbound 回列表页 */
const ENTITY_OPEN_ROUTE: Record<PrefillEntity, (key: string) => string> = {
  customer: (k) => `/clients/${encodeURIComponent(k)}`,
  productSet: (k) => `/product-sets/${encodeURIComponent(k)}`,
  supplier: (k) => `/suppliers/${encodeURIComponent(k)}`,
  quote: (k) => `/quotes/${encodeURIComponent(k)}`,
  invoice: () => '/invoices',
  inbound: () => '/invoices',
}

interface PrefillState {
  queue: CreatePrefillPayload[]
  version: number
}

const states = new Map<PrefillEntity, ReturnType<typeof createSignal<PrefillState>>>()

function stateOf(entity: PrefillEntity) {
  let s = states.get(entity)
  if (!s) {
    s = createSignal<PrefillState>({ queue: [], version: 0 })
    states.set(entity, s)
  }
  return s
}

// —— 编辑预填（C-6）：单条制，key + 建议改动 ——

export interface EditPrefillState {
  key: string
  payload: CreatePrefillPayload
  version: number
}

const editStates = new Map<PrefillEntity, ReturnType<typeof createSignal<EditPrefillState>>>()

function editStateOf(entity: PrefillEntity) {
  let s = editStates.get(entity)
  if (!s) {
    s = createSignal<EditPrefillState>({ key: '', payload: {}, version: 0 })
    editStates.set(entity, s)
  }
  return s
}

let inited = false

/** App 启动注册一次（index.tsx 根组件注入 router navigate）。 */
export function initCreatePrefill(navigate: (path: string) => void): void {
  if (inited) return
  inited = true
  window.addEventListener(EVENT_NAME, (e) => {
    const detail = (e as CustomEvent).detail as { entity?: unknown; payload?: unknown } | null
    if (!detail || typeof detail.entity !== 'string') return
    const entity = detail.entity as PrefillEntity
    let batch: CreatePrefillPayload[]
    try {
      batch = normalizePrefillBatch(entity, detail.payload)
    } catch {
      return // 未知实体：normalize 抛 TypeError，忽略（调用方编程错误不落地）
    }
    if (batch.length === 0) return
    // 新调用替换该实体既有队列（最新用户意图优先）
    const [get, set] = stateOf(entity)
    set({ queue: batch, version: get().version + 1 })
    navigate(ENTITY_ROUTE[entity])
  })
  // v2.5.4（弹一 C-6）：编辑预填单条制——key + 建议改动；新调用覆盖旧建议（最新意图优先）
  window.addEventListener(EDIT_EVENT_NAME, (e) => {
    const detail = (e as CustomEvent).detail as { entity?: unknown; key?: unknown; payload?: unknown } | null
    if (!detail || typeof detail.entity !== 'string' || typeof detail.key !== 'string') return
    const entity = detail.entity as PrefillEntity
    if (!detail.key.trim()) return
    let payload: CreatePrefillPayload
    try {
      payload = normalizeEditPrefill(entity, detail.payload)
    } catch {
      return // 未知实体（编程错误不落地）
    }
    // 先导航、后（下一宏任务）set：Solid 同批同步渲染——若同 tick set，源页面实例会在被卸载前
    // 抢先消费并 clear（列表/详情共用组件的实体必丢，productSet 实测稳定复现）→ 目标实例永远收不到。
    // 导航重渲染完成（旧实例卸载、目标实例挂载并首跑 effect）后 set，只能由目标实例消费（v2.5.4 C-6 修复）。
    navigate(ENTITY_EDIT_ROUTE[entity](detail.key.trim()))
    const [get, set] = editStateOf(entity)
    const key = detail.key.trim()
    setTimeout(() => set({ key, payload, version: get().version + 1 }), 0)
  })
  // v2.5.7（协议增量 E3）：openEntity 导航桥——跳本体对应页。纯 UI 动作（无数据写入，
  // 无 permissions 依赖）；未知实体/空 key 静默忽略（编程错误不落地）。
  window.addEventListener(OPEN_ENTITY_EVENT_NAME, (e) => {
    const detail = (e as CustomEvent).detail as { entity?: unknown; key?: unknown } | null
    if (!detail || typeof detail.entity !== 'string' || typeof detail.key !== 'string') return
    const entity = detail.entity as PrefillEntity
    if (!(entity in ENTITY_OPEN_ROUTE)) return
    if (!detail.key.trim()) return
    navigate(ENTITY_OPEN_ROUTE[entity](detail.key.trim()))
  })
}

/** 页面消费：createEffect 里读它以建立版本依赖（只触发打开，从不关弹窗——关闭走显式路径） */
export function prefillVersion(entity: PrefillEntity): number {
  return stateOf(entity)[0]().version
}

/** 当前待填条目（队首，peek 不移除） */
export function currentPrefill(entity: PrefillEntity): CreatePrefillPayload | null {
  return stateOf(entity)[0]().queue[0] ?? null
}

/** 创建成功：移除队首推进下一条（P1-1）；队列自然空了之后版本再 bump 一次，页面效果读到 null 不再动作 */
export function advancePrefill(entity: PrefillEntity): void {
  const [get, set] = stateOf(entity)
  set({ queue: get().queue.slice(1), version: get().version + 1 })
}

/** 取消：清空该实体队列（P1-1）；页面手动「新建」前也可调用做防御性清理 */
export function clearPrefill(entity: PrefillEntity): void {
  const [get, set] = stateOf(entity)
  if (get().queue.length === 0) return
  set({ queue: [], version: get().version + 1 })
}

// —— 编辑预填（C-6）消费接口 ——

/** 当前编辑建议（把 + payload + version，peek 不移除）；无 → null */
export function currentEditPrefill(entity: PrefillEntity): EditPrefillState | null {
  const s = editStateOf(entity)[0]()
  return s.key ? s : null
}

/** 消费完成（弹窗已打开/已关闭）：清空该实体编辑建议（单条制，一次性） */
export function clearEditPrefill(entity: PrefillEntity): void {
  const [get, set] = editStateOf(entity)
  if (!get().key) return
  set({ key: '', payload: {}, version: get().version + 1 })
}
