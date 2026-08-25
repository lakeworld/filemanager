import { Show, For, createSignal, createEffect } from "solid-js";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import Modal from "~/components/ui/Modal";
import ContextMenu from "~/components/ContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { openPreview } from "~/stores/preview";
import { baseNameOf } from "./utils";
import { BATCH_LIMIT } from "./batchIdentify";
import type { FileEntry } from "~/types";

/**
 * 发票批量 AI 识别 · 多选文件面板（v2.5.5 打磨 2 改版，用户拍板）：
 * 「📂 选择文件并添加」→ 系统文件多选对话框（qihebox:dialog:openFiles，PDF/图片）→
 * 已选列表（≤10）→ 批量识别（onConfirm 传绝对路径数组，识别/归档链路不变）。
 * 双击文件 = 打开预览（FilePreviewModal）；右键 = 文件菜单（预览/系统打开/在文件夹中显示/复制）。
 */
export default function BatchIdentifyModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (paths: string[]) => void;
}) {
  const [selected, setSelected] = createSignal<FileEntry[]>([]);
  const ctxMenu = useContextMenu<FileEntry>();

  // 打开面板时回到空态
  createEffect(() => {
    if (props.open) setSelected([]);
  });

  const toEntry = (p: string): FileEntry => ({
    name: baseNameOf(p),
    path: p,
    size: 0,
    modified: "",
    file_type: /\.pdf$/i.test(p) ? "pdf" : "image",
    thumbnail_path: null,
  });

  const pickFiles = async () => {
    const paths = await api.dialog.openFiles("选择发票文件（可多选）", [
      { displayName: "PDF / 图片", pattern: "*.pdf;*.png;*.jpg;*.jpeg;*.webp;*.gif" },
    ]);
    if (!paths || paths.length === 0) return;
    const merged = [...selected(), ...paths.map(toEntry)];
    if (merged.length > BATCH_LIMIT) {
      showToast("info", "批量 AI 识别一次最多 10 张", `已选 ${merged.length} 张，超出部分已忽略`);
      setSelected(merged.slice(0, BATCH_LIMIT));
    } else {
      setSelected(merged);
    }
  };

  const remove = (p: string) => setSelected(selected().filter((f) => f.path !== p));

  const preview = (f: FileEntry) => void openPreview(f);

  const menuItems = () => {
    const f = ctxMenu.payload();
    if (!f) return [];
    return buildFileContextMenuItems<FileEntry>({
      file: f,
      onPreview: (file) => void openPreview(file),
      onOpenDefault: (file) => void api.files.openWithDefaultApp(file.path),
      onShowInExplorer: (paths) => void api.files.showFilesInExplorer(paths),
      onCopy: (paths) => void api.files.copyFilesToClipboard(paths),
    });
  };

  const confirm = () => {
    if (selected().length === 0) return;
    props.onConfirm(selected().map((f) => f.path));
  };

  const close = () => {
    setSelected([]);
    props.onClose();
  };

  return (
    <Modal open={props.open} title="批量 AI 识别发票" size="2xl" onClose={close}>
      <div class="p-6">
        <div class="flex items-center gap-3 mb-3 flex-wrap">
          <button class="btn-secondary text-sm" onClick={pickFiles}>
            📂 选择文件并添加
          </button>
        </div>
        <p class="text-sm text-surface-500 mb-3">
          选择要识别的发票文件（PDF / 图片，一次最多 {BATCH_LIMIT} 张）；双击文件可预览，识别成功将批量登记为发票（登记时才归档）。
        </p>

        <Show
          when={selected().length > 0}
          fallback={<p class="text-sm text-surface-400 py-10 text-center">请先选择发票文件</p>}
        >
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm text-surface-500">
              已选 <span class="font-medium text-primary-700">{selected().length}/{BATCH_LIMIT}</span> 张
            </span>
          </div>
          <div class="border border-surface-200 rounded-lg max-h-64 overflow-auto">
            <For each={selected()}>
              {(f) => (
                <div
                  class="flex items-center gap-2 px-3 py-2 hover:bg-surface-50 text-sm cursor-default"
                  onDblClick={() => preview(f)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    ctxMenu.open(e, f);
                  }}
                  title="双击预览 · 右键更多操作"
                >
                  <span class="text-sm text-surface-700 truncate flex-1 min-w-0" title={f.path}>
                    {f.name}
                  </span>
                  <span class="text-xs text-surface-400 shrink-0">{f.file_type === "pdf" ? "PDF" : "图片"}</span>
                  <button
                    type="button"
                    class="text-surface-400 hover:text-danger-500 shrink-0 cursor-pointer"
                    title="移除"
                    onClick={() => remove(f.path)}
                  >
                    ✕
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="flex gap-3 justify-end mt-6">
          <button class="btn-secondary" onClick={close}>取消</button>
          <button class="btn-primary" disabled={selected().length === 0} onClick={confirm}>
            批量识别 {selected().length > 0 ? `（${selected().length} 张）` : ""}
          </button>
        </div>
      </div>

      <Show when={ctxMenu.show()}>
        <ContextMenu x={ctxMenu.x()} y={ctxMenu.y()} onClose={ctxMenu.close} items={menuItems()} />
      </Show>
    </Modal>
  );
}
