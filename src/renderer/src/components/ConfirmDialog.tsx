import Modal from "./ui/Modal";

/**
 * 极简确认弹窗（替代 window.confirm，v2.5.1 T2 迁 Modal 底座）：
 * - 对外 props 完全不变（title/message/confirmLabel/danger/onConfirm/onCancel），15 处调用点零改动
 * - danger=true 时确认按钮为红色（btn-danger）
 * - 行为增益（登记 CHANGELOG）：Esc/overlay 关闭 + 焦点困守由 Modal/layerStack 提供（测试 P2）
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
    <Modal open title={props.title} onClose={props.onCancel} size="md">
      <div class="p-6">
        <h3 class="text-lg font-semibold mb-2">{props.title}</h3>
        <p class="text-sm text-surface-600 mb-6">{props.message}</p>
        <div class="flex gap-3 justify-end">
          <button class="btn-secondary" onClick={props.onCancel}>
            取消
          </button>
          <button class={props.danger ? "btn-danger" : "btn-primary"} onClick={props.onConfirm}>
            {props.confirmLabel ?? "确认"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
