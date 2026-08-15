import { For } from "solid-js";
import { STATUSES } from "./utils";
import type { CustomerBrief } from "./types";

/**
 * 发票台账筛选工具栏（v2.5.1 T3 波1 拆分）：
 * 搜索（号码/开票方/购买方）+ 状态/客户/30 天待办筛选。逻辑零改动。
 */
export default function InvoiceToolbar(props: {
  query: string;
  statusFilter: string;
  customerFilter: string;
  dueSoonOnly: boolean;
  onQuery: (v: string) => void;
  onStatusFilter: (v: string) => void;
  onCustomerFilter: (v: string) => void;
  onDueSoonOnly: (v: boolean) => void;
  customers: CustomerBrief[];
}) {
  return (
    <div class="flex flex-col md:flex-row gap-3 mb-4 shrink-0">
      <input
        type="text"
        class="input flex-1"
        placeholder="搜索发票号码 / 开票方 / 购买方..."
        value={props.query}
        onInput={(e) => props.onQuery(e.currentTarget.value)}
      />
      <select
        class="select"
        aria-label="状态筛选"
        value={props.statusFilter}
        onChange={(e) => props.onStatusFilter(e.currentTarget.value)}
      >
        <option value="">全部状态</option>
        <For each={STATUSES}>
          {(s) => <option value={s}>{s}</option>}
        </For>
      </select>
      <select
        class="select"
        aria-label="客户筛选"
        value={props.customerFilter}
        onChange={(e) => props.onCustomerFilter(e.currentTarget.value)}
      >
        <option value="">全部客户</option>
        <For each={props.customers}>
          {(c) => <option value={c.name}>{c.name}</option>}
        </For>
      </select>
      <select
        class="select"
        aria-label="待办筛选"
        value={props.dueSoonOnly ? "1" : ""}
        onChange={(e) => props.onDueSoonOnly(e.currentTarget.value === "1")}
      >
        <option value="">全部待办</option>
        <option value="1">⏰ 仅 30 天待办</option>
      </select>
    </div>
  );
}
