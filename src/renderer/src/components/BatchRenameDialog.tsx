import { Show, For, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import Modal from "~/components/ui/Modal";
import { api } from "~/wails/api";
import { batchRenameTargets } from "~/utils/batchRename";
import type { FileEntry, NamingTemplate } from "~/types";

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
    <Modal open title={`批量重命名 ${props.files.length} 个文件`} size="xl" onClose={props.onClose}>
      <div class="bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 class="text-xl font-bold mb-4">批量重命名 {props.files.length} 个文件</h2>

        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-surface-700 mb-1">起始序号</label>
            <input
              type="number"
              min={0}
              class="w-32 px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
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

        <div class="flex gap-3 justify-end mt-6">
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
        </div>
      </div>
    </Modal>
  );
}
