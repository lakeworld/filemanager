import { For } from "solid-js";
import DatePicker from "~/components/DatePicker";
import { STATUSES } from "./utils";
import type { CustomerBrief } from "./types";

/**
 * 发票台账筛选工具栏（v2.5.1 T3 波1 拆分 + v2.5.5 B3 任务 C 筛选增强）：
 * 第一行：搜索（号码/开票方/购买方）+ 状态/客户/30 天待办（既有三下拉）；
 * 第二行（新增四类）：日期范围 / 金额范围 / 有无归档文件 / 视图（台账 | 未建档文件）。
 * 未建档文件 = 孤儿视图（扫出「目录有文件但台账无记录」，见 B3 任务 D），不是记录筛选。
 * 逻辑零改动（筛选组合在 filterUtils.ts 纯函数，本组件只透传信号）。
 */
export default function InvoiceToolbar(props: {
  query: string;
  statusFilter: string;
  customerFilter: string;
  dueSoonOnly: boolean;
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  hasFile: "" | "yes" | "no";
  viewMode: "records" | "orphans";
  onQuery: (v: string) => void;
  onStatusFilter: (v: string) => void;
  onCustomerFilter: (v: string) => void;
  onDueSoonOnly: (v: boolean) => void;
  onDateFrom: (v: string) => void;
  onDateTo: (v: string) => void;
  onAmountMin: (v: string) => void;
  onAmountMax: (v: string) => void;
  onHasFile: (v: "" | "yes" | "no") => void;
  onViewMode: (v: "records" | "orphans") => void;
  customers: CustomerBrief[];
}) {
  // v2.5.7（D2 表单控件统一）：date input 全部换 DatePicker（compact+ariaLabel），清空原生日期控件（type=date 清零）
  return (
    <div class="flex flex-col gap-2 mb-4 shrink-0">
      <div class="flex flex-col md:flex-row gap-3">
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
      {/* v2.5.5（B3 任务 C）：筛选增强四类——日期范围 / 金额范围 / 有无归档文件 / 视图（未建档） */}
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-xs text-surface-400 shrink-0">日期</label>
        <DatePicker compact ariaLabel="起始日期" value={props.dateFrom} onChange={props.onDateFrom} />
        <span class="text-surface-400 text-sm">至</span>
        <DatePicker compact ariaLabel="结束日期" value={props.dateTo} onChange={props.onDateTo} />
        <span class="w-px h-6 bg-surface-200 shrink-0" />
        <label class="text-xs text-surface-400 shrink-0">金额</label>
        <input
          type="number"
          class="w-28 px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          aria-label="金额下限"
          placeholder="下限"
          value={props.amountMin}
          onInput={(e) => props.onAmountMin(e.currentTarget.value)}
        />
        <span class="text-surface-400 text-sm">至</span>
        <input
          type="number"
          class="w-28 px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          aria-label="金额上限"
          placeholder="上限"
          value={props.amountMax}
          onInput={(e) => props.onAmountMax(e.currentTarget.value)}
        />
        <span class="w-px h-6 bg-surface-200 shrink-0" />
        <select
          class="select"
          aria-label="归档文件筛选"
          value={props.hasFile}
          onChange={(e) => props.onHasFile(e.currentTarget.value as "" | "yes" | "no")}
        >
          <option value="">全部归档</option>
          <option value="yes">有归档文件</option>
          <option value="no">无归档文件</option>
        </select>
        <select
          class="select"
          aria-label="视图切换"
          value={props.viewMode}
          onChange={(e) => props.onViewMode(e.currentTarget.value as "records" | "orphans")}
        >
          <option value="records">台账视图</option>
          <option value="orphans">未建档文件</option>
        </select>
      </div>
    </div>
  );
}
