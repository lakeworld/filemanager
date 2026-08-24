import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { api } from "~/wails/api";
import { productSets, workspaceConfig } from "~/stores/workspace";
import { showToast } from "~/stores/notifyBanner";
import Modal from "~/components/ui/Modal";
import { baseNameOf } from "./utils";
import { BATCH_LIMIT } from "./batchIdentify";
import type { FileEntry } from "~/types";

/**
 * 发票批量 AI 识别 · 工作区文件多选面板（v2.5.5 B4，T0 定案：不用宿主 dialog——host.dialog.openFile
 * 不支持多选；发票页内建面板浏览工作区文件，复选框多选 ≤10，确认后经命令 payload { paths } 传入插件）。
 *
 * 浏览范围：产品集 ×（图包/文档/证书）× 子文件夹（复用 api.files.list 与 workspaceConfig 子文件夹集，
 * 与 Images/FileBrowser 同口径）。FileEntry.path 为工作区绝对路径（/ 分隔），插件 identifyInvoice 可直接读。
 */
export default function BatchIdentifyModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (paths: string[]) => void;
}) {
  const [psSel, setPsSel] = createSignal("");
  const [typeSel, setTypeSel] = createSignal<"image" | "cert" | "doc">("image");
  const [subSel, setSubSel] = createSignal("");
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [selected, setSelected] = createSignal<string[]>([]);

  const subfolderOptions = () => {
    const cfg = workspaceConfig();
    if (typeSel() === "image") return cfg?.image_subfolders?.length ? cfg.image_subfolders : ["主图", "详情页", "白底图", "素材"];
    if (typeSel() === "cert") return cfg?.cert_subfolders?.length ? cfg.cert_subfolders : ["证书"];
    return cfg?.doc_subfolders?.length ? cfg.doc_subfolders : [""];
  };

  // 类型切换 → 子文件夹选第一项（防列表错位）
  createEffect(() => {
    const opts = subfolderOptions();
    if (!opts.includes(subSel())) setSubSel(opts[0] ?? "");
  });

  let loadSeq = 0;
  const loadFiles = async () => {
    const seq = ++loadSeq;
    const ps = psSel();
    if (!ps) {
      setFiles([]);
      return;
    }
    const r = await api.files.list({ product_set: ps, file_type: typeSel(), sub_folder: subSel() });
    if (seq !== loadSeq) return;
    setFiles(r.success && Array.isArray(r.data) ? r.data : []);
  };
  createEffect(() => {
    props.open && psSel() != null;
    if (props.open) void loadFiles();
  });

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
        <p class="text-sm text-surface-500 mb-4">
          从工作区选择发票文件（PDF / 图片），一次最多 {BATCH_LIMIT} 张：识别成功将批量登记为发票（登记时才归档）。
        </p>
        <div class="flex gap-3 mb-4 flex-wrap">
          <select
            class="select w-44"
            aria-label="产品集"
            value={psSel()}
            onChange={(e) => { setPsSel(e.currentTarget.value); setSelected([]); }}
          >
            <option value="">选择产品集…</option>
            <For each={productSets()}>
              {(ps) => <option value={ps.name}>{ps.name}</option>}
            </For>
          </select>
          <select
            class="select w-32"
            aria-label="文件类型"
            value={typeSel()}
            onChange={(e) => { setTypeSel(e.currentTarget.value as "image" | "cert" | "doc"); setSelected([]); }}
          >
            <option value="image">图包</option>
            <option value="doc">文档</option>
            <option value="cert">证书</option>
          </select>
          <select
            class="select w-44"
            aria-label="子文件夹"
            value={subSel()}
            onChange={(e) => { setSubSel(e.currentTarget.value); setSelected([]); }}
          >
            <For each={subfolderOptions()}>
              {(s) => <option value={s}>{s || "（根目录）"}</option>}
            </For>
          </select>
        </div>

        <Show
          when={psSel()}
          fallback={<p class="text-sm text-surface-400 py-10 text-center">请先选择产品集</p>}
        >
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm text-surface-500">
              {files().length} 个文件 · 已选 <span class="font-medium text-primary-700">{selected().length}/{BATCH_LIMIT}</span>
            </span>
            <button class="text-sm text-primary-600 hover:text-primary-700" onClick={selectAllVisible}>
              全选可见
            </button>
          </div>
          <div class="border border-surface-200 rounded-lg max-h-64 overflow-auto">
            <Show
              when={files().length > 0}
              fallback={<p class="text-sm text-surface-400 py-8 text-center">该目录暂无文件</p>}
            >
              <For each={files()}>
                {(f) => (
                  <label
                    class={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-50 ${selected().includes(f.path) ? "bg-primary-50" : ""}`}
                  >
                    <input
                      type="checkbox"
                      class="accent-primary-500"
                      checked={selected().includes(f.path)}
                      onChange={() => toggle(f.path)}
                    />
                    <span class="text-sm text-surface-700 truncate">
                      {baseNameOf(f.path)}
                      <span class="text-xs text-surface-400 ml-2">{f.file_type}</span>
                    </span>
                  </label>
                )}
              </For>
            </Show>
          </div>
        </Show>

        <div class="flex gap-3 justify-end mt-6">
          <button class="btn-secondary" onClick={close}>取消</button>
          <button class="btn-primary" disabled={selected().length === 0} onClick={confirm}>
            批量识别 {selected().length > 0 ? `（${selected().length} 张）` : ""}
          </button>
        </div>
      </div>
    </Modal>
  );
}
