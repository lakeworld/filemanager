import { Show } from "solid-js";
import Modal from "~/components/ui/Modal";
import Button from "~/components/ui/Button";

/**
 * 删除台账记录确认弹窗（v2.5.1 T3 波1 拆分 + overlay→Modal 迁移）：
 * 账物分离：默认只删记录；可选同时删除归档文件（移入回收站）。逻辑零改动。
 */
export default function DeleteRecordModal(props: {
  target: { kind: "invoice" | "inbound"; key: string; name: string; withFile: boolean } | null;
  onToggleWithFile: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Show when={props.target}>
      {(t) => (
        <Modal open title={`删除${t().kind === "invoice" ? "发票" : "入库单"}记录`} size="md" onClose={props.onCancel}>
          <div class="p-6">
            <h3 class="text-lg font-semibold mb-2">
              删除{t().kind === "invoice" ? "发票" : "入库单"}记录
            </h3>
            <p class="text-sm text-surface-600 mb-4">
              确定删除「{t().name}」的{t().kind === "invoice" ? "发票台账" : "入库单"}记录吗？
              账物分离：删除记录不影响归档文件。
            </p>
            <label class="flex items-center gap-2 text-sm text-surface-700 mb-6 cursor-pointer">
              <input
                type="checkbox"
                class="w-4 h-4 accent-danger-600"
                checked={t().withFile}
                onChange={props.onToggleWithFile}
              />
              同时删除归档文件（移入回收站）
            </label>
            <div class="flex gap-3 justify-end">
              <Button variant="secondary" onClick={props.onCancel}>取消</Button>
              <Button variant="danger" onClick={() => void props.onConfirm()}>删除</Button>
            </div>
          </div>
        </Modal>
      )}
    </Show>
  );
}
