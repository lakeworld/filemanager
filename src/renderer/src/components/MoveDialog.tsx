import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import Modal from "~/components/ui/Modal";
import SearchSelect from "~/components/ui/SearchSelect";
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

  /**
   * v2.5.8 D19（体验批 B9）：打开对话框即默认选中**当前类型的首个子文件夹**。
   * 原状态是 `subFolder("")` 且只在点类型 toggle 时才 `setSubFolder(首个)` ⇒
   * 「图包」是默认类型但 chips 无高亮，「移动」按钮灰着且不说明原因，每次都要多点一下。
   * 用 effect 而不是把初值写成 `imageFolders()[0]`：`workspaceConfig()` 是异步加载的，
   * 初值求值时配置常常还没到，只会拿到兜底数组甚至空 ⇒ 依然灰按钮。
   * 用户手选过（subFolder 非空）就不插手；切换类型的既有行为（按类型重置为首个）一字未动。
   */
  createEffect(() => {
    if (subFolder()) return;
    const first = (targetType() === "image" ? imageFolders() : certFolders())[0];
    if (first) setSubFolder(first);
  });

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
    <Modal
      open
      title="移动到…"
      size="md"
      // v2.5.8 D14（framed 收口）：`size`/`lockOpen` 一字未动。迁移前是 448px 面板里再套一张 `max-w-lg`
      // 同色白卡（卡宽被面板顶住 ⇒ 正文实宽 400px）；套 framed 后手搓卡作废、正文改由 `.dlg-body` 的
      // px-6 承担 ⇒ 448 − 48 = 400px，正文宽度零变化（此处与 BatchRenameDialog 的 +64px 不同，无需裁决）。
      framed
      lockOpen={status() === "moving"}
      onClose={props.onClose}
      // 动作按钮整行进页脚槽（`.dlg-footer` 自带 justify-end + gap-3，原来那层 `flex gap-3 justify-end mt-6` 作废）；
      // 两个按钮的 class、文案、onClick、disabled 表达式逐字未动，只是换个位置
      footer={
        <>
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
        </>
      }
    >
      {/* v2.5.8 D14：手写 `<h2>` 与手搓白卡外壳材质（`bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl`）已删
          ——framed 下面板本体 `.modal-panel` 就是实底白卡、`.dlg-header` 显示 title、`.dlg-body` 给 px-6 py-5，
          留着就是双卡 + 双内边距 + 双标题（title 文案「移动到…」原样住在 title 属性里，一字未动）。
          外壳 div 与它的 onClick 一字未动（Modal 面板自己已 stop 冒泡，这处冗余但不属本轮可删项）。
          仍包一层 div，使 `.dlg-body` 的 `flex flex-col gap-4` 只作用在这一个子节点上，
          内层 `space-y-4` / `mt-4` 的原有节奏保持不变（不趁迁移改版式）。 */}
      <div onClick={(e) => e.stopPropagation()}>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1">产品集</label>
            {/* v2.5.8 D9（W4 控件统一 II）：原生 select → SearchSelect（弹窗内走非紧凑 h-9 档）。
                本批只换控件：进入时子文件夹默认不选中那条（盘点台账 B9）不在本批动。 */}
            <SearchSelect
              class="w-full"
              ariaLabel="移动到哪个产品集"
              options={[
                { value: "", label: "选择产品集" },
                ...productSets().map((ps) => ({ value: ps.name, label: ps.name })),
              ]}
              value={selectedProductSet()}
              placeholder="选择产品集"
              matchTriggerWidth={false}
              onChange={setSelectedProductSet}
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1">目标类型</label>
            {/* v2.5.8 D14（样式统一收口）：这对 toggle 与「拖拽入区」选择条同形同料，
                照 `GlobalDropOverlay.tsx:434/445` 的既有写法收进 `.seg-item` / `.seg-item-on` 单点档
                （档给 px-4 py-2 text-sm rounded-md + 精确属性过渡，与原内联串逐项等值 ⇒ 删掉重复的四项）；
                `flex-1` 是布局尺寸、选中/未选中的颜色随语义 ⇒ 原样留在调用点。
                外层 `flex bg-surface-100 rounded-lg p-1` 是手搓 seg-track，改它 = 动容器版式（档多 1px 描边会撑高 2px），
                与 GlobalDropOverlay/Invoices 同一口径：留待主线程拍板。 */}
            <div class="flex bg-surface-100 rounded-lg p-1">
              <button
                class={`seg-item flex-1 ${targetType() === "image" ? "seg-item-on" : "text-surface-500"}`}
                onClick={() => {
                  setTargetType("image");
                  setSubFolder(imageFolders()[0]);
                }}
              >
                🖼️ 图包
              </button>
              <button
                class={`seg-item flex-1 ${targetType() === "cert" ? "seg-item-on" : "text-surface-500"}`}
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
            {/* v2.5.8 D14（样式统一收口）：同上收进 `.seg-item` / `.seg-item-on`（原串 `px-4 py-2 text-sm rounded-md transition-colors`
                与档逐项等值，故整串删掉）；选中底色/未选中文字色留在调用点（形状档刻意不管颜色）。 */}
            <div class="flex bg-surface-100 rounded-lg p-1 flex-wrap gap-1">
              <For each={targetType() === "image" ? imageFolders() : certFolders()}>
                {(folder) => (
                  <button
                    class={`seg-item ${subFolder() === folder ? "seg-item-on" : "text-surface-500"}`}
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
      </div>
    </Modal>
  );
}
