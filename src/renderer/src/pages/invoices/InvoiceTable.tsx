import { Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import VirtualGrid from "~/components/VirtualGrid";
import EmptyState from "~/components/EmptyState";
import { STATUSES, nextStatusOf, statusChipClass, fmtMoney, isDueSoon, INVOICE_COL_TEMPLATE } from "./utils";
import type { InvoiceRecord, InvoiceStatus } from "./types";

/**
 * 发票台账表格（v2.5.1 T3 波1 拆分）：
 * 表头 + VirtualGrid 行渲染（号码/日期/开票方/购买方/金额/状态流转/客户跳转/待办/操作）。
 * 逻辑零改动：状态流转/预览/编辑/删除回调由主文件传入（props 显式化，D11）。
 * 收敛：text-red-500/600 → danger 语义色（T1）。
 */
export default function InvoiceTable(props: {
  rows: InvoiceRecord[];
  missing: Record<string, boolean>;
  customerExists: (name: string) => boolean;
  onSetStatus: (number: string, status: InvoiceStatus) => void;
  onPreview: (rec: InvoiceRecord) => void;
  onEdit: (rec: InvoiceRecord) => void;
  onDelete: (rec: InvoiceRecord) => void;
  scrollResetKey: string;
}) {
  const navigate = useNavigate();
  return (
    <Show when={props.rows.length === 0} fallback={
      <>
        <div
          class="px-3 py-2 text-xs text-surface-400 grid items-center gap-2 shrink-0"
          style={{ "grid-template-columns": INVOICE_COL_TEMPLATE }}
        >
          <span>号码</span>
          <span>日期</span>
          <span>开票方</span>
          <span>购买方</span>
          <span class="text-right">金额</span>
          <span>状态</span>
          <span>客户</span>
          <span>待办日期</span>
          <span class="text-right">操作</span>
        </div>
        <div class="flex-1 min-h-0">
          <VirtualGrid
            items={props.rows}
            itemHeight={48}
            columns={1}
            gap={8}
            scrollResetKey={props.scrollResetKey}
            renderItem={(rec) => (
              <div
                class={`px-3 py-2 rounded-lg grid items-center gap-2 text-sm transition-colors hover:bg-surface-50 ${props.missing[rec.file_path] ? "opacity-60" : ""}`}
                style={{ "grid-template-columns": INVOICE_COL_TEMPLATE }}
              >
                <span class="font-medium text-surface-900 truncate min-w-0" title={rec.file_path}>
                  {rec.number}
                </span>
                <span class="text-surface-500 truncate min-w-0">{rec.date}</span>
                <span class="truncate min-w-0">{rec.seller}</span>
                <span class="truncate min-w-0">{rec.buyer}</span>
                <span class="text-right tabular-nums text-surface-900">{fmtMoney(rec.amount)}</span>
                <div class="flex items-center gap-1 min-w-0">
                  <span class={`text-xs px-2 py-0.5 rounded-full shrink-0 ${statusChipClass(rec.status)}`}>
                    {rec.status}
                  </span>
                  <Show when={rec.status !== "已入账"}>
                    <button
                      class="text-primary-600 hover:text-primary-700 text-xs shrink-0 px-0.5"
                      title={`流转为「${nextStatusOf(rec.status)}」`}
                      onClick={() => void props.onSetStatus(rec.number, nextStatusOf(rec.status))}
                    >
                      →
                    </button>
                  </Show>
                  <select
                    class="text-xs border border-surface-200 rounded bg-white text-surface-600 shrink-0"
                    value={rec.status}
                    title="直接选择状态（可回退）"
                    aria-label={`发票 ${rec.number} 状态`}
                    onChange={(e) => void props.onSetStatus(rec.number, e.currentTarget.value as InvoiceStatus)}
                  >
                    <For each={STATUSES}>
                      {(s) => <option value={s}>{s}</option>}
                    </For>
                  </select>
                </div>
                <div class="min-w-0">
                  <Show when={rec.customer} fallback={<span class="text-surface-300">-</span>}>
                    {(name) => (
                      <button
                        class={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                          props.customerExists(name())
                            ? "bg-surface-100 text-surface-700 hover:bg-primary-50 hover:text-primary-700"
                            : "bg-surface-50 text-surface-400"
                        }`}
                        title={props.customerExists(name()) ? "前往客户详情" : "客户已删除（字面值保留）"}
                        onClick={() => {
                          if (props.customerExists(name())) navigate(`/clients/${encodeURIComponent(name())}`);
                        }}
                      >
                        {name()}
                      </button>
                    )}
                  </Show>
                </div>
                <div class="flex items-center gap-1 min-w-0">
                  <span class="truncate text-surface-600 min-w-0">{rec.due_date || "-"}</span>
                  <Show when={isDueSoon(rec)}>
                    <span class="text-danger-500 shrink-0" title="30 天内待办">⏰</span>
                  </Show>
                </div>
                <div class="flex items-center justify-end gap-1.5 min-w-0">
                  <Show when={props.missing[rec.file_path]}>
                    <span class="text-xs text-danger-600 shrink-0" title="归档文件已缺失（不影响记录）">文件缺失</span>
                  </Show>
                  <button class="text-surface-400 hover:text-primary-600 text-sm shrink-0" title="预览文件" onClick={() => props.onPreview(rec)}>
                    👁
                  </button>
                  <button class="text-surface-400 hover:text-primary-600 text-sm shrink-0" title="编辑" onClick={() => props.onEdit(rec)}>
                    ✏️
                  </button>
                  <button class="text-surface-400 hover:text-danger-500 text-sm shrink-0" title="删除" onClick={() => props.onDelete(rec)}>
                    🗑️
                  </button>
                </div>
              </div>
            )}
          />
        </div>
      </>
    }>
      <div class="flex-1 flex items-center justify-center">
        <EmptyState icon="🧾" title="没有匹配的发票" desc="调整筛选条件或点击「新建发票」登记" />
      </div>
    </Show>
  );
}
