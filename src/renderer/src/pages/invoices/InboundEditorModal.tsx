import { Show, For } from "solid-js";
import Modal from "~/components/ui/Modal";
import DatePicker from "~/components/DatePicker";
import ArchiveField from "./ArchiveField";
import type { InboundFormState, InboundRecord, SupplierBrief } from "./types";

/**
 * 入库单新建/编辑弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 信号与保存逻辑保留在主文件（Invoices.tsx），本组件只做展示与字段编辑（props 显式化，D11）。
 * 供应商下拉交互（选择填 supplier+supplier_id、手输清空关联、已删除供应商灰显占位）逻辑原样搬迁。
 */
export default function InboundEditorModal(props: {
  editor: { mode: "create" } | { mode: "edit"; record: InboundRecord } | null;
  form: InboundFormState;
  setField: <K extends keyof InboundFormState>(key: K, value: InboundFormState[K]) => void;
  /** v2.5.3（P2-10）：保存中——提交按钮 disabled 防连点双创建 */
  saving?: boolean;
  onClose: () => void;
  onSave: () => void;
  onPickFile: () => void;
  onPreviewFile: () => void;
  missing: Record<string, boolean>;
  suppliers: SupplierBrief[];
  productSets: { name: string }[];
}) {
  return (
    <Show when={props.editor}>
      <Modal open title={props.editor?.mode === "edit" ? "编辑入库单" : "新建入库单"} size="2xl" onClose={props.onClose}>
        <div class="p-6">
          <h2 class="text-xl font-bold mb-4">{props.editor?.mode === "edit" ? "编辑入库单" : "新建入库单"}</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">单据编号 *</label>
              <input
                type="text"
                class="input w-full"
                placeholder="如：RK-2026-001"
                value={props.form.id}
                onInput={(e) => props.setField("id", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">入库日期 *</label>
              <DatePicker
                value={props.form.date}
                onChange={(d) => props.setField("date", d)}
                placeholder="选择入库日期"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">供应商 *</label>
              {/* v2.4.9 S2：供应商下拉（选项来自 suppliers store；选择时填 supplier 为名 + supplier_id 为名）。
                  兼容手输：下方自由文本输入保留；手输时清空 supplier_id 关联。 */}
              <select
                class="select w-full mb-2"
                aria-label="供应商"
                value={props.form.supplier_id}
                onChange={(e) => {
                  const name = e.currentTarget.value;
                  props.setField("supplier", name);
                  props.setField("supplier_id", name);
                }}
              >
                <option value="">手输 / 不关联已有供应商</option>
                <For each={props.suppliers}>
                  {(s) => <option value={s.name}>{s.name}</option>}
                </For>
                {/* 供应商已删除的旧单：supplier_id 字面值保留，灰显占位（不可选） */}
                <Show when={props.form.supplier_id && !props.suppliers.some((s) => s.name === props.form.supplier_id)}>
                  <option value={props.form.supplier_id} disabled class="text-surface-400">
                    {props.form.supplier_id}（已删除）
                  </option>
                </Show>
              </select>
              <input
                type="text"
                class="input w-full"
                placeholder="供应商名称"
                value={props.form.supplier}
                onInput={(e) => {
                  props.setField("supplier", e.currentTarget.value);
                  // 手输时清空 supplier_id（仅下拉选择建立关联；重命名/删除旧值不再误绑）
                  props.setField("supplier_id", "");
                }}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">关联产品集</label>
              <select
                class="select w-full"
                aria-label="关联产品集"
                value={props.form.product_set}
                onChange={(e) => props.setField("product_set", e.currentTarget.value)}
              >
                <option value="">不关联产品集</option>
                <For each={props.productSets}>
                  {(ps) => <option value={ps.name}>{ps.name}</option>}
                </For>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">金额合计（元）</label>
              <input
                type="number"
                class="input w-full"
                placeholder="仅展示，不进计算"
                value={props.form.amount}
                onInput={(e) => props.setField("amount", e.currentTarget.value)}
              />
            </div>
          </div>
          <div class="mt-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
            <textarea
              class="input w-full h-auto py-2 resize-none"
              rows={2}
              placeholder="添加备注..."
              value={props.form.notes}
              onInput={(e) => props.setField("notes", e.currentTarget.value)}
            />
          </div>
          <div class="mt-4">
            <ArchiveField
              label="入库文件 *（归档至 入库/<年份>/）"
              filePath={props.form.file_path}
              missing={!!props.form.file_path && !!props.missing[props.form.file_path]}
              onPick={() => void props.onPickFile()}
              onPreview={() => props.form.file_path && props.onPreviewFile()}
            />
          </div>
          <div class="flex gap-3 justify-end mt-6">
            <button class="btn-secondary" onClick={props.onClose}>取消</button>
            <button class="btn-primary" onClick={() => void props.onSave()} disabled={props.saving}>
              {props.editor?.mode === "edit" ? "保存" : "确认登记"}
            </button>
          </div>
        </div>
      </Modal>
    </Show>
  );
}
