import { Show, For, createMemo } from "solid-js";
import Modal from "~/components/ui/Modal";
import DatePicker from "~/components/DatePicker";
import TagInput from "~/components/TagInput";
import MoneyInput from "~/components/MoneyInput"; // v2.5.5（B2）：金额输入统一
import SearchSelect from "~/components/ui/SearchSelect";
import type { SearchSelectOption } from "~/components/ui/SearchSelect";
import ArchiveField from "./ArchiveField";
import { STATUSES } from "./utils";
import type { InvoiceFormState, InvoiceStatus, InvoiceRecord, CustomerBrief, SupplierBrief } from "./types";
import type { TagInfo } from "~/types";
import type { PluginFileCommand } from "~/plugins/registry";
import Textarea from "~/components/ui/Textarea";
import Input from "~/components/ui/Input";
/**
 * 发票新建/编辑弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 信号与保存逻辑保留在主文件（Invoices.tsx），本组件只做展示与字段编辑（props 显式化，D11）。
 * 逻辑零改动：字段校验/归档/保存均在主文件 saveInvoice 等 handler。
 * v2.5.4 曾为「客户下拉 options 异步重建丢选中」加过 ref 兜底；v2.5.8 D9 三个下拉换
 * `SearchSelect`（纯受控，显示文案由 value 反查）后该兜底整块作废，已删（见下方注释）。
 * 弹窗内控件按 §四「读字表面实底」红线：只换控件，不给面板加 blur/分隔线。
 */

const STATUS_OPTIONS: readonly SearchSelectOption[] = STATUSES.map((s) => ({ value: s, label: s }));

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
  /** v2.5.7 补丁线：关联供应商下拉选项（进项票归属；与入库单供应商下拉同源 suppliers store） */
  suppliers: SupplierBrief[];
  tagOptions: TagInfo[];
  /** v2.5.5（修正轮）：global 命令槽——新建发票 create 模式渲染「从文件识别」按钮（单文件；批量命令已过滤） */
  identifyCommands: PluginFileCommand[];
  identifying?: boolean;
  identifyWarnings?: string[];
  /** v2.5.5（B1 P0 归档后移）：识别到的源文件名（待归档展示；空表示未识别）——不再传已归档 rel */
  stagedIdentifyName?: string;
  onIdentify: (cmd: PluginFileCommand) => void;
}) {
  // v2.5.8 D9（W4 控件统一 II）：客户/供应商下拉换 SearchSelect 后，v2.5.4 起那套
  // 「options 重建后用 ref 补应用 value」的兜底**整块作废**——原生 select 会在 options
  // 异步重建时丢选中，而 SearchSelect 的显示文案由 `value` 反查 options 得出（纯受控），
  // 列表刷新不丢选中，也不需要 DOM 引用。值口径一字未动（空串 = 不关联）。
  const customerOptions = createMemo<readonly SearchSelectOption[]>(() => [
    { value: "", label: "不关联客户" },
    ...props.customers.map((c) => ({ value: c.name, label: c.name })),
  ]);
  const supplierOptions = createMemo<readonly SearchSelectOption[]>(() => [
    { value: "", label: "不关联供应商" },
    ...props.suppliers.map((s) => ({ value: s.name, label: s.name })),
  ]);
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
          {/* v2.5.5（修正轮）：global 命令槽——仅 create 模式渲染「从文件识别」按钮（单文件，识别成功暂存待归档）；批量识别走发票页「批量 AI 识别」面板 */}
          <Show when={props.editor?.mode === "create" && props.identifyCommands.length > 0}>
            <div class="mb-4">
              <div class="flex items-center gap-2 flex-wrap">
                <For each={props.identifyCommands}>
                  {(cmd) => (
                    <button
                      type="button"
                      class="btn-secondary text-sm"
                      disabled={props.identifying}
                      onClick={() => void props.onIdentify(cmd)}
                    >
                      {props.identifying ? "识别中…" : cmd.label}
                    </button>
                  )}
                </For>
                <Show when={props.stagedIdentifyName}>
                  <span class="text-xs text-emerald-700">
                    已识别待归档：{props.stagedIdentifyName}（确认登记时归档）
                  </span>
                </Show>
              </div>
              <Show when={props.identifyWarnings && props.identifyWarnings.length > 0}>
                <div class="mt-2">
                  <For each={props.identifyWarnings ?? []}>
                    {(w) => (
                      <p class="text-sm text-amber-600">⚠ {w}</p>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">发票号码 *</label>
              <Input
              class="w-full"
                placeholder="如：25312000000012345678"
                value={props.form.number}
                onInput={(e) => props.setField("number", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">发票代码</label>
              <Input
              class="w-full"
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
              <Input
              class="w-full"
                placeholder="销售方名称"
                value={props.form.seller}
                onInput={(e) => props.setField("seller", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">购买方抬头 *</label>
              <Input
              class="w-full"
                placeholder="购买方名称"
                value={props.form.buyer}
                onInput={(e) => props.setField("buyer", e.currentTarget.value)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">状态</label>
              <SearchSelect
                class="w-full"
                ariaLabel="发票状态"
                options={STATUS_OPTIONS}
                value={props.form.status}
                searchable={false}
                onChange={(v) => props.setField("status", v as InvoiceStatus)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">关联客户</label>
              <SearchSelect
                class="w-full"
                ariaLabel="关联客户"
                options={customerOptions()}
                value={props.form.customer}
                placeholder="不关联客户"
                matchTriggerWidth={false}
                onChange={(v) => props.setField("customer", v)}
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-surface-700 mb-1">关联供应商</label>
              <SearchSelect
                class="w-full"
                ariaLabel="关联供应商"
                options={supplierOptions()}
                value={props.form.supplier}
                placeholder="不关联供应商"
                matchTriggerWidth={false}
                onChange={(v) => props.setField("supplier", v)}
              />
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
              scope="ledger" // v2.5.7（A3）：台账域标签（发票/入库）
            />
          </div>
          <div class="mt-4">
            <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
            <Textarea
            class="w-full"
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
