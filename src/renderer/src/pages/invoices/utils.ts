/**
 * 发票/入库台账页纯函数与常量（v2.5.1 T3 波1 拆分，D11 例外条款：允许进 tests/unit 锁定）。
 * 纯结构搬迁：函数体零改动，仅迁移；fileEntryOf 依赖渲染层 store（非纯），保留在主文件。
 */
import type { InvoiceRecord, InvoiceStatus } from "~/types";

export const STATUSES: InvoiceStatus[] = ["待报销", "已报销", "已入账"];

/** 待办窗口 = 距今 30 天（含已过期 30 天内），与 core isDueSoon / 证书到期提醒窗口同口径 */
export const DUE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 记录是否落在待办窗口（due_date 本地时区解析 YYYY-MM-DD，状态 ≠ 已入账；解析失败不提醒） */
export function isDueSoon(rec: InvoiceRecord, now = Date.now()): boolean {
  if (rec.status === "已入账" || !rec.due_date) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rec.due_date);
  if (!m) return false;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  if (Number.isNaN(t)) return false;
  return t >= now - DUE_WINDOW_MS && t <= now + DUE_WINDOW_MS;
}

export function nextStatusOf(s: InvoiceStatus): InvoiceStatus {
  return STATUSES[Math.min(STATUSES.indexOf(s) + 1, STATUSES.length - 1)];
}

/** 状态 chip 类（v2.5.1 T1 语义色：待报销→warning、已报销→info、已入账→success） */
export function statusChipClass(s: InvoiceStatus): string {
  switch (s) {
    case "待报销":
      return "bg-warning-50 text-warning-700";
    case "已报销":
      return "bg-info-50 text-info-700";
    case "已入账":
      return "bg-success-50 text-success-700";
  }
}

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 金额展示（仅展示与页内合计，不进任何计算，PLAN §3.3） */
export function fmtMoney(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-";
}

/** 按扩展名分类（镜像主进程 classifyFileType） */
export function fileTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"].includes(ext)) return "video";
  return "other";
}

export function baseNameOf(relPath: string): string {
  return relPath.split("/").pop() || relPath;
}

// 台账列模板（与表头/合计行一致；minmax 保证窄窗口下可截断）
export const INVOICE_COL_TEMPLATE =
  "minmax(110px,1.1fr) minmax(85px,0.85fr) minmax(130px,1.3fr) minmax(130px,1.3fr) minmax(80px,0.8fr) minmax(165px,1.35fr) minmax(95px,0.95fr) minmax(90px,0.9fr) minmax(105px,0.85fr)";
// 入库单列模板
export const INBOUND_COL_TEMPLATE =
  "minmax(110px,1.1fr) minmax(90px,0.9fr) minmax(150px,1.5fr) minmax(120px,1.2fr) minmax(85px,0.85fr) minmax(150px,1.5fr) minmax(105px,0.85fr)";
