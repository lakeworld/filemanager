import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import Modal from "~/components/ui/Modal";
import { api } from "~/wails/api";
import {
  currentWorkspace,
  productSets,
  loadProductSets,
  workspaceConfig,
} from "~/stores/workspace";

/**
 * 「移动到…」目标选择对话框（v2.3.x UI 统一批）。
 * 复用导入对话框的布局：产品集下拉 + 图包/证书 toggle + 子文件夹 chips。
 * 确认后调用 api.files.move（结构化目标，由后端拼路径），成功后即时回调 onMoved（页面刷新列表）并关闭。
 */
export default function MoveDialog(props: {
  paths: string[];
  onClose: () => void;
  onMoved?: () => void;
}) {
  const [selectedProductSet, setSelectedProductSet] = createSignal("");
  const [targetType, setTargetType] = createSignal<"image" | "cert">("image");
  const [subFolder, setSubFolder] = createSignal("");
  const [status, setStatus] = createSignal<"idle" | "moving" | "error">("idle");
  const [errorMsg, setErrorMsg] = createSignal("");

  createEffect(() => {
    if (currentWorkspace()) {
      void loadProductSets();
    }
  });

  const imageFolders = () => workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"];
  const certFolders = () => workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"];

  // 收尾轮：Esc 关闭（移动进行中不允许，只能等待完成）
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (status() !== "moving") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const handleMove = async () => {
    const ws = currentWorkspace();
    if (!ws) {
      setStatus("error");
      setErrorMsg("未打开工作区");
      return;
    }
    const ps = selectedProductSet();
    const type = targetType();
    const sub = subFolder();
    if (!ps || !sub) return;

    setStatus("moving");
    setErrorMsg("");
    try {
      const result = await api.files.move({
        paths: props.paths,
        target_product_set: ps,
        target_type: type,
        sub_folder: sub,
      });
      if (!result.success) {
        setStatus("error");
        setErrorMsg(result.error || "移动失败");
        return;
      }
      // v2.4.2：聚合结果部分失败不回滚——有失败项时展示明细且不关闭对话框（用户可重试/改目标）
      if (result.data && result.data.failed.length > 0) {
        setStatus("error");
        setErrorMsg(`${result.data.moved.length} 个成功，${result.data.failed.length} 个失败：${result.data.failed[0].error}`);
        return;
      }
      // P0-4：成功后即时关闭并通知父级刷新（去掉 0.9s 成功态停留）
      setStatus("idle");
      props.onMoved?.();
      props.onClose();
    } catch (err) {
      setStatus("error");
      setErrorMsg(String(err));
    }
  };

  return (
    // v2.5.3（P2-7）：移动进行中 lockOpen——Esc/遮罩均不触发 onClose（照 ArchiveProgressDialog 先例）
    <Modal open title="移动到…" size="md" lockOpen={status() === "moving"} onClose={props.onClose}>
      <div class="bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 class="text-xl font-bold mb-4">移动到…</h2>

        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1">产品集</label>
            <select
              class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              value={selectedProductSet()}
              onChange={(e) => setSelectedProductSet(e.currentTarget.value)}
            >
              <option value="">选择产品集</option>
              <For each={productSets()}>
                {(ps) => <option value={ps.name}>{ps.name}</option>}
              </For>
            </select>
          </div>

          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1">目标类型</label>
            <div class="flex bg-surface-100 rounded-lg p-1">
              <button
                class={`flex-1 py-2 text-sm rounded-md transition-colors ${targetType() === "image" ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500"}`}
                onClick={() => {
                  setTargetType("image");
                  setSubFolder(imageFolders()[0]);
                }}
              >
                🖼️ 图包
              </button>
              <button
                class={`flex-1 py-2 text-sm rounded-md transition-colors ${targetType() === "cert" ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500"}`}
                onClick={() => {
                  setTargetType("cert");
                  setSubFolder(certFolders()[0]);
                }}
              >
                📜 证书
              </button>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1">子文件夹</label>
            <div class="flex bg-surface-100 rounded-lg p-1 flex-wrap gap-1">
              <For each={targetType() === "image" ? imageFolders() : certFolders()}>
                {(folder) => (
                  <button
                    class={`px-4 py-2 text-sm rounded-md transition-colors ${subFolder() === folder ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500"}`}
                    onClick={() => setSubFolder(folder)}
                  >
                    {folder}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>

        <Show when={status() === "error" && errorMsg()}>
          <div class="mt-4 p-3 bg-danger-50 border border-danger-100 rounded-lg text-sm text-danger-700">
            {errorMsg()}
          </div>
        </Show>

        <div class="flex gap-3 justify-end mt-6">
          <button class="btn-secondary" onClick={props.onClose}>
            取消
          </button>
          <button
            class="btn-primary"
            onClick={() => void handleMove()}
            disabled={!selectedProductSet() || !subFolder() || status() === "moving"}
          >
            {status() === "moving" ? "移动中..." : `移动 ${props.paths.length} 个文件`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
