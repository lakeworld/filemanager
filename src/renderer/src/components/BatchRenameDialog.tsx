import { Show, For, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import Modal from "~/components/ui/Modal";
import { api } from "~/wails/api";
import { batchRenameTargets } from "~/utils/batchRename";
import type { FileEntry, NamingTemplate } from "~/types";
import Input from "~/components/ui/Input";

/**
 * 「批量重命名」对话框（v2.3.3 P2 引入，v2.4.9 S5 复用命名模板）。
 * 命名模板由父级传入（workspaceConfig().naming_template，缺省兜底默认对象），
 * ctx 的 product_set 槽位 = 当前实体名（产品集/客户/供应商，与导入语义一致）、sub_folder = 当前子文件夹；
 * 用户仅输入起始序号（默认 1），实时预览目标名列表（模板组合 + 序号补零位数按数量自适应，冲突自动加 _1）。
 * 应用时逐个调用 api.files.rename（每个文件一次 IPC，不新增后端批量 API），
 * 单文件失败跳过并汇总提示；全部成功才关闭并回调 onDone（父级刷新列表、清空选择）。
 */
export default function BatchRenameDialog(props: {
  files: FileEntry[];
  template: NamingTemplate;
  ctx: { targetProductSet: string; subFolder: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [startStr, setStartStr] = createSignal("1");
  const [status, setStatus] = createSignal<"idle" | "renaming" | "error">("idle");
  const [errorMsg, setErrorMsg] = createSignal("");

  const startNum = () => {
    const n = parseInt(startStr(), 10);
    return Number.isNaN(n) ? 1 : n;
  };

  // 目标名预览（含批内/磁盘重名绕行），随起始序号实时重算
  const targetNames = createMemo<string[]>(() =>
    batchRenameTargets(props.files, props.template, props.ctx, startNum()),
  );

  // 收尾轮：Esc 关闭（重命名进行中不允许，只能等待完成）
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (status() !== "renaming") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const handleApply = async () => {
    const files = props.files;
    const targets = targetNames();
    setStatus("renaming");
    setErrorMsg("");
    let ok = 0;
    let failed = 0;
    let firstErr = "";
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const target = targets[i];
      if (target === f.name) {
        ok++; // 目标名与原文件名一致（如序号恰好命中）→ 无需操作
        continue;
      }
      const r = await api.files.rename({ path: f.path, newName: target });
      if (r.success) {
        ok++;
      } else {
        failed++;
        if (!firstErr) firstErr = r.error || "未知错误";
      }
    }
    // 后台列表先刷新（成功时清空选择由父级 onDone 处理），避免残留陈旧文件名
    props.onDone();
    if (failed === 0) {
      props.onClose();
    } else {
      setStatus("error");
      setErrorMsg(`已重命名 ${ok} 个，失败 ${failed} 个：${firstErr}`);
    }
  };

  return (
    // v2.5.8 D14（framed 收口）：`size` 一字未动（仍 xl）。迁移前它是 576px 白面板里再套一张 512px 同色白卡，
    // 卡片内距 p-6 后正文实宽 464px；套 framed 后手搓卡作废、正文改由 `.dlg-body` 的 px-6 承担 ⇒ 正文宽 +64px。
    // 逐像素保住旧正文宽度要动 `size` 或补 max-w（都超出「只改 class 与注释」）⇒ 已列进本组「待裁决」。
    <Modal
      open
      title={`批量重命名 ${props.files.length} 个文件`}
      size="xl"
      framed
      onClose={props.onClose}
      // 动作按钮进页脚槽（`.dlg-footer` 自带 justify-end + gap-3，原来那层 `flex gap-3 justify-end mt-6` 作废）；
      // 两个按钮的 class 逐字未动（`btn-secondary`/`btn-primary` 本就已在统一档上，无被覆盖项可删）
      footer={
        <>
          <button class="btn-secondary" onClick={props.onClose} disabled={status() === "renaming"}>
            取消
          </button>
          <button
            class="btn-primary"
            onClick={() => void handleApply()}
            disabled={status() === "renaming"}
          >
            {status() === "renaming" ? "重命名中..." : `重命名 ${props.files.length} 个`}
          </button>
        </>
      }
    >
      {/* v2.5.8 D14：手写 `<h2>` 与手搓白卡外壳材质（`bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl`）已删
          ——framed 下面板本体就是实底白卡、`.dlg-header` 显示 title、`.dlg-body` 给 px-6 py-5，留着就是双卡双距双标题。
          外壳 div 与它的 onClick 一字未动（Modal 面板自己已 stop 冒泡，这处冗余但不属本轮可删项）。
          仍包一层 div，使 `.dlg-body` 的 `flex flex-col gap-4` 只作用在这一个子节点上，
          内层 `space-y-4` / `mt-4` 的原有节奏保持不变（不趁迁移改版式）。 */}
      <div onClick={(e) => e.stopPropagation()}>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1">起始序号</label>
            <Input
              type="number"
              min={0}
              class="w-32"
              value={startStr()}
              onInput={(e) => setStartStr(e.currentTarget.value)}
            />
            <p class="text-xs text-surface-400 mt-1">
              命名规则：{props.ctx.targetProductSet || "产品集名"}_{props.ctx.subFolder || "子文件夹"}_原文件名_序号
            </p>
          </div>

          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1">目标名预览</label>
            <div class="max-h-48 overflow-y-auto border border-surface-200 rounded-lg divide-y divide-surface-100">
              <For each={props.files}>
                {(file, i) => (
                  <div class="px-3 py-1.5 text-sm flex items-center justify-between gap-3">
                    <span class="text-surface-400 truncate">{file.name}</span>
                    <span class="text-surface-300 shrink-0">→</span>
                    <span class="text-surface-900 truncate">{targetNames()[i()]}</span>
                  </div>
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
