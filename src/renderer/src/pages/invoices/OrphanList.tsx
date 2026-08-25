import { For, Show } from "solid-js";
import EmptyState from "~/components/EmptyState";
import ContextMenu from "~/components/ContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { baseNameOf } from "./utils";
import type { FileEntry } from "~/types";

/**
 * 孤儿未建档列表（PLAN-v2.5.5 §二 修复3 挂接，B3 任务 D）：
 * 展示扫描出的「目录有文件但台账无记录」的档案文件（工作区相对路径），
 * 每条提供 补建（带 file_path 预填新建）/ 删除（走回收站 file 单条目，账物分离）/ 可选预览。
 * 发票/入库/报价三业务共用（kind 仅用于文案与空态图标）。
 * v2.5.5 打磨 2：行双击 = 预览；行右键 = 文件菜单（预览/系统打开/在文件夹中显示/删除 + 补建）。
 */
export default function OrphanList(props: {
  orphans: string[];
  kind: "invoice" | "inbound" | "quote";
  onRecover: (rel: string) => void;
  onDelete: (rel: string) => void;
  onPreview?: (rel: string) => void;
}) {
  const ctxMenu = useContextMenu<string>();

  /** 工作区相对路径 → FileEntry（供右键系统打开/在文件夹中显示；与 Invoices/Quotes 的 fileEntryOf 同构） */
  const entryOf = (rel: string): FileEntry | null => {
    const ws = currentWorkspace()?.path;
    if (!ws) return null;
    return {
      name: baseNameOf(rel),
      path: `${ws.replace(/\\/g, "/")}/${rel}`,
      size: 0,
      modified: "",
      file_type: rel.toLowerCase().endsWith(".pdf") ? "pdf" : "image",
      thumbnail_path: null,
    };
  };

  const menuItems = () => {
    const rel = ctxMenu.payload();
    if (!rel) return [];
    const entry = entryOf(rel);
    if (!entry) return [];
    const items = buildFileContextMenuItems({
      file: entry,
      onPreview: () => props.onPreview?.(rel),
      onOpenDefault: (f) => void api.files.openWithDefaultApp(f.path),
      onShowInExplorer: (paths) => void api.files.showFilesInExplorer(paths),
      onDelete: () => props.onDelete(rel),
    });
    // 补建（带此文件预填新建台账记录）恒显示，追加到菜单末尾
    items.push({ label: "补建台账", icon: "➕", action: () => props.onRecover(rel) });
    return items;
  };

  return (
    <div class="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto pr-1">
      <Show when={props.orphans.length > 0} fallback={
        <div class="flex-1 flex items-center justify-center">
          <EmptyState icon="🎉" title="没有未建档文件" desc="所有归档文件均已登记" />
        </div>
      }>
        <For each={props.orphans}>
          {(rel) => (
            <div
              class="card p-3 flex items-center gap-3"
              onDblClick={() => props.onPreview?.(rel)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                ctxMenu.open(e, rel);
              }}
              title={props.onPreview ? "双击预览 · 右键更多操作" : "右键更多操作"}
            >
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

      <Show when={ctxMenu.show()}>
        <ContextMenu x={ctxMenu.x()} y={ctxMenu.y()} onClose={ctxMenu.close} items={menuItems()} />
      </Show>
    </div>
  );
}
