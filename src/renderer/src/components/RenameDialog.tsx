import { Show, createSignal } from "solid-js";
import Modal from "~/components/ui/Modal";
import Input from "~/components/ui/Input";

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
    <Modal
      open
      title="重命名"
      size="md"
      framed
      onClose={props.onCancel}
      // v2.5.8 D14（framed 收口）：动作按钮进页脚槽（`.dlg-footer` 自带 justify-end + gap-3，
      // 原来那层 `flex justify-end gap-2 mt-5` 随之内距一起作废）；class 逐字未动
      // （`text-sm` 是尺寸类、`disabled` 变体五档里没有，都不在档覆盖范围内 ⇒ 原样留）
      footer={
        <>
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
        </>
      }
    >
      {/* v2.5.8 D14：手写 `<h2>` 与手搓白卡外壳（`bg-white rounded-2xl p-6 shadow-xl`）已删——
          framed 下面板本体 `.modal-panel` 就是实底白卡、`.dlg-header` 显示 title、`.dlg-body` 给 px-6 py-5，
          留着就是双卡 + 双内边距 + 双标题。仍包一层 div：让 `.dlg-body` 的 `flex flex-col gap-4`
          只作用在这一个子节点上，Input 与错误行原有的 mt-2 节奏保持不变（不趁迁移改版式）。 */}
      <div>
        <Input
        class="w-full"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
          }}
          ariaLabel="新文件名"
          placeholder={props.currentName}
        />
        <Show when={props.error}>
          <p class="mt-2 text-sm text-danger-600">{props.error}</p>
        </Show>
      </div>
    </Modal>
  );
}
