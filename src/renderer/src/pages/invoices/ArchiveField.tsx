import { Show } from "solid-js";

/**
 * 归档文件字段（v2.5.1 T3 波1 拆分，Invoices 弹窗共用）：
 * 未归档 → 选择本地文件并归档；已归档 → 路径 + 预览 + 换绑。
 * 纯结构搬迁；语义色收敛（T1）：缺失警示 text-red-600 → text-danger-600。
 */
export default function ArchiveField(props: {
  label: string;
  filePath: string;
  missing: boolean;
  onPick: () => void;
  onPreview: () => void;
}) {
  return (
    <div>
      <label class="block text-sm font-medium text-surface-700 mb-1">{props.label}</label>
      <Show
        when={props.filePath}
        fallback={
          <button type="button" class="btn-secondary text-sm" onClick={props.onPick}>
            📂 选择本地文件并归档
          </button>
        }
      >
        <div class="flex items-center gap-2 text-sm">
          <span
            class={`truncate ${props.missing ? "text-danger-600" : "text-surface-600"}`}
            title={props.filePath}
          >
            📎 {props.filePath}
          </span>
          <Show when={props.missing}>
            <span class="text-danger-600 text-xs shrink-0">文件缺失</span>
          </Show>
          <button type="button" class="text-primary-600 hover:text-primary-700 text-xs shrink-0" onClick={props.onPreview}>
            预览
          </button>
          <button type="button" class="text-surface-500 hover:text-primary-600 text-xs shrink-0" onClick={props.onPick}>
            换绑
          </button>
        </div>
      </Show>
    </div>
  );
}
