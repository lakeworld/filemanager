import { createMemo } from "solid-js";
import DatePicker from "~/components/DatePicker";
import MoneyInput from "~/components/MoneyInput";
import SearchSelect from "~/components/ui/SearchSelect";
import type { SearchSelectOption } from "~/components/ui/SearchSelect";
import { HAS_FILE_OPTIONS, STATUSES, VIEW_OPTIONS } from "./utils";
import type { CustomerBrief } from "./types";

/**
 * 发票台账筛选工具栏（v2.5.1 T3 波1 拆分 + v2.5.5 B3 任务 C 筛选增强）：
 * 第一行：搜索（号码/开票方/购买方）+ 状态/客户/30 天待办（既有三下拉）；
 * 第二行（新增四类）：日期范围 / 金额范围 / 有无归档文件 / 视图（台账 | 未建档文件）。
 * 未建档文件 = 孤儿视图（扫出「目录有文件但台账无记录」，见 B3 任务 D），不是记录筛选。
 * 逻辑零改动（筛选组合在 filterUtils.ts 纯函数，本组件只透传信号）。
 *
 * v2.5.8 D9（W4 控件统一 II）：五个原生 select 元素全量换 `SearchSelect`（compact 档，
 * 与同排 DatePicker/MoneyInput 等高），**值口径一字未动**（空串 = 「全部」的语义、
 * `hasFile` / `viewMode` 的联合类型都在 onChange 里原样收回）；响应式宽度照 Certs 首批
 * 使用者先例（响应式断点宽 + `matchTriggerWidth={false}`），不重开窄窗挤压旧坑。
 * 「归档/视图」两档与入库工具栏同源，住 `./utils`（两处各写一份必漂）。
 */

const STATUS_OPTIONS: readonly SearchSelectOption[] = [
  { value: "", label: "全部状态" },
  ...STATUSES.map((s) => ({ value: s, label: s })),
];
const DUE_OPTIONS: readonly SearchSelectOption[] = [
  { value: "", label: "全部待办" },
  { value: "1", label: "⏰ 仅 30 天待办" },
];

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
  const customerOptions = createMemo<readonly SearchSelectOption[]>(() => [
    { value: "", label: "全部客户" },
    ...props.customers.map((c) => ({ value: c.name, label: c.name })),
  ]);
  return (
    <div class="flex flex-col gap-2 mb-4 shrink-0">
      <div class="flex flex-col md:flex-row md:flex-wrap gap-3">
        <input
          type="text"
          class="input flex-1"
          placeholder="搜索发票号码 / 开票方 / 购买方..."
          value={props.query}
          onInput={(e) => props.onQuery(e.currentTarget.value)}
        />
        <SearchSelect
          class="min-w-[112px] md:w-36"
          compact
          ariaLabel="状态筛选"
          options={STATUS_OPTIONS}
          value={props.statusFilter}
          placeholder="全部状态"
          searchable={false}
          matchTriggerWidth={false}
          onChange={props.onStatusFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-40"
          compact
          ariaLabel="客户筛选"
          options={customerOptions()}
          value={props.customerFilter}
          placeholder="全部客户"
          matchTriggerWidth={false}
          onChange={props.onCustomerFilter}
        />
        <SearchSelect
          class="min-w-[112px] md:w-44"
          compact
          ariaLabel="待办筛选"
          options={DUE_OPTIONS}
          value={props.dueSoonOnly ? "1" : ""}
          placeholder="全部待办"
          searchable={false}
          matchTriggerWidth={false}
          onChange={(v) => props.onDueSoonOnly(v === "1")}
        />
      </div>
      {/* v2.5.5（B3 任务 C）：筛选增强四类——日期范围 / 金额范围 / 有无归档文件 / 视图（未建档） */}
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-xs text-surface-400 shrink-0">日期</label>
        <DatePicker compact ariaLabel="起始日期" value={props.dateFrom} onChange={props.onDateFrom} />
        <span class="text-surface-400 text-sm">至</span>
        <DatePicker compact ariaLabel="结束日期" value={props.dateTo} onChange={props.onDateTo} />
        <span class="w-px h-6 bg-surface-200 shrink-0" />
        <label class="text-xs text-surface-400 shrink-0">金额</label>
        {/* v2.5.8 精致化 W4/D8：金额筛选 → MoneyInput compact（口径同 Quotes 工具栏） */}
        <MoneyInput compact ariaLabel="金额下限" placeholder="下限" value={props.amountMin} onChange={props.onAmountMin} />
        <span class="text-surface-400 text-sm">至</span>
        <MoneyInput compact ariaLabel="金额上限" placeholder="上限" value={props.amountMax} onChange={props.onAmountMax} />
        <span class="w-px h-6 bg-surface-200 shrink-0" />
        <SearchSelect
          class="min-w-[112px] md:w-36"
          compact
          ariaLabel="归档文件筛选"
          options={HAS_FILE_OPTIONS}
          value={props.hasFile}
          placeholder="全部归档"
          searchable={false}
          matchTriggerWidth={false}
          onChange={(v) => props.onHasFile(v as "" | "yes" | "no")}
        />
        <SearchSelect
          class="min-w-[112px] md:w-32"
          compact
          ariaLabel="视图切换"
          options={VIEW_OPTIONS}
          value={props.viewMode}
          searchable={false}
          matchTriggerWidth={false}
          onChange={(v) => props.onViewMode(v as "records" | "orphans")}
        />
      </div>
    </div>
  );
}
