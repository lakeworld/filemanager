/**
 * check-no-secrets.mjs 的类型声明（vitest node 侧 import 用；CLI 行为不受影响）。
 * 只声明单测需要的两个导出：历史口径纯判据 + 真实仓库状态读取。
 */

export interface HistoryAuditStatus {
  /** 仓库是否浅克隆（`git rev-parse --is-shallow-repository`） */
  isShallow: boolean
  /** 提交数（`git rev-list --count --all`）；只作提示信息——**单提交的完整仓同样可审** */
  commitCount: number
}

export interface HistoryAuditScope {
  /** false ⇒ 历史口径审不了，调用方必须拒绝执行而非报"通过" */
  usable: boolean
  /** 不可审时给人看的原因与修法；可审时为空串 */
  reason: string
}

export declare function historyAuditScope(status: HistoryAuditStatus): HistoryAuditScope

/** 从 ROOT（可用 QH_LEAK_ROOT 注入）读真实 git 状态 */
export declare function readHistoryAuditStatus(): HistoryAuditStatus