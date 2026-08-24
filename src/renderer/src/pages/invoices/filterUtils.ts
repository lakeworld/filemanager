/**
 * 发票/入库台账筛选纯函数（PLAN-v2.5.5 §一 任务4，B3 任务 C）：
 * 组合筛选（状态/客户/待办/搜索 + 日期范围/金额范围/有无归档文件）写成不依赖 Solid 的纯函数，
 * 便于 tests/unit 直接 node 直测（tests/unit/filterUtils.test.ts）。
 *
 * 孤儿（未建档）数据注入见 currentOrphans：把扫描到的孤儿集合与台账已登记 file_path 取差集，
 * 已补建（登记）的孤儿自动退出视图，防残留。
 * 纯结构：只 import 类型与同目录纯函数（utils.ts），不 import 任何渲染层 store/组件。
 */
import type { InvoiceRecord, InboundRecord } from "../../types";
import { isDueSoon } from "./utils";

/** 发票台账筛选条件（"" / undefined = 不限定；日期为 YYYY-MM-DD 字典序比较含两端） */
export interface InvoiceFilters {
  status?: string;
  customer?: string;
  /** 仅 30 天待办（复用 utils.isDueSoon 口径） */
  dueSoonOnly?: boolean;
  /** 搜索：命中 号码/开票方/购买方（小写包含） */
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  /** "yes" = 有归档文件（file_path 非空）；"no" = 无归档文件（file_path 空） */
  hasFile?: "yes" | "no";
}

/** 入库单筛选条件（无状态/客户/待办；搜索命中 单据编号/供应商；其余与发票一致） */
export interface InboundFilters {
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  hasFile?: "yes" | "no";
}

/** 关键词命中任一字段（小写包含；空关键词恒真） */
export function matchesQuery(query: string, values: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((v) => v.toLowerCase().includes(q));
}

/** 日期是否落在区间（YYYY-MM-DD 字典序即时间序，含两端） */
export function inDateRange(date: string, from: string | undefined, to: string | undefined): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** 金额是否落在区间（含两端；非有限金额不命中——防 NaN 误入） */
export function inAmountRange(amount: number, min: number | undefined, max: number | undefined): boolean {
  if (!Number.isFinite(amount)) return false;
  if (min !== undefined && amount < min) return false;
  if (max !== undefined && amount > max) return false;
  return true;
}

/** 有无归档文件（file_path 非空判定） */
export function matchesHasFile(filePath: string, hasFile: "yes" | "no" | undefined): boolean {
  if (!hasFile) return true;
  if (hasFile === "yes") return filePath.trim() !== "";
  return filePath.trim() === "";
}

/** 发票组合筛选（搜索/状态/客户/待办/日期/金额/归档叠加） */
export function filterInvoices(records: InvoiceRecord[], f: InvoiceFilters): InvoiceRecord[] {
  return records.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.customer && r.customer !== f.customer) return false;
    if (f.dueSoonOnly && !isDueSoon(r)) return false;
    if (!matchesQuery(f.query ?? "", [r.number, r.seller, r.buyer])) return false;
    if (!inDateRange(r.date, f.dateFrom, f.dateTo)) return false;
    if (!inAmountRange(r.amount, f.amountMin, f.amountMax)) return false;
    if (!matchesHasFile(r.file_path ?? "", f.hasFile)) return false;
    return true;
  });
}

/** 入库单组合筛选（搜索/日期/金额/归档叠加） */
export function filterInbound(records: InboundRecord[], f: InboundFilters): InboundRecord[] {
  return records.filter((r) => {
    if (!matchesQuery(f.query ?? "", [r.id, r.supplier])) return false;
    if (!inDateRange(r.date, f.dateFrom, f.dateTo)) return false;
    if (!inAmountRange(r.amount ?? NaN, f.amountMin, f.amountMax)) return false;
    if (!matchesHasFile(r.file_path ?? "", f.hasFile)) return false;
    return true;
  });
}

/**
 * 未建档（孤儿）视图数据：从扫描到的孤儿集合中挑出「仍未登记」的——
 * ledgerFilePaths = 各台账已登记 file_path 集合（孤儿数据注入）；已补建（登记）的孤儿自动退出视图。
 * 返回工作区相对路径数组（/ 分隔，如 发票/2026/x.pdf）。
 */
export function currentOrphans(allOrphans: string[], ledgerFilePaths: Iterable<string>): string[] {
  const registered = new Set(ledgerFilePaths);
  return allOrphans.filter((p) => !registered.has(p));
}

/** 孤儿文件名/路径字面量搜索（补建/删除列表快速过滤；空关键词原样返回） */
export function filterOrphansByQuery(orphans: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return orphans;
  return orphans.filter((p) => {
    const name = p.split("/").pop() ?? "";
    return p.toLowerCase().includes(q) || name.toLowerCase().includes(q);
  });
}
