import { For, Show } from "solid-js";
import type { BatchDraft } from "./batchIdentify";
import { missingDraftFields } from "./batchIdentify";
import { baseNameOf, fmtMoney } from "./utils";

/**
 * AI 识别待确认区（PLAN-v2.5.6，用户拍板：识别结果先落「未建档」视图常驻待确认区，
 * 用户确认后才归档登记）。渲染在发票 tab 未建档视图顶部：
 * - 草稿行：文件名 + 识别字段摘要（号码/金额/开票方→购买方/日期），字段不全标黄注明缺项；
 *   「登记」= 开新建弹窗预填（保存才归档），「✕」= 移出暂存（源文件原地不动）。
 * - 失败行：文件名 + 失败原因；「重试」= 该路径重走识别（区头「重试全部」同理）。
 * 纯展示组件，状态与动作全经 props 注入（store 在 Invoices.tsx 接线）。
 */
export default function StagedIdentifyList(props: {
  drafts: BatchDraft[];
  failed: { sourcePath: string; message: string }[];
  registering: boolean;
  onConfirmOne: (draft: BatchDraft) => void;
  onRemoveDraft: (sourcePath: string) => void;
  onRegisterAll: () => void;
  onRetryFailed: () => void;
  onDismissFailed: (sourcePath: string) => void;
  onClear: () => void;
  onPreview?: (sourcePath: string) => void;
}) {
  /** 字段齐全（可批量登记）的草稿数 */
  const readyCount = () => props.drafts.filter((d) => missingDraftFields(d).length === 0).length;

  return (
    <div class="card p-3 shrink-0 border-primary-200 bg-primary-50/40" data-testid="staged-identify">
      <div class="flex items-center justify-between px-1 py-1 flex-wrap gap-2">
        <span class="text-sm font-medium text-primary-800">
          🤖 AI 识别待确认（{props.drafts.length} 条{props.failed.length > 0 ? ` · 失败 ${props.failed.length} 条` : ""}）
          <span class="font-normal text-surface-500 ml-2">确认登记后才归档，移除/关闭应用均不动源文件</span>
        </span>
        <div class="flex items-center gap-2">
          <Show when={props.failed.length > 0}>
            <button class="btn-secondary text-xs" onClick={props.onRetryFailed} disabled={props.registering}>
              🔄 重试失败项
            </button>
          </Show>
          <button
            class="btn-primary text-xs"
            disabled={props.registering || readyCount() === 0}
            title={readyCount() === 0 ? "没有字段齐全的条目可批量登记（可逐条「登记」补全）" : `逐条归档并登记字段齐全的 ${readyCount()} 条`}
            onClick={props.onRegisterAll}
          >
            {props.registering ? "登记中…" : `全部登记（${readyCount()}）`}
          </button>
          <button class="btn-secondary text-xs" onClick={props.onClear} disabled={props.registering} title="清空待确认区（不动源文件）">
            清空
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-2 mt-2">
        <For each={props.drafts}>
          {(d) => {
            const missing = () => missingDraftFields(d);
            return (
              <div
                class="card p-3 flex items-center gap-3 bg-white"
                onDblClick={() => props.onPreview?.(d.sourcePath)}
                title="双击预览源文件"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-medium text-surface-900 truncate" title={d.sourcePath}>
                      {baseNameOf(d.sourcePath)}
                    </span>
                    <Show when={missing().length > 0}>
                      <span class="text-xs px-1.5 py-0.5 rounded bg-warning-50 text-warning-700 shrink-0">
                        缺{missing().join("、")}
                      </span>
                    </Show>
                    <For each={d.warnings}>
                      {(w) => <span class="text-xs px-1.5 py-0.5 rounded bg-surface-100 text-surface-500 shrink-0">{w}</span>}
                    </For>
                  </div>
                  <div class="text-xs text-surface-500 mt-1 truncate">
                    {d.fields.number || "（无号码）"} · ¥{d.fields.amount != null ? fmtMoney(d.fields.amount) : "-"} ·{" "}
                    {d.fields.seller || "?"} → {d.fields.buyer || "?"} · {d.fields.date || "无日期"}
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <Show when={props.onPreview}>
                    <button
                      class="text-surface-400 hover:text-primary-600 text-sm"
                      title="预览源文件"
                      onClick={() => props.onPreview?.(d.sourcePath)}
                    >
                      👁
                    </button>
                  </Show>
                  <button
                    class="btn-primary text-xs"
                    title="开新建发票弹窗预填本条目，确认登记才归档"
                    onClick={() => props.onConfirmOne(d)}
                  >
                    登记…
                  </button>
                  <button
                    class="text-surface-400 hover:text-danger-500 px-1"
                    title="移出待确认（源文件原地保留）"
                    onClick={() => props.onRemoveDraft(d.sourcePath)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          }}
        </For>

        <For each={props.failed}>
          {(f) => (
            <div class="card p-3 flex items-center gap-3 bg-white border-danger-200">
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-surface-900 truncate" title={f.sourcePath}>
                  {baseNameOf(f.sourcePath)}
                </div>
                <div class="text-xs text-danger-600 mt-1 truncate" title={f.message}>
                  识别失败：{f.message}
                </div>
              </div>
              <button
                class="text-surface-400 hover:text-danger-500 px-1 shrink-0"
                title="移出待确认（源文件原地保留）"
                onClick={() => props.onDismissFailed(f.sourcePath)}
              >
                ✕
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
