/**
 * 入库单筛选工具栏（v2.5.5 B3 任务 C 筛选增强；入库无状态/客户/待办）：
 * 搜索（单据编号/供应商）+ 日期范围 / 金额范围 / 有无归档文件 / 视图（台账 | 未建档文件）。
 * 逻辑零改动（筛选组合在 filterUtils.ts 纯函数，本组件只透传信号）。
 */
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
  const dateInputCls = "px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white";
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
      <input type="date" class={dateInputCls} aria-label="起始日期" value={props.dateFrom} onInput={(e) => props.onDateFrom(e.currentTarget.value)} />
      <span class="text-surface-400 self-center text-sm shrink-0">至</span>
      <input type="date" class={dateInputCls} aria-label="结束日期" value={props.dateTo} onInput={(e) => props.onDateTo(e.currentTarget.value)} />
      <label class="text-xs text-surface-400 self-center shrink-0">金额</label>
      <input
        type="number"
        class="w-24 px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white"
        aria-label="金额下限"
        placeholder="下限"
        value={props.amountMin}
        onInput={(e) => props.onAmountMin(e.currentTarget.value)}
      />
      <span class="text-surface-400 self-center text-sm shrink-0">至</span>
      <input
        type="number"
        class="w-24 px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white"
        aria-label="金额上限"
        placeholder="上限"
        value={props.amountMax}
        onInput={(e) => props.onAmountMax(e.currentTarget.value)}
      />
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
  );
}
