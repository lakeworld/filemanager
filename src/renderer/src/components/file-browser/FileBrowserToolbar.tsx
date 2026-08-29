import { For, Show } from "solid-js";
import { BUILTIN_NOTES_FOLDER } from "../../constants/notes";

/**
 * 文件管理视图子文件夹工具栏（v2.5.1 T3 波2 拆分）：
 * 子文件夹 tab 切换 + 删除当前类型/新建子文件夹（v2.5.5 起客户/供应商均开放操作，产品集区按类型显示）。
 * 语义色已收敛（T1：danger）。
 * v2.5.7（A2 笔记）：内建「笔记」子文件夹不显示删除按钮（core 双守卫：deleteSubfolder/renameSubfolder 拒绝）。
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
  /** v2.5.7（A2 笔记）：内建「笔记」子文件夹视图的新建笔记按钮（其他子文件夹不显示） */
  onNewNote?: () => void;
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
        {/* v2.5.5（对齐客户）：供应商子文件夹从固定集改可配置——客户/供应商均显示删除/新建（产品集区按类型文案）。
            v2.5.7（A2 笔记）：内建「笔记」不可删——按钮隐藏（core 兜底拒绝） */}
        <Show when={props.currentSub !== BUILTIN_NOTES_FOLDER}>
          <button
            class="btn-secondary text-sm text-danger-600 hover:bg-danger-50 hover:border-danger-200"
            onClick={props.onDeleteSubfolder}
          >
            🗑️ 删除当前{props.isCustomer || props.isSupplier ? "子文件夹" : `${props.typeLabel}类型`}
          </button>
        </Show>
        {/* v2.5.7（A2 笔记）：内建「笔记」视图显示新建笔记（工作台/文件区两入口之一） */}
        <Show when={props.currentSub === BUILTIN_NOTES_FOLDER && props.onNewNote}>
          <button class="btn-secondary text-sm" onClick={() => props.onNewNote?.()}>
            📝 新建笔记
          </button>
        </Show>
        <button class="btn-secondary text-sm" onClick={props.onNewSubfolder}>
          ➕ 新建{props.isCustomer || props.isSupplier ? "子文件夹" : `${props.typeLabel}类型`}
        </button>
      </div>
    </div>
  );
}
