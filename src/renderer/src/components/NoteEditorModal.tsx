import { Show, createSignal, onMount, onCleanup } from "solid-js";
import { api } from "~/wails/api";

/**
 * 笔记编辑器（v2.5.7 A2，用户拍板 = Milkdown Crepe 所见即所得）。
 *
 * 契约（PLAN §三-B 编辑器）：
 * - 懒加载：Crepe 全部 import 只出现在本模块（动态 import 边界内侧）——模块级缓存 Promise（照
 *   MarkdownPreview 先例），首屏 chunk grep 不含 milkdown（构建验收断言）。
 * - FeatureFlag 裁剪：不引默认 Crepe（拖全量 feature），改 CrepeBuilder + 显式 feature——
 *   blockEdit/listItem/placeholder/toolbar/linkTooltip/cursor/table；不含 CodeMirror/latex/topBar/ai。
 *   实测体积 722KB min（2026-08-29 测量入动作文档），远低于 1MB 降级红线。
 * - 保存契约：getMarkdown() → files.writeText（原子写 + 2MB 上限）。
 *   dirty 判定 = 仅用户编辑置脏——加载时快照初始序列化值，Crepe round-trip 规范化差异不触发写盘；
 *   防抖 500ms / Ctrl+S / 关闭脏守卫 三路共用一条串行保存链（promise 序列化，无并发写窗口）。
 * - 三态：加载 Skeleton / >2MB tooLarge（引导系统程序打开）/ 错误。
 * - 生命周期：onCleanup = editor.destroy() + 清防抖计时器 + 释放 DOM。
 * - 图片：编辑器内相对路径图片不渲染（v2.5.7 目标外；XML 注入防御由 ProseMirror 不外链 raw HTML 保证）。
 */

// —— 模块级懒加载缓存（Crepe 全部 import 隔离在动态边界内侧）——
type CrepeModule = typeof import("@milkdown/crepe/builder");
type BasicModule = typeof import("@milkdown/crepe/feature/block-edit");

interface CrepeLoaded {
  CrepeBuilder: CrepeModule["CrepeBuilder"];
  blockEdit: BasicModule["blockEdit"];
  listItem: typeof import("@milkdown/crepe/feature/list-item").listItem;
  placeholder: typeof import("@milkdown/crepe/feature/placeholder").placeholder;
  toolbar: typeof import("@milkdown/crepe/feature/toolbar").toolbar;
  linkTooltip: typeof import("@milkdown/crepe/feature/link-tooltip").linkTooltip;
  cursor: typeof import("@milkdown/crepe/feature/cursor").cursor;
  table: typeof import("@milkdown/crepe/feature/table").table;
}

let crepeReady: Promise<CrepeLoaded> | null = null;
async function loadCrepe(): Promise<CrepeLoaded> {
  if (!crepeReady) {
    crepeReady = Promise.all([
      import("@milkdown/crepe/builder"),
      import("@milkdown/crepe/feature/block-edit"),
      import("@milkdown/crepe/feature/list-item"),
      import("@milkdown/crepe/feature/placeholder"),
      import("@milkdown/crepe/feature/toolbar"),
      import("@milkdown/crepe/feature/link-tooltip"),
      import("@milkdown/crepe/feature/cursor"),
      import("@milkdown/crepe/feature/table"),
      import("@milkdown/crepe/theme/classic.css"),
      // feature 样式（自定义 builder 需显式引 feature css——官方默认 Crepe 全量已含，这里按启用集引）
      import("@milkdown/crepe/theme/common/style.css"),
      import("@milkdown/crepe/theme/common/reset.css"),
      import("@milkdown/crepe/theme/common/prosemirror.css"),
      import("@milkdown/crepe/theme/common/block-edit.css"),
      import("@milkdown/crepe/theme/common/list-item.css"),
      import("@milkdown/crepe/theme/common/placeholder.css"),
      import("@milkdown/crepe/theme/common/toolbar.css"),
      import("@milkdown/crepe/theme/common/link-tooltip.css"),
      import("@milkdown/crepe/theme/common/cursor.css"),
      import("@milkdown/crepe/theme/common/table.css"),
    ]).then(([builder, blockEdit, listItem, placeholder, toolbar, linkTooltip, cursor, table]) => ({
      CrepeBuilder: builder.CrepeBuilder,
      blockEdit: blockEdit.blockEdit,
      listItem: listItem.listItem,
      placeholder: placeholder.placeholder,
      toolbar: toolbar.toolbar,
      linkTooltip: linkTooltip.linkTooltip,
      cursor: cursor.cursor,
      table: table.table,
    }));
    crepeReady.catch(() => {
      crepeReady = null; // 失败允许重试
    });
  }
  return crepeReady;
}

type State = "loading" | "ready" | "tooLarge" | "error";

let editorSeq = 0;

export default function NoteEditorModal(props: {
  filePath: string;
  /** 工作区相对路径（writeText 契约；缺省从 filePath 推断） */
  saveRelPath?: string;
  onClose?: () => void;
  onSaved?: (path: string) => void;
  onOpenWithSystem?: (path: string) => void;
}) {
  const [state, setState] = createSignal<State>("loading");
  const [errorMsg, setErrorMsg] = createSignal("");
  let rootRef: HTMLDivElement | undefined;
  let editor: InstanceType<CrepeModule["CrepeBuilder"]> | null = null;
  let baselineMd = "";
  let dirty = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let saveQueue: Promise<void> = Promise.resolve();
  // v2.5.7（笔记前端优化）：保存状态徽标（saving/saved/error）
  const [saveState, setSaveState] = createSignal<"saving" | "saved" | "error" | null>(null);
  let savedAtTimer: ReturnType<typeof setTimeout> | null = null;
  const fileName = () => {
    const p = props.filePath;
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i >= 0 ? p.slice(i + 1) : p;
  };
  const saveLabel = () => {
    const s = saveState();
    if (s === "saving") return "编辑中…";
    if (s === "error") return "保存失败";
    if (s === "saved") return "已保存";
    return "";
  };
  const markSaved = () => {
    setSaveState("saved");
    if (savedAtTimer) clearTimeout(savedAtTimer);
    savedAtTimer = setTimeout(() => setSaveState(null), 3000);
  };
  // 加载代际守卫（文件切换/卸载 → 旧续体作废）
  const seq = ++editorSeq;

  const relPath = () =>
    props.saveRelPath && props.saveRelPath.length > 0 ? props.saveRelPath : relPathFromAbs(props.filePath);

  const serialize = async (): Promise<string> => {
    if (!editor) return "";
    const md = await editor.getMarkdown();
    return md ?? "";
  };

  /** 串行保存链——防抖/Ctrl+S/关闭脏守卫共用（无并发写窗口） */
  const enqueueSave = (immediate = false) => {
    if (!dirty) return;
    if (!immediate && debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (!immediate) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void enqueueSave(true);
      }, 500);
      return;
    }
    dirty = false;
    setSaveState("saving");
    saveQueue = saveQueue.then(async () => {
      const content = await serialize();
      const r = await api.files.writeText(relPath(), content);
      if (r.success) {
        props.onSaved?.(props.filePath);
        // 保存成功后基线更新（防抖内二次编辑不重复判定）
        baselineMd = content;
        markSaved();
      } else {
        // 写失败 → 恢复脏（下次触发重试）；不静默
        dirty = true;
        setSaveState("error");
      }
    });
  };

  const initEditor = async (md: string) => {
    const mod = await loadCrepe();
    if (seq !== editorSeq || !rootRef) return;
    const { CrepeBuilder, blockEdit, listItem, placeholder, toolbar, linkTooltip, cursor, table } = mod;
    editor = new CrepeBuilder({ root: rootRef, defaultValue: md })
      .addFeature(blockEdit)
      .addFeature(listItem)
      .addFeature(placeholder)
      .addFeature(toolbar)
      .addFeature(linkTooltip)
      .addFeature(cursor)
      .addFeature(table);
    await editor.create();
    if (seq !== editorSeq) return;
    // 快照：Crepe 规范化后的初始序列化（round-trip 差异不算脏，零写入底线）
    baselineMd = (await editor.getMarkdown()) ?? "";
    // 监听 markdown 更新 → 用户编辑判定
    editor.on((listener) => {
      listener.markdownUpdated((_ctx, md) => {
        void (() => {
          if (md === baselineMd) return; // 规范化回写不触发
          dirty = true;
          enqueueSave();
        })();
      });
    });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        dirty = true;
        enqueueSave(true);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
    });
  };

  onMount(async () => {
    setState("loading");
    const res = await api.files.readTextFile(props.filePath);
    if (seq !== editorSeq) return;
    if (!res.success) {
      if ((res.error ?? "").includes("过大")) {
        setState("tooLarge");
      } else {
        setErrorMsg(res.error || "读取文件失败");
        setState("error");
      }
      return;
    }
    try {
      await initEditor(res.data ?? "");
      if (seq !== editorSeq) return;
      setState("ready");
    } catch (e) {
      if (seq !== editorSeq) return;
      setErrorMsg(e instanceof Error ? e.message : "编辑器初始化失败");
      setState("error");
    }
  });

  onCleanup(() => {
    // 卸载兜底：先同步抽出 Markdown（editor 存活时），再 destroy；未保存的脏内容尝试落盘（不阻塞）
    let pendingContent: string | null = null;
    if (dirty && props.saveRelPath && editor) {
      try {
        pendingContent = editor.getMarkdown() ?? "";
      } catch {
        pendingContent = null;
      }
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    if (savedAtTimer) clearTimeout(savedAtTimer);
    editor?.destroy();
    editor = null;
    if (pendingContent !== null && props.saveRelPath) {
      void api.files.writeText(relPath(), pendingContent).catch(() => {});
    }
  });

  return (
    <div class="relative flex h-full min-h-[42vh] flex-col overflow-hidden rounded-xl border border-surface-200 bg-surface-0" data-note-editor="">
      {/* v2.5.7（用户拍板「笔记编辑前端优化」）：独立编辑顶栏——文件名 + 保存状态徽标 + 系统打开 */}
      <div class="flex items-center justify-between gap-3 border-b border-surface-200 bg-surface-50 px-4 py-2">
        <div class="min-w-0 flex items-center gap-2">
          <span class="text-base">📝</span>
          <span class="truncate text-sm font-medium text-surface-800">{fileName()}</span>
          <Show when={saveState() !== null}>
            <span
              class={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                saveState() === "saving"
                  ? "bg-amber-100 text-amber-700"
                  : saveState() === "error"
                    ? "bg-danger-100 text-danger-600"
                    : "bg-emerald-100 text-emerald-700"
              }`}
            >
              <Show when={saveState() === "saving"}>
                <span class="inline-block size-2 animate-pulse rounded-full bg-amber-500" />
              </Show>
              <Show when={saveState() === "error"}>
                <span class="inline-block size-2 rounded-full bg-danger-500" />
              </Show>
              <Show when={saveState() === "saved"}>
                <span class="inline-block size-2 rounded-full bg-emerald-500" />
              </Show>
              {saveLabel()}
            </span>
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span class="text-xs text-surface-400">编辑即保存 · Ctrl+S 立即保存</span>
          <button
            class="btn-secondary text-xs"
            onClick={() => props.onOpenWithSystem?.(props.filePath)}
            title="用系统程序打开"
          >
            🖥 用系统打开
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1">
        <Show when={state() === "loading" || state() === "ready"}>
          <div class="h-full w-full" ref={rootRef} />
        </Show>
        <Show when={state() === "loading"}>
          <div
            class="absolute inset-0 flex items-center justify-center bg-surface-100/60 text-sm text-surface-500"
            data-testid="note-editor-loading"
          >
            加载编辑器…
          </div>
        </Show>
        <Show when={state() === "tooLarge"}>
          <div class="h-full flex flex-col items-center justify-center gap-3 bg-surface-100 rounded-xl text-surface-500">
            <span class="text-4xl">📄</span>
            <p class="text-sm">文件过大（超过 2MB），无法在线编辑</p>
            <button class="btn-secondary text-sm" onClick={() => props.onOpenWithSystem?.(props.filePath)}>
              🖥 用系统程序打开
            </button>
          </div>
        </Show>
        <Show when={state() === "error"}>
          <div class="h-full flex flex-col items-center justify-center gap-3 bg-surface-100 rounded-xl text-surface-500">
            <span class="text-4xl">⚠️</span>
            <p class="text-sm">{errorMsg()}</p>
            <button class="btn-secondary text-sm" onClick={() => props.onOpenWithSystem?.(props.filePath)}>
              🖥 用系统程序打开
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

/** 绝对路径 → 工作区相对路径（writeText 契约；三域前缀 + 产品集） */
function relPathFromAbs(abs: string): string {
  const idx = abs.indexOf("/产品集/");
  if (idx >= 0) return abs.slice(idx + 1);
  const i2 = abs.indexOf("/客户/");
  if (i2 >= 0) return abs.slice(i2 + 1);
  const i3 = abs.indexOf("/供应商/");
  if (i3 >= 0) return abs.slice(i3 + 1);
  return abs;
}
