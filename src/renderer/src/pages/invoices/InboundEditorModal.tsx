import { Show, createMemo } from "solid-js";
import Modal from "~/components/ui/Modal";
import DatePicker from "~/components/DatePicker";
import MoneyInput from "~/components/MoneyInput"; // v2.5.5（B2）：金额输入统一
import SearchSelect from "~/components/ui/SearchSelect";
import type { SearchSelectOption } from "~/components/ui/SearchSelect";
import ArchiveField from "./ArchiveField";
import type { InboundFormState, InboundRecord, SupplierBrief } from "./types";

/**
 * 入库单新建/编辑弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 信号与保存逻辑保留在主文件（Invoices.tsx），本组件只做展示与字段编辑（props 显式化，D11）。
 * 供应商下拉交互（选择填 supplier+supplier_id、手输清空关联、已删除供应商灰显占位）逻辑原样搬迁。
 * v2.5.4 曾为「options 异步重建丢选中」加 ref 兜底；v2.5.8 D9 换 `SearchSelect`（纯受控）后作废删除。
 * 「已删除供应商」占位改吃 SearchSelectOption.disabled（原生 `<option disabled>` 的等价能力）：
 * 仍显示、仍可被搜索命中，但 ↑↓ 跳过、点击与 Enter 都不提交。
 */
export default function InboundEditorModal(props: {
  editor: { mode: "create" } | { mode: "edit"; record: InboundRecord } | null;
  form: InboundFormState;
  setField: <K extends keyof InboundFormState>(key: K, value: InboundFormState[K]) => void;
  /** v2.5.3（P2-10）：保存中——提交按钮 disabled 防连点双创建 */
  saving?: boolean;
  onClose: () => void;
  /** v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc/取消走 onCloseRequest（二次确认），否则直关 */
  dirty?: boolean;
  onCloseRequest?: () => void;
  onSave: () => void;
  onPickFile: () => void;
  onPreviewFile: () => void;
  missing: Record<string, boolean>;
  suppliers: SupplierBrief[];
  productSets: { name: string }[];
}) {
  // v2.5.8 D9（W4 控件统一 II）：两个下拉换 SearchSelect。
  // ① 原 v2.5.4 的「options 重建后用 ref 补应用 value」兜底整块作废（纯受控组件不丢选中）；
  // ② 「供应商已删除」占位从 `<option disabled>` 平移为 SearchSelectOption.disabled，
  //    顺序仍在列表末尾，语义一致（看得见、搜得到、点不动）；
  // ③ 值口径一字未动：选供应商仍同时写 supplier + supplier_id，手输仍清 supplier_id。
  const supplierOptions = createMemo<readonly SearchSelectOption[]>(() => {
    const list: SearchSelectOption[] = [
      { value: "", label: "手输 / 不关联已有供应商" },
      ...props.suppliers.map((s) => ({ value: s.name, label: s.name })),
    ];
    const gone = props.form.supplier_id;
    if (gone && !props.suppliers.some((s) => s.name === gone)) {
      list.push({ value: gone, label: `${gone}（已删除）`, disabled: true });
    }
    return list;
  });
  const productSetOptions = createMemo<readonly SearchSelectOption[]>(() => [
    { value: "", label: "不关联产品集" },
    ...props.productSets.map((ps) => ({ value: ps.name, label: ps.name })),
  ]);
  return (
    <Show when={props.editor}>
      <Modal
        open
        title={props.editor?.mode === "edit" ? "编辑入库单" : "新建入库单"}
        size="2xl"
        onClose={props.onClose}
        // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
        dirty={props.dirty}
        onCloseRequest={props.onCloseRequest}
      >
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
                  兼容手输：下方自由文本输入保留；手输时清空 supplier_id 关联。
                  v2.5.8 D9：原生 `<select>` → `SearchSelect`；「供应商已删除」的灰显不可选占位
                  由 supplierOptions() 里的 disabled 项承担（原来是一条 <option disabled>）。 */}
              <SearchSelect
                class="w-full mb-2"
                ariaLabel="供应商"
                options={supplierOptions()}
                value={props.form.supplier_id}
                matchTriggerWidth={false}
                onChange={(name) => {
                  props.setField("supplier", name);
                  props.setField("supplier_id", name);
                }}
              />
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
              <SearchSelect
                class="w-full"
                ariaLabel="关联产品集"
                options={productSetOptions()}
                value={props.form.product_set}
                matchTriggerWidth={false}
                onChange={(v) => props.setField("product_set", v)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">金额合计（元）</label>
              <MoneyInput
                class="input w-full"
                placeholder="仅展示，不进计算"
                value={props.form.amount}
                onChange={(v) => props.setField("amount", v)}
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
            {/* v2.5.5（B1-B）：取消与遮罩/Esc 同路——dirty 时走 onCloseRequest（二次确认） */}
            <button class="btn-secondary" onClick={() => (props.onCloseRequest ? props.onCloseRequest() : props.onClose())}>取消</button>
            <button class="btn-primary" onClick={() => void props.onSave()} disabled={props.saving}>
              {props.editor?.mode === "edit" ? "保存" : "确认登记"}
            </button>
          </div>
        </div>
      </Modal>
    </Show>
  );
}
