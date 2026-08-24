import { For, Show } from "solid-js";
import EmptyState from "~/components/EmptyState";
import { baseNameOf } from "./utils";

/**
 * 孤儿未建档列表（PLAN-v2.5.5 §二 修复3 挂接，B3 任务 D）：
 * 展示扫描出的「目录有文件但台账无记录」的档案文件（工作区相对路径），
 * 每条提供 补建（带 file_path 预填新建）/ 删除（走回收站 file 单条目，账物分离）/ 可选预览。
 * 发票/入库/报价三业务共用（kind 仅用于文案与空态图标）。
 */
export default function OrphanList(props: {
  orphans: string[];
  kind: "invoice" | "inbound" | "quote";
  onRecover: (rel: string) => void;
  onDelete: (rel: string) => void;
  onPreview?: (rel: string) => void;
}) {
  return (
    <div class="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto pr-1">
      <Show when={props.orphans.length > 0} fallback={
        <div class="flex-1 flex items-center justify-center">
          <EmptyState icon="🎉" title="没有未建档文件" desc="所有归档文件均已登记" />
        </div>
      }>
        <For each={props.orphans}>
          {(rel) => (
            <div class="card p-3 flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-surface-900 truncate" title={rel}>
                  {baseNameOf(rel)}
                </div>
                <div class="text-xs text-surface-400 truncate" title={rel}>{rel}</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Show when={props.onPreview}>
                  <button
                    class="text-surface-400 hover:text-primary-600 text-sm"
                    title="预览文件"
                    onClick={() => props.onPreview?.(rel)}
                  >
                    👁
                  </button>
                </Show>
                <button class="btn-secondary text-xs" title="带此文件预填新建台账记录" onClick={() => props.onRecover(rel)}>
                  补建
                </button>
                <button
                  class="text-xs px-3 py-1.5 text-surface-700 bg-white hover:bg-surface-50 border border-surface-200 rounded-lg hover:text-danger-600"
                  title="删除该文件（走回收站，不影响任何台账记录）"
                  onClick={() => props.onDelete(rel)}
                >
                  删除
                </button>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
