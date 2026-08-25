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
import type { DirBrowseEntry, DirBrowseResult, ApiResult } from "~/types";

/**
 * 发票批量 AI 识别 · 任意文件夹多选面板（v2.5.5 打磨 2，用户拍板）：
 * 「选择文件夹…」→ 系统文件夹对话框（qihebox:dialog:openDirectory）→ 列当前目录
 * 子文件夹 + 发票候选文件（qihebox:dir:list）→ 子文件夹点击进入 / 面包屑回上级 →
 * 文件复选框多选 ≤10 → 批量识别（onConfirm 传绝对路径数组，识别/归档链路不变）。
 * 双击文件 = 打开预览（FilePreviewModal）；右键 = 文件菜单（预览/系统打开/在文件夹中显示/复制）。
 */
export default function BatchIdentifyModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (paths: string[]) => void;
}) {
  const [dir, setDir] = createSignal("");
  const [dirs, setDirs] = createSignal<string[]>([]);
  const [files, setFiles] = createSignal<DirBrowseEntry[]>([]);
  const [selected, setSelected] = createSignal<string[]>([]);
  const [loadErr, setLoadErr] = createSignal("");
  const ctxMenu = useContextMenu<DirBrowseEntry>();

  // 打开面板时回到空态（用户自选文件夹；不自动加载上次路径，避免目录漂移）
  createEffect(() => {
    if (props.open) {
      setDir("");
      setDirs([]);
      setFiles([]);
      setSelected([]);
      setLoadErr("");
    }
  });

  let loadSeq = 0;
  const loadDir = async (d: string) => {
    const seq = ++loadSeq;
    setLoadErr("");
    const r = (await api.dirs.list(d)) as ApiResult<DirBrowseResult>;
    if (seq !== loadSeq) return;
    if (r.success && r.data) {
      setDir(r.data.dir);
      setDirs(r.data.dirs);
      setFiles(r.data.files);
      setSelected([]);
    } else {
      setDir(d);
      setDirs([]);
      setFiles([]);
      setLoadErr(r.error || "无法读取该文件夹");
    }
  };

  const pickFolder = async () => {
    const d = await api.dialog.openDirectory("选择发票所在文件夹");
    if (d) void loadDir(d);
  };

  const parentDir = () => {
    const d = dir();
    const idx = Math.max(d.lastIndexOf("/"), d.lastIndexOf("\\"));
    if (idx <= 0) return "";
    return d.slice(0, idx);
  };

  const enter = (name: string) => {
    const sep = dir().endsWith("/") || dir().endsWith("\\") ? "" : "/";
    void loadDir(dir() + sep + name);
  };

  const toggle = (p: string) => {
    const cur = selected();
    if (cur.includes(p)) {
      setSelected(cur.filter((x) => x !== p));
    } else {
      if (cur.length >= BATCH_LIMIT) {
        showToast("info", "批量 AI 识别一次最多 10 张", `已选 ${cur.length} 张，请先取消部分选择`);
        return;
      }
      setSelected([...cur, p]);
    }
  };

  const selectAllVisible = () => {
    const all = files().map((f) => f.path);
    if (all.length > BATCH_LIMIT) {
      setSelected(all.slice(0, BATCH_LIMIT));
      showToast("info", `仅选择前 ${BATCH_LIMIT} 张`, `可见 ${all.length} 张，超出部分已忽略`);
    } else {
      setSelected(all);
    }
  };

  const preview = (f: DirBrowseEntry) => void openPreview(f);

  const menuItems = () => {
    const f = ctxMenu.payload();
    if (!f) return [];
    return buildFileContextMenuItems<DirBrowseEntry>({
      file: f,
      onPreview: (file) => void openPreview(file),
      onOpenDefault: (file) => void api.files.openWithDefaultApp(file.path),
      onShowInExplorer: (paths) => void api.files.showFilesInExplorer(paths),
      onCopy: (paths) => void api.files.copyFilesToClipboard(paths),
    });
  };

  const confirm = () => {
    if (selected().length === 0) return;
    props.onConfirm(selected());
  };

  const close = () => {
    setSelected([]);
    props.onClose();
  };

  return (
    <Modal open={props.open} title="批量 AI 识别发票" size="2xl" onClose={close}>
      <div class="p-6">
        <div class="flex items-center gap-3 mb-3 flex-wrap">
          <button class="btn-secondary text-sm" onClick={pickFolder}>
            📁 选择文件夹…
          </button>
          <Show when={dir()}>
            <span class="text-sm text-surface-500 truncate max-w-[24rem]" title={dir()}>
              当前：{dir()}
            </span>
            <Show when={parentDir()}>
              <button class="text-sm text-primary-600 hover:text-primary-700" onClick={() => void loadDir(parentDir())}>
                ↑ 上级
              </button>
            </Show>
          </Show>
        </div>
        <p class="text-sm text-surface-500 mb-3">
          选一个文件夹，批量识别里面的发票（PDF / 图片，一次最多 {BATCH_LIMIT} 张）；双击文件可预览，识别成功将批量登记为发票（登记时才归档）。
        </p>

        <Show
          when={dir()}
          fallback={<p class="text-sm text-surface-400 py-10 text-center">请先选择一个文件夹</p>}
        >
          <Show when={!loadErr()}>
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm text-surface-500">
                {files().length} 个发票文件 · {dirs().length} 个子文件夹 · 已选{" "}
                <span class="font-medium text-primary-700">{selected().length}/{BATCH_LIMIT}</span>
              </span>
              <button class="text-sm text-primary-600 hover:text-primary-700" onClick={selectAllVisible}>
                全选可见
              </button>
            </div>
            <div class="border border-surface-200 rounded-lg max-h-64 overflow-auto">
              <Show when={dirs().length > 0 || files().length > 0} fallback={<p class="text-sm text-surface-400 py-8 text-center">该文件夹暂无发票文件</p>}>
                <For each={dirs()}>
                  {(name) => (
                    <div
                      class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-50 text-sm text-surface-700"
                      onClick={() => enter(name)}
                    >
                      <span aria-hidden>📁</span>
                      <span class="truncate">{name}</span>
                      <span class="text-xs text-surface-400 ml-auto shrink-0">打开</span>
                    </div>
                  )}
                </For>
                <For each={files()}>
                  {(f) => (
                    <label
                      class={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-50 ${selected().includes(f.path) ? "bg-primary-50" : ""}`}
                      onDblClick={() => preview(f)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        ctxMenu.open(e, f);
                      }}
                    >
                      <input
                        type="checkbox"
                        class="accent-primary-500 shrink-0"
                        checked={selected().includes(f.path)}
                        onChange={() => toggle(f.path)}
                      />
                      <span class="text-sm text-surface-700 truncate flex-1 min-w-0">
                        {f.name}
                      </span>
                      <span class="text-xs text-surface-400 shrink-0">{f.file_type === "pdf" ? "PDF" : "图片"}</span>
                    </label>
                  )}
                </For>
              </Show>
            </div>
          </Show>
          <Show when={loadErr()}>
            <p class="text-sm text-danger-600 py-8 text-center">{loadErr()}</p>
          </Show>
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
