import { For, Show } from "solid-js";

/**
 * 文件管理视图子文件夹工具栏（v2.5.1 T3 波2 拆分）：
 * 子文件夹 tab 切换 + 删除当前类型/新建子文件夹（supplier 固定集隐藏操作按钮）。
 * 逻辑零改动；语义色已收敛（T1：danger）。
 */
export default function FileBrowserToolbar(props: {
  subFolders: string[];
  currentSub: string;
  typeLabel: string;
  isCustomer: boolean;
  isSupplier: boolean;
  /** v2.5.5（对齐）：客户/供应商文件区显示「选择文件并添加」按钮（产品集区拖出拖入，红线不显示） */
  showImport: boolean;
  onImportFiles: () => void;
  onNavigate: (sub: string) => void;
  onDeleteSubfolder: () => void;
  onNewSubfolder: () => void;
}) {
  return (
    <div class="flex items-center justify-between mb-6">
      <div class="flex bg-surface-100 rounded-lg p-1">
        <For each={props.subFolders}>
          {(sub) => (
            <button
              class={`px-4 py-2 text-sm rounded-md transition-colors ${props.currentSub === sub ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500 hover:text-surface-700"}`}
              onClick={() => props.onNavigate(sub)}
            >
              {sub}
            </button>
          )}
        </For>
      </div>
      <div class="flex gap-2">
        {/* v2.5.5（对齐）：按钮导入入口——客户/供应商文件区专属（台账/业务层不用拖拽；产品集区拖出拖入是红线，不显示） */}
        <Show when={props.showImport}>
          <button class="btn-secondary text-sm" onClick={props.onImportFiles}>
            📂 选择文件并添加
          </button>
        </Show>
        {/* v2.4.9 S2：supplier 子文件夹为固定集（决策 1），隐藏新建/删除按钮保持不变式 */}
        <Show when={!props.isSupplier}>
          <button
            class="btn-secondary text-sm text-danger-600 hover:bg-danger-50 hover:border-danger-200"
            onClick={props.onDeleteSubfolder}
          >
            🗑️ 删除当前{props.isCustomer ? "子文件夹" : `${props.typeLabel}类型`}
          </button>
          <button
            class="btn-secondary text-sm"
            onClick={props.onNewSubfolder}
          >
            ➕ 新建{props.isCustomer ? "子文件夹" : `${props.typeLabel}类型`}
          </button>
        </Show>
      </div>
    </div>
  );
}
