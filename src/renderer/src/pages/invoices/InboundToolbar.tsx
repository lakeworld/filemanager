/**
 * 入库单筛选工具栏（v2.5.5 B3 任务 C 筛选增强；入库无状态/客户/待办）：
 * 搜索（单据编号/供应商）+ 日期范围 / 金额范围 / 有无归档文件 / 视图（台账 | 未建档文件）。
 * 逻辑零改动（筛选组合在 filterUtils.ts 纯函数，本组件只透传信号）。
 * v2.5.7（D2 表单控件统一）：日期两输入换 DatePicker（compact+ariaLabel），清空原生日期控件。
 * v2.5.8 D9（W4 控件统一 II）：两个原生 select 元素换 `SearchSelect`（compact，与同排
 * DatePicker/MoneyInput 等高），options 与发票工具栏共用 `./utils` 一处定义；值口径不动。
 */
import DatePicker from "~/components/DatePicker";
import MoneyInput from "~/components/MoneyInput";
import SearchSelect from "~/components/ui/SearchSelect";
import { HAS_FILE_OPTIONS, VIEW_OPTIONS } from "./utils";

export default function InboundToolbar(props: {
  query: string;
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  hasFile: "" | "yes" | "no";
  viewMode: "records" | "orphans";
  onQuery: (v: string) => void;
  onDateFrom: (v: string) => void;
  onDateTo: (v: string) => void;
  onAmountMin: (v: string) => void;
  onAmountMax: (v: string) => void;
  onHasFile: (v: "" | "yes" | "no") => void;
  onViewMode: (v: "records" | "orphans") => void;
}) {
  return (
    <div class="flex flex-col md:flex-row gap-2 mb-4 shrink-0 flex-wrap">
      <input
        type="text"
        class="input flex-1 min-w-[180px]"
        placeholder="搜索单据编号 / 供应商..."
        value={props.query}
        onInput={(e) => props.onQuery(e.currentTarget.value)}
      />
      <label class="text-xs text-surface-400 self-center shrink-0">日期</label>
      <DatePicker compact ariaLabel="起始日期" value={props.dateFrom} onChange={props.onDateFrom} />
      <span class="text-surface-400 self-center text-sm shrink-0">至</span>
      <DatePicker compact ariaLabel="结束日期" value={props.dateTo} onChange={props.onDateTo} />
      <label class="text-xs text-surface-400 self-center shrink-0">金额</label>
      {/* v2.5.8 精致化 W4/D8：本工具栏原用窄一档 w-24（Quotes/InvoiceToolbar 是 w-28），
          走 MoneyInput compact 时用 class 覆盖宽度，保持既有栅格不改（不趁收组件顺手改版式） */}
      <MoneyInput
        class="input-compact w-24"
        ariaLabel="金额下限"
        placeholder="下限"
        value={props.amountMin}
        onChange={props.onAmountMin}
      />
      <span class="text-surface-400 self-center text-sm shrink-0">至</span>
      <MoneyInput
        class="input-compact w-24"
        ariaLabel="金额上限"
        placeholder="上限"
        value={props.amountMax}
        onChange={props.onAmountMax}
      />
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
  );
}
