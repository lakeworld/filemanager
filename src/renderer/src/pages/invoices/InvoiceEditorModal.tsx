import { Show, For } from "solid-js";
import Modal from "~/components/ui/Modal";
import DatePicker from "~/components/DatePicker";
import TagInput from "~/components/TagInput";
import ArchiveField from "./ArchiveField";
import { STATUSES } from "./utils";
import type { InvoiceFormState, InvoiceStatus, InvoiceRecord, CustomerBrief } from "./types";
import type { TagInfo } from "~/types";
/**
 * 发票新建/编辑弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 信号与保存逻辑保留在主文件（Invoices.tsx），本组件只做展示与字段编辑（props 显式化，D11）。
 * 逻辑零改动：字段校验/归档/保存均在主文件 saveInvoice 等 handler。
 */
export default function InvoiceEditorModal(props: {
  editor: { mode: "create" } | { mode: "edit"; record: InvoiceRecord } | null;
  form: InvoiceFormState;
  setField: <K extends keyof InvoiceFormState>(key: K, value: InvoiceFormState[K]) => void;
  /** v2.5.3（P2-10）：保存中——提交按钮 disabled 防连点双创建 */
  saving?: boolean;
  onClose: () => void;
  onSave: () => void;
  onPickFile: () => void;
  onPreviewFile: () => void;
  missing: Record<string, boolean>;
  customers: CustomerBrief[];
  tagOptions: TagInfo[];
}) {
  return (
    <Show when={props.editor}>
      <Modal open title={props.editor?.mode === "edit" ? "编辑发票" : "新建发票"} size="2xl" onClose={props.onClose}>
        <div class="p-6">
          <h2 class="text-xl font-bold mb-4">{props.editor?.mode === "edit" ? "编辑发票" : "新建发票"}</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">发票号码 *</label>
              <input
                type="text"
                class="input w-full"
                placeholder="如：25312000000012345678"
                value={props.form.number}
                onInput={(e) => props.setField("number", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">发票代码</label>
              <input
                type="text"
                class="input w-full"
                placeholder="数电票可留空"
                value={props.form.code}
                onInput={(e) => props.setField("code", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">开票日期 *</label>
              <DatePicker
                value={props.form.date}
                onChange={(d) => props.setField("date", d)}
                placeholder="选择开票日期"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">金额（价税合计，元）*</label>
              <input
                type="number"
                class="input w-full"
                placeholder="如：1250.50"
                value={props.form.amount}
                onInput={(e) => props.setField("amount", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">开票方 *</label>
              <input
                type="text"
                class="input w-full"
                placeholder="销售方名称"
                value={props.form.seller}
                onInput={(e) => props.setField("seller", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">购买方抬头 *</label>
              <input
                type="text"
                class="input w-full"
                placeholder="购买方名称"
                value={props.form.buyer}
                onInput={(e) => props.setField("buyer", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">状态</label>
              <select
                class="select w-full"
                aria-label="发票状态"
                value={props.form.status}
                onChange={(e) => props.setField("status", e.currentTarget.value as InvoiceStatus)}
              >
                <For each={STATUSES}>
                  {(s) => <option value={s}>{s}</option>}
                </For>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">关联客户</label>
              <select
                class="select w-full"
                aria-label="关联客户"
                value={props.form.customer}
                onChange={(e) => props.setField("customer", e.currentTarget.value)}
              >
                <option value="">不关联客户</option>
                <For each={props.customers}>
                  {(c) => <option value={c.name}>{c.name}</option>}
                </For>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">待办日期</label>
              <DatePicker
                value={props.form.due_date}
                onChange={(d) => props.setField("due_date", d)}
                placeholder="认证抵扣期 / 报销截止"
              />
            </div>
          </div>
          <div class="mt-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">标签</label>
            <TagInput
              value={props.form.tags}
              onChange={(t) => props.setField("tags", t)}
              options={props.tagOptions}
              placeholder="输入标签按回车"
            />
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
              label="发票文件 *（归档至 发票/<年份>/）"
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
