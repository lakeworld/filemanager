import { Show, For, createSignal, createEffect } from "solid-js";
import { api } from "~/wails/api";
// v2.5.8 D19（B1）：复制反馈统一（成功/失败都出声）
import { copyFilesWithFeedback } from "~/utils/copyAction";
import { showToast } from "~/stores/notifyBanner";
import Modal from "~/components/ui/Modal";
import ContextMenu from "~/components/ContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { openPreview } from "~/stores/preview";
import { baseNameOf } from "./utils";
import { BATCH_LIMIT, mergePickedPaths } from "./batchIdentify";
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
    // v2.5.6：按路径去重（重复选同一文件不再产生重复条目）+ ≤10 截断（mergePickedPaths 纯函数，单测锁定）
    const m = mergePickedPaths(selected().map((f) => f.path), paths);
    if (m.overflow > 0) {
      showToast("info", "批量 AI 识别一次最多 10 张", `超出 ${m.overflow} 张已忽略`);
    }
    setSelected(m.paths.map(toEntry));
  };

  const remove = (p: string) => setSelected(selected().filter((f) => f.path !== p));

  // v2.5.8 D18：批量识别暂存区带已选清单快照 ⇒ 识别前可逐张翻看挑出来的这几张
  const preview = (f: FileEntry) => void openPreview(f, { list: selected() });

  const menuItems = () => {
    const f = ctxMenu.payload();
    if (!f) return [];
    return buildFileContextMenuItems<FileEntry>({
      file: f,
      onPreview: (file) => void openPreview(file, { list: selected() }),
      onOpenDefault: (file) => void api.files.openWithDefaultApp(file.path),
      onShowInExplorer: (paths) => void api.files.showFilesInExplorer(paths),
      // v2.5.8 D19（B1）：右键「复制」原先 `void api.…` 成功失败全静默，改走统一反馈
      onCopy: (paths) => void copyFilesWithFeedback(api.files.copyFilesToClipboard, paths),
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
    <Modal
      open={props.open}
      title="批量 AI 识别发票"
      size="2xl"
      framed
      onClose={close}
      // v2.5.8 D16（framed 收口）：底部「取消 / 批量识别」进页脚槽（`.dlg-footer` 自带 justify-end + gap-3）
      footer={
        <>
          <button class="btn-secondary" onClick={close}>取消</button>
          <button class="btn-primary" disabled={selected().length === 0} onClick={confirm}>
            批量识别 {selected().length > 0 ? `（${selected().length} 张）` : ""}
          </button>
        </>
      }
    >
      {/* v2.5.8 D16：本弹窗原先没有可见标题（title 只落在底座的可访问名上），开 framed 属**补齐**
          ——标题现由 `.dlg-header` 显示出来，此处不得补手写标题（Modal.tsx:51）。
          外层 `p-6` 一并去掉（`.dlg-body` 已给 px-6 py-5）；内层仍包一层 div，使 `.dlg-body` 的
          `flex flex-col gap-4` 不改变正文各段原有的 mb-* 节奏（不趁迁移改版式）。 */}
      <div>
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
                  {/* v2.5.8 D14（样式统一收口）：行尾移除钮收进 `.icon-btn`（居中/圆角/过渡/按压/禁用态）；
                      `cursor-pointer` 档里没有（本行容器写了 cursor-default，必须留着才不丢手型）。 */}
                  <button
                    type="button"
                    class="icon-btn text-surface-400 hover:text-danger-500 shrink-0 cursor-pointer"
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
      </div>

      <Show when={ctxMenu.show()}>
        <ContextMenu x={ctxMenu.x()} y={ctxMenu.y()} onClose={ctxMenu.close} items={menuItems()} />
      </Show>
    </Modal>
  );
}
