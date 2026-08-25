/**
 * 发票批量 AI 识别——纯函数编排（v2.5.5 B4，T0 定案：工作区文件多选面板 → invoice.identifyFiles → 逐条建票）。
 *
 * 只写纯逻辑（paths 入参校验/≤10 截断、结果分类、草稿字段体检），不依赖 Solid/DOM，
 * tests/unit 可 node 直测；实际 IPC 调用与逐条建票（archiveFile + create + 失败回滚）在 Invoices.tsx。
 *
 * 契约对齐：插件 com.qihe.cloud v0.4.0 `invoice.identifyFiles`（≤10 硬截断 + 并发 2 + 逐条信封聚合，
 * 返回 ApiResult<BatchIdentifyResult>）；本模块的 planBatchPaths 与插件同口径（非数组/含空白串 → 错误信封）。
 */
import type { InvoicePrefill } from "../../stores/createPrefillNormalize";
import { normalizePrefill } from "../../stores/createPrefillNormalize";

/** 批量上限（与插件契约一致，用户拍板 ≤10） */
export const BATCH_LIMIT = 10;

/** 待建票草稿：归一化后的发票字段 + 归档源（sourcePath，保存时才 archive） + 识别警告 */
export interface BatchDraft {
  fields: InvoicePrefill;
  sourcePath: string;
  warnings: string[];
}

/** 批量识别结果分类（供确认弹窗 + 汇总 toast 使用） */
export interface BatchSummary {
  drafts: BatchDraft[];
  failed: { sourcePath: string; message: string }[];
  ignored: number;
}

/** paths 入参校验 + ≤10 截断（与插件同口径）：非数组/含非字符串/含空白串 → 错误 */
export function planBatchPaths(
  paths: unknown,
): { ok: true; capped: string[]; ignored: number } | { ok: false; error: string } {
  if (
    !Array.isArray(paths) ||
    paths.some((p) => typeof p !== "string" || p.trim() === "")
  ) {
    return { ok: false, error: "paths 必须是文件路径字符串数组" };
  }
  const cleaned = (paths as string[]).filter((p) => p.trim() !== "");
  const capped = cleaned.slice(0, BATCH_LIMIT);
  return { ok: true, capped, ignored: Math.max(0, cleaned.length - BATCH_LIMIT) };
}

/** 结果分类：results 逐条归一化 → 草稿；failed 逐条转 {sourcePath, message}；ignored 透传。防御未知形状。 */
export function summarizeBatchData(data: unknown): BatchSummary {
  const d = (data ?? {}) as {
    results?: unknown;
    failed?: unknown;
    ignored?: unknown;
  };
  const drafts: BatchDraft[] = [];
  if (Array.isArray(d.results)) {
    for (const it of d.results) {
      const item = it as {
        fields?: unknown;
        sourcePath?: unknown;
        warnings?: unknown;
      };
      const src = typeof item?.sourcePath === "string" ? item.sourcePath.trim() : "";
      if (!src) continue;
      drafts.push({
        fields: normalizePrefill("invoice", item?.fields) as InvoicePrefill,
        sourcePath: src,
        warnings: Array.isArray(item?.warnings)
          ? item.warnings.filter((w): w is string => typeof w === "string")
          : [],
      });
    }
  }
  const failed: { sourcePath: string; message: string }[] = [];
  if (Array.isArray(d.failed)) {
    for (const it of d.failed) {
      const item = it as { sourcePath?: unknown; error?: { message?: unknown } };
      const src = typeof item?.sourcePath === "string" ? item.sourcePath.trim() : "（未知文件）";
      failed.push({
        sourcePath: src,
        message: typeof item?.error?.message === "string" ? item.error.message : "识别失败",
      });
    }
  }
  return {
    drafts,
    failed,
    ignored: typeof d.ignored === "number" && Number.isFinite(d.ignored) && d.ignored > 0 ? d.ignored : 0,
  };
}

/** 建票必填字段体检（对齐 core create 校验口径：number/amount/seller/buyer）。缺 → 列出缺项。 */
export function missingDraftFields(draft: BatchDraft): string[] {
  const f = draft.fields;
  const missing: string[] = [];
  if (!f.number || !f.number.trim()) missing.push("发票号码");
  if (f.amount == null || !Number.isFinite(f.amount)) missing.push("金额");
  if (!f.seller || !f.seller.trim()) missing.push("开票方");
  if (!f.buyer || !f.buyer.trim()) missing.push("购买方");
  return missing;
}

/**
 * v2.5.6：面板选文件合并——按路径去重（重复选同一文件不再产生重复条目）+ ≤10 截断。
 * 返回合并后列表与超量忽略数（供 toast 提示）；空白串/非字符串防御性跳过。
 */
export function mergePickedPaths(
  existing: string[],
  incoming: unknown,
): { paths: string[]; overflow: number } {
  const seen = new Set(existing);
  const merged = [...existing];
  if (Array.isArray(incoming)) {
    for (const p of incoming) {
      if (typeof p !== "string" || p.trim() === "") continue;
      if (seen.has(p)) continue;
      seen.add(p);
      merged.push(p);
    }
  }
  return { paths: merged.slice(0, BATCH_LIMIT), overflow: Math.max(0, merged.length - BATCH_LIMIT) };
}

/**
 * v2.5.6：暂存区合并（初始识别 / 失败重试共用）——按 sourcePath 幂等合并：
 * 新成功条目替换同路径旧草稿并把它从失败列表摘掉；新失败条目替换同路径旧失败。
 * ignored 取最新一轮（重试只带重试子集，语义为当轮忽略数）。
 */
export function mergeBatchSummary(prev: BatchSummary, next: BatchSummary): BatchSummary {
  const drafts = new Map(prev.drafts.map((d) => [d.sourcePath, d]));
  const failed = new Map(prev.failed.map((f) => [f.sourcePath, f]));
  for (const d of next.drafts) {
    drafts.set(d.sourcePath, d);
    failed.delete(d.sourcePath);
  }
  for (const f of next.failed) {
    if (!drafts.has(f.sourcePath)) failed.set(f.sourcePath, f);
  }
  return { drafts: [...drafts.values()], failed: [...failed.values()], ignored: next.ignored };
}
