import { Show, createSignal } from "solid-js";
import Modal from "~/components/ui/Modal";

/**
 * 单文件重命名对话框（v2.5.2，替代 window.prompt ×4：FileBrowserView/Certs/Images/Search）。
 * - Modal 底座（Esc/overlay/焦点困守/层栈，v2.5.1 T2 契约）
 * - 本地即时校验：空名 / 与原名一致 → 确定按钮禁用（同名 = 不操作，与旧 prompt 语义一致）
 * - 非法字符 / 保留名 / 磁盘重名等最终校验由后端 api.files.rename 兜底，错误经 props.error 回传展示
 *   （前端不重复造校验逻辑——批量重命名的冲突绕行是批量语义，单文件不适用）
 * - 确认回调传 trim 后的新名；取消/空名/未变更不回调
 */
export default function RenameDialog(props: {
  currentName: string;
  busy?: boolean;
  error?: string;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = createSignal(props.currentName);

  const trimmed = () => value().trim();
  // 空名 / 与原名一致 → 不可提交（同名重命名无意义，与旧 prompt「同名直接返回」语义一致）
  const invalid = () => trimmed() === "" || trimmed() === props.currentName;

  const confirm = () => {
    if (invalid()) return;
    props.onConfirm(trimmed());
  };

  return (
    <Modal open title="重命名" size="md" onClose={props.onCancel}>
      <div class="bg-white rounded-2xl p-6 shadow-xl">
        <h2 class="text-xl font-bold mb-4">重命名</h2>
        <input
          class="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:border-primary-500 focus:outline-none"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
          }}
          aria-label="新文件名"
          placeholder={props.currentName}
        />
        <Show when={props.error}>
          <p class="mt-2 text-sm text-danger-600">{props.error}</p>
        </Show>
        <div class="flex justify-end gap-2 mt-5">
          <button class="btn-secondary text-sm" onClick={props.onCancel}>
            取消
          </button>
          <button
            class="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={invalid() || props.busy}
            onClick={confirm}
          >
            {props.busy ? "重命名中…" : "确定"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
