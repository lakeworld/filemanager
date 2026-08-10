/**
 * 极简确认弹窗（替代 window.confirm）：遮罩 + 居中卡片 + 确认/取消。
 * danger=true 时确认按钮为红色（删除/清除引用等危险操作）。
 * 样式与项目既有弹窗一致：fixed inset-0 bg-black/50 flex items-center justify-center z-50 + bg-white rounded-2xl。
 */
export default function ConfirmDialog(props: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={props.onCancel}
    >
      <div
        class="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="text-lg font-semibold mb-2">{props.title}</h3>
        <p class="text-sm text-surface-600 mb-6">{props.message}</p>
        <div class="flex gap-3 justify-end">
          <button class="btn-secondary" onClick={props.onCancel}>
            取消
          </button>
          <button
            class={
              props.danger
                ? "inline-flex items-center justify-center gap-2 px-4 py-2 bg-red-500 text-white font-medium rounded-lg transition-all duration-200 hover:bg-red-600 active:scale-95"
                : "btn-primary"
            }
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
