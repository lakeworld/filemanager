import Modal from "./ui/Modal";

/**
 * 极简确认弹窗（替代 window.confirm，v2.5.1 T2 迁 Modal 底座）：
 * - 对外 props 完全不变（title/message/confirmLabel/danger/onConfirm/onCancel），15 处调用点零改动
 * - danger=true 时确认按钮为红色（btn-danger）
 * - 行为增益（登记 CHANGELOG）：Esc/overlay 关闭 + 焦点困守由 Modal/layerStack 提供（测试 P2）
 * - v2.5.5（P0，B1 任务 B）：新增可选 cancelLabel（默认「取消」）——脏守卫「放弃未保存内容？」
 *   确认弹窗用「继续编辑」语义；不传时行为零变化。
 * - v2.5.8 D16（弹窗骨架收口）：改走 Modal framed 统一骨架（头部标题 + 固定页脚动作区），
 *   对外 props 与行为均不变。
 */
export default function ConfirmDialog(props: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  return (
    <Modal
      open
      title={props.title}
      onClose={props.onCancel}
      size="md"
      // v2.5.8 D16（弹窗骨架收口）：迁 framed——头部标题与页脚动作改由 Modal 骨架渲染；
      // 原手写标题行与底部按钮行随之删除（标题文案 = title 属性，一字未动，
      // e2e 仍按 role=dialog + 可及名命中；无 ✕ 后关闭途径 = 遮罩/Esc/页脚「取消」，本弹窗三者常在）
      framed
      footer={
        <>
          {/* .dlg-footer 自带 justify-end + gap-3，原 flex 容器去掉（留着就是双重布局） */}
          <button class="btn-secondary" onClick={props.onCancel}>
            {props.cancelLabel ?? "取消"}
          </button>
          <button class={props.danger ? "btn-danger" : "btn-primary"} onClick={props.onConfirm}>
            {props.confirmLabel ?? "确认"}
          </button>
        </>
      }
    >
      {/* framed 下 .dlg-body 自带 px-6 py-5，原 p-6 内边距交回骨架（留着就是双重留白） */}
      <div>
        <p class="text-sm text-surface-600">{props.message}</p>
      </div>
    </Modal>
  );
}
