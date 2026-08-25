/**
 * AI 批量识别暂存 store（PLAN-v2.5.6-批量识别待确认区）。
 *
 * 语义（用户拍板 2026-08-25）：识别结果**不落盘**，先落发票页「未建档」视图的
 * 常驻「待确认」区，用户逐条/批量确认后才归档登记；取消/关闭应用零副作用，
 * 源文件始终在原始位置。
 *
 * 会话级（内存，不持久化）：重启即清空，源文件原地可重新识别。
 * 目前仅发票有批量识别命令（invoice.identifyFiles），store 按发票单例；
 * 未来入库/报价若加命令，再泛化为按实体分桶。
 */
import { createSignal } from "solid-js";
import type { BatchDraft, BatchSummary } from "../pages/invoices/batchIdentify";
import { mergeBatchSummary } from "../pages/invoices/batchIdentify";

export interface StagedIdentifyState {
  drafts: BatchDraft[];
  failed: { sourcePath: string; message: string }[];
}

const [state, setState] = createSignal<StagedIdentifyState>({ drafts: [], failed: [] });

/** 待确认草稿列表（识别成功条目） */
export const stagedDrafts = () => state().drafts;

/** 识别失败列表（可重试） */
export const stagedFailed = () => state().failed;

/** 待确认总数（草稿 + 失败，供提醒横幅） */
export const stagedCount = () => state().drafts.length + state().failed.length;

/** 一轮识别完成 → 幂等合并进暂存（重试同路径自动替换/摘失败） */
export function stageBatchSummary(summary: BatchSummary): void {
  setState((prev) => {
    const merged = mergeBatchSummary({ drafts: prev.drafts, failed: prev.failed, ignored: 0 }, summary);
    return { drafts: merged.drafts, failed: merged.failed };
  });
}

/** 移除一条草稿（确认登记消费 / 手动移除） */
export function removeStagedDraft(sourcePath: string): void {
  setState((prev) => ({ ...prev, drafts: prev.drafts.filter((d) => d.sourcePath !== sourcePath) }));
}

/** 移除一条失败记录（手动忽略） */
export function removeStagedFailed(sourcePath: string): void {
  setState((prev) => ({ ...prev, failed: prev.failed.filter((f) => f.sourcePath !== sourcePath) }));
}

/** 失败项的源路径（重试入参） */
export function stagedFailedPaths(): string[] {
  return state().failed.map((f) => f.sourcePath);
}

/** 清空全部暂存 */
export function clearStagedIdentify(): void {
  setState({ drafts: [], failed: [] });
}
