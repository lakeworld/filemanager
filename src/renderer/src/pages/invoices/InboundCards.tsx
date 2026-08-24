import { Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import VirtualGrid from "~/components/VirtualGrid";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import { fmtMoney } from "./utils";
import type { InboundRecord, SupplierBrief } from "./types";

/**
 * 入库单卡片网格（PLAN-v2.5.5 §一 任务1，B3 任务 A 卡片化——去表格）：
 * 与发票卡片同套样式（金额主视觉/编号+日期/供应商→关联产品集/备注/悬停操作），无状态字段、无识别入口。
 * 多选：卡片左上角复选框 + 选中边框（Images.tsx 同款模式）。
 * 旧 InboundTable.tsx（表格）已删除——本组件为其卡片化替代，行为断言（预览/编辑/删除/新建回调）不变。
 */
export default function InboundCards(props: {
  rows: InboundRecord[];
  suppliers: SupplierBrief[];
  /** v2.5.3（P2-6）：首载 loading——空态不闪现（父级 Invoices 传入） */
  loading: boolean;
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  onPreview: (rec: InboundRecord) => void;
  onEdit: (rec: InboundRecord) => void;
  onDelete: (rec: InboundRecord) => void;
  scrollResetKey: string;
}) {
  const navigate = useNavigate();
  return (
    <Show when={props.rows.length === 0} fallback={
      <div class="flex-1 min-h-0">
        <VirtualGrid
          items={props.rows}
          itemHeight={150}
          columns={{ base: 1, md: 2, lg: 2, xl: 3 }}
          gap={12}
          scrollResetKey={props.scrollResetKey}
          renderItem={(rec) => {
            const selected = props.selectedIds.includes(rec.id);
            const supplierDeleted = !!rec.supplier_id && !props.suppliers.some((s) => s.name === rec.supplier_id);
            return (
              <div
                class={`card p-3 flex flex-col h-full relative select-none group transition-colors hover:shadow-card-hover ${selected ? "border-primary-500 bg-primary-50" : ""}`}
              >
                {/* 选择复选框 + 金额主视觉 */}
                <div class="flex items-start justify-between gap-2 shrink-0">
                  <input
                    type="checkbox"
                    class="w-4 h-4 accent-primary-600 mt-1 shrink-0 cursor-pointer"
                    aria-label={`选择入库单 ${rec.id}`}
                    checked={selected}
                    onChange={() => props.onToggleSelect(rec.id)}
                  />
                  <div class="text-right min-w-0">
                    <span class="text-xl font-bold tabular-nums text-surface-900 leading-tight block truncate" title={rec.amount !== undefined ? `金额 ¥${fmtMoney(rec.amount)}` : "未填金额"}>
                      {rec.amount !== undefined ? `¥${fmtMoney(rec.amount)}` : "—"}
                    </span>
                  </div>
                </div>
                {/* 单据编号 + 日期 */}
                <div class="flex items-center gap-2 mt-1 shrink-0 min-w-0">
                  <span class="font-medium text-sm text-surface-900 truncate min-w-0" title={rec.file_path || rec.id}>
                    {rec.id}
                  </span>
                  <span class="text-xs text-surface-400 shrink-0 tabular-nums">{rec.date}</span>
                </div>
                {/* 供应商（已删除灰显占位）+ 关联产品集 chip */}
                <div class="flex items-center gap-1.5 mt-0.5 shrink-0 min-w-0">
                  <span
                    class={`text-sm truncate min-w-0 ${supplierDeleted ? "text-surface-300" : "text-surface-600"}`}
                    title={supplierDeleted ? "供应商已删除，名称仅作记录保留" : rec.supplier}
                  >
                    {rec.supplier}
                  </span>
                  <Show when={rec.product_set} fallback={<span class="text-surface-300 text-xs shrink-0">无产品集</span>}>
                    {(name) => (
                      <button
                        class="text-xs px-2 py-0.5 rounded-full bg-surface-100 text-surface-700 hover:bg-primary-50 hover:text-primary-700 transition-colors shrink-0"
                        title="前往产品集"
                        onClick={() => navigate(`/product-sets/${encodeURIComponent(name())}`)}
                      >
                        {name()}
                      </button>
                    )}
                  </Show>
                </div>
                {/* 备注（ellipsis + title） */}
                <div class="text-sm text-surface-500 truncate min-w-0 shrink-0" title={rec.notes || ""}>
                  {rec.notes || <span class="text-surface-300">无备注</span>}
                </div>
                {/* 悬停操作（查看归档文件 · 编辑 · 删除） */}
                <div class="mt-2 shrink-0 min-w-0">
                  <div class="ml-auto flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button class="text-surface-400 hover:text-primary-600 text-sm" title="查看归档文件" onClick={() => props.onPreview(rec)}>
                      👁
                    </button>
                    <button class="text-surface-400 hover:text-primary-600 text-sm" title="编辑" onClick={() => props.onEdit(rec)}>
                      ✏️
                    </button>
                    <button class="text-surface-400 hover:text-danger-500 text-sm" title="删除" onClick={() => props.onDelete(rec)}>
                      🗑️
                    </button>
                  </div>
                </div>
              </div>
            );
          }}
        />
      </div>
    }>
      <div class="flex-1 flex items-center justify-center">
        {/* v2.5.3（P2-6）：首载 loading 兜底，空态不闪现（照发票 tab 先例） */}
        <Show when={!props.loading} fallback={<Loading text="入库单加载中…" />}>
          <EmptyState icon="📥" title="没有匹配的入库单" desc="调整筛选条件或点击「新建入库单」登记" />
        </Show>
      </div>
    </Show>
  );
}
