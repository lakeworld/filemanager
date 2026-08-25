import { Show, For, createEffect } from "solid-js";
import Modal from "~/components/ui/Modal";
import DatePicker from "~/components/DatePicker";
import TagInput from "~/components/TagInput";
import MoneyInput from "~/components/MoneyInput"; // v2.5.5（B2）：金额输入统一
import ArchiveField from "./ArchiveField";
import { STATUSES } from "./utils";
import type { InvoiceFormState, InvoiceStatus, InvoiceRecord, CustomerBrief } from "./types";
import type { TagInfo } from "~/types";
/**
 * 发票新建/编辑弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 信号与保存逻辑保留在主文件（Invoices.tsx），本组件只做展示与字段编辑（props 显式化，D11）。
 * 逻辑零改动：字段校验/归档/保存均在主文件 saveInvoice 等 handler。
 * v2.5.4：客户下拉 options 随 customers store 异步刷新重建时浏览器丢选中——变化后补应用 value（预填依赖）。
 */
export default function InvoiceEditorModal(props: {
  editor: { mode: "create" } | { mode: "edit"; record: InvoiceRecord } | null;
  form: InvoiceFormState;
  setField: <K extends keyof InvoiceFormState>(key: K, value: InvoiceFormState[K]) => void;
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
  customers: CustomerBrief[];
  tagOptions: TagInfo[];
  /** v2.5.5（用户拍板）：移除新建发票表单内的识别按钮（批量识别走发票页「批量 AI 识别」面板，表单识别入口冗余） */
  stagedIdentifyName?: string;
}) {
  // 客户下拉：options 重建后补应用选中值（v2.5.4 预填）
  let customerSelectRef: HTMLSelectElement | undefined;
  createEffect(() => {
    props.customers;
    const v = props.form.customer;
    if (customerSelectRef && customerSelectRef.value !== v) customerSelectRef.value = v;
  });
  return (
    <Show when={props.editor}>
      <Modal
        open
        title={props.editor?.mode === "edit" ? "编辑发票" : "新建发票"}
        size="2xl"
        onClose={props.onClose}
        // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
        dirty={props.dirty}
        onCloseRequest={props.onCloseRequest}
      >
        <div class="p-6">
          <h2 class="text-xl font-bold mb-4">{props.editor?.mode === "edit" ? "编辑发票" : "新建发票"}</h2>
          {/* v2.5.5（用户拍板）：移除新建发票表单内识别按钮（批量识别走发票页「批量 AI 识别」面板）；识别暂存源仅剩展示 */}
          <Show when={props.stagedIdentifyName}>
            <div class="mb-4">
              <span class="text-xs text-emerald-700">
                已识别待归档：{props.stagedIdentifyName}（确认登记时归档）
              </span>
            </div>
          </Show>
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
              <MoneyInput
                class="input w-full"
                placeholder="如：1250.50"
                value={props.form.amount}
                onChange={(v) => props.setField("amount", v)}
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
                ref={(el) => { customerSelectRef = el; }}
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
