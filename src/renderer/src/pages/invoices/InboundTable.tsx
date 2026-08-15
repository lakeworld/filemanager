import { Show, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import VirtualGrid from "~/components/VirtualGrid";
import EmptyState from "~/components/EmptyState";
import { fmtMoney, INBOUND_COL_TEMPLATE } from "./utils";
import type { InboundRecord, SupplierBrief } from "./types";

/**
 * 入库单表格（v2.5.1 T3 波1 拆分）：
 * 表头 + VirtualGrid 行渲染（编号/日期/供应商灰显占位/关联产品集跳转/金额/备注/操作）。
 * 逻辑零改动；收敛：text-red-500 → danger-500（T1）。
 */
export default function InboundTable(props: {
  rows: InboundRecord[];
  suppliers: SupplierBrief[];
  onPreview: (rec: InboundRecord) => void;
  onEdit: (rec: InboundRecord) => void;
  onDelete: (rec: InboundRecord) => void;
}) {
  const navigate = useNavigate();
  return (
    <Show when={props.rows.length === 0} fallback={
      <div class="flex-1 min-h-0 flex flex-col">
        <div class="card p-2 flex flex-col flex-1 min-h-0">
          <div
            class="px-3 py-2 text-xs text-surface-400 grid items-center gap-2 shrink-0"
            style={{ "grid-template-columns": INBOUND_COL_TEMPLATE }}
          >
            <span>单据编号</span>
            <span>日期</span>
            <span>供应商</span>
            <span>关联产品集</span>
            <span class="text-right">金额</span>
            <span>备注</span>
            <span class="text-right">操作</span>
          </div>
          <div class="flex-1 min-h-0">
            <VirtualGrid
              items={props.rows}
              itemHeight={48}
              columns={1}
              gap={8}
              renderItem={(rec) => (
                <div
                  class="px-3 py-2 rounded-lg grid items-center gap-2 text-sm transition-colors hover:bg-surface-50"
                  style={{ "grid-template-columns": INBOUND_COL_TEMPLATE }}
                >
                  <span class="font-medium text-surface-900 truncate min-w-0" title={rec.file_path}>{rec.id}</span>
                  <span class="text-surface-500 truncate min-w-0">{rec.date}</span>
                  {/* v2.4.9 S2：供应商已删除 → 灰显占位（字面值保留，不可选但显示名称，同客户删除后灰显范式） */}
                  <Show when={rec.supplier_id && !props.suppliers.some((s) => s.name === rec.supplier_id)} fallback={<span class="truncate min-w-0">{rec.supplier}</span>}>
                    <span class="truncate min-w-0 text-surface-300" title="供应商已删除，名称仅作记录保留">
                      {rec.supplier}
                    </span>
                  </Show>
                  <div class="min-w-0">
                    <Show when={rec.product_set} fallback={<span class="text-surface-300">-</span>}>
                      {(name) => (
                        <button
                          class="text-xs px-2 py-0.5 rounded-full bg-surface-100 text-surface-700 hover:bg-primary-50 hover:text-primary-700 transition-colors"
                          title="前往产品集"
                          onClick={() => navigate(`/product-sets/${encodeURIComponent(name())}`)}
                        >
                          {name()}
                        </button>
                      )}
                    </Show>
                  </div>
                  <span class="text-right tabular-nums text-surface-900">
                    {rec.amount !== undefined ? fmtMoney(rec.amount) : "-"}
                  </span>
                  <span class="truncate min-w-0 text-surface-500">{rec.notes || "-"}</span>
                  <div class="flex items-center justify-end gap-1.5 min-w-0">
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
        </div>
      </div>
    }>
      <div class="flex-1 flex items-center justify-center">
        <EmptyState icon="📥" title="暂无入库单" desc="点击「新建入库单」登记第一条记录" />
      </div>
    </Show>
  );
}
