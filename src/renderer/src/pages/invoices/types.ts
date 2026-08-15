/**
 * 发票/入库台账页共享类型（v2.5.1 T3 波1 拆分：从 Invoices.tsx 纯搬迁）。
 */
import type { InvoiceRecord, InvoiceStatus, InboundRecord } from "~/types";

export type { InvoiceRecord, InvoiceStatus, InboundRecord };

export interface InvoiceFormState {
  number: string;
  code: string;
  date: string;
  amount: string;
  seller: string;
  buyer: string;
  status: InvoiceStatus;
  customer: string;
  due_date: string;
  file_path: string;
  tags: string[];
  notes: string;
}

export interface InboundFormState {
  id: string;
  date: string;
  supplier: string;
  /** 关联供应商名（选择已有供应商下拉时填入；手输清空；供应商已删除旧单显示灰显占位） */
  supplier_id: string;
  product_set: string;
  amount: string;
  notes: string;
  file_path: string;
}

/** 客户下拉选项（c.name 访问面） */
export interface CustomerBrief {
  name: string;
}

/** 供应商下拉选项 */
export interface SupplierBrief {
  name: string;
}
