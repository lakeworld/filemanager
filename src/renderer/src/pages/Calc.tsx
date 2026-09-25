import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import Input from "~/components/ui/Input";
import Textarea from "~/components/ui/Textarea";
import Modal from "~/components/ui/Modal";
import ConfirmDialog from "~/components/ConfirmDialog";
import ContextMenu from "~/components/ContextMenu";
import type { ContextMenuItem } from "~/components/ContextMenu";
import DatePicker from "~/components/DatePicker";
import { useContextMenu } from "~/hooks/useContextMenu";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import { COPY_ERROR_FALLBACK, COPY_ERROR_TITLE } from "~/lib/copyFeedback";
import { evaluateExpression, formatCalcTime } from "../../../shared/calc";
import type { CalcContainer, CalcRecord } from "~/types";

/**
 * 计算页（v2.5.9/A7「计算」· v2.6.1 B15 容器化）——整页双栏 + 计算历史流。
 *
 * 权威 = `内部计算设计文档（不进公开仓）` §四（整页化修订 + 4.x「容器化修订」）与 §八 拍板。
 *
 * 由来：用户反馈「左边条目的逻辑搞错了——它基本上和 AI 对话一样，左边一个条目包含了右边所有历史，
 * 然后加一个 tab，以标记的」⇒ 澄清为「整个计算页就像一个新建出来的对话，所有计算都在里面
 * （左栏只是它的目录）」⇒ 选丙：**左栏 = 容器（对话/笔记本）列表，右栏 = 该容器下的计算历史**。
 *
 * 版式（§四 4.x 逐条落地）：
 * - **左栏 = 容器列表**（≈280px，新→旧）：列出全部容器 + 「新建容器」入口；选中项高亮；
 *   右键可重命名 / 删除（删除 = 连其中记录一起删，确认弹窗点明条数）。
 * - **右栏 = 当前容器下的计算历史**：顶部「全部 / 已标记」tab（筛当前容器内记录，默认「全部」）；
 *   记录条目流（**旧在上、新在下**，提交后自动滚到底）+ 底部输入条。
 * - 其余照旧：算式回填、「标记一下 ⇄ 取消标记」、右键动词表、`Ctrl+=` 跳页、无数字键盘、
 *   暂存/已标记两态语义零变动（`saved` 字段一字未动，只是记录多了一层容器归属）。
 *
 * 两条口径与核层对齐：
 * - 求值只走 `shared/calc.evaluateExpression`（双端同一份实现，台账只存展示态）：
 *   成功才落账，失败只显示温和文案、**不落账、不抛**（§二.5 容错三条）；
 * - `api.calcs.*` 的 `ok === false`（`ApiResult.success === false`）分支一律出声（toast），不静默吞。
 * - 迁移（无 container_id 的老记录归入「默认」容器）住在主进程 core/calcs：页面只消费
 *   `listContainers()` 的结果，第一眼就能看到老历史躺在默认容器里。
 */

/** 右栏的一条「记录条目」大卡（行内动作经 props 回调回页面；Solid 纪律：禁解构 props） */
function CalcEntryCard(props: {
  rec: CalcRecord;
  onRefill: (rec: CalcRecord) => void;
  onCopy: (rec: CalcRecord) => void;
  onToggleSaved: (rec: CalcRecord) => void;
  onContextMenu: (e: MouseEvent, rec: CalcRecord) => void;
}) {
  return (
    <div
      class="card p-4"
      data-calc-id={props.rec.id}
      data-calc-side="entry"
      title="点结果复制 · 点算式回填改着再算 · 右键更多"
      onContextMenu={(e) => props.onContextMenu(e, props.rec)}
    >
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          {/* 有标题先显示标题行（§四 行结构：眼睛先看结果，再看这行是怎么来的） */}
          <Show when={props.rec.title}>
            <div class="text-sm font-medium text-surface-900 truncate">{props.rec.title}</div>
          </Show>
          {/* 算式 = 展示态（× ÷ 已渲染）；点一下回填输入框，链式引用就从这里长出来 */}
          <button
            class="link-btn w-full min-w-0 text-left text-sm text-surface-500 hover:text-primary-600"
            title="点一下，把这条算式填回输入框改着再算"
            onClick={() => props.onRefill(props.rec)}
          >
            <span class="truncate">{props.rec.expression}</span>
          </button>
          <Show when={props.rec.note}>
            <div class="text-xs text-surface-400 mt-0.5">{props.rec.note}</div>
          </Show>
        </div>
        {/* 右上：结果大字 + 相对时间；点结果 = 复制（整宽大卡放得下常驻动作钮，
            不再像窄条面板那样 hover 隐藏——见文件头版式说明） */}
        <div class="shrink-0 text-right">
          <button
            class="link-btn text-2xl font-semibold leading-tight tabular-nums text-surface-900 hover:text-primary-700"
            title="点击复制结果"
            onClick={() => props.onCopy(props.rec)}
          >
            {props.rec.result}
          </button>
          <div class="text-xs tabular-nums text-surface-400 mt-0.5">{formatCalcTime(props.rec.created)}</div>
        </div>
      </div>
      {/* 常驻动作行：chip（已标记）+ 复制 / 标记一下 ⇄ 取消标记 */}
      <div class="mt-3 flex items-center gap-2">
        <Show when={props.rec.saved}>
          <span class="chip bg-success-50 text-success-700">已标记</span>
        </Show>
        <div class="ml-auto flex items-center gap-3">
          <button
            class="link-btn px-1.5 py-0.5 text-xs text-surface-500 hover:text-primary-600"
            title="复制结果"
            onClick={() => props.onCopy(props.rec)}
          >
            复制
          </button>
          <button
            class="link-btn px-1.5 py-0.5 text-xs text-surface-500 hover:text-primary-600"
            title={props.rec.saved ? "取消标记" : "标记一下"}
            onClick={() => props.onToggleSaved(props.rec)}
          >
            {/* 文案跟着状态走：已标记的条目点下去是**取消标记**（toggleSaved） */}
            {props.rec.saved ? "取消标记" : "标记一下"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 容器弹窗（新建 / 重命名共用一具）；null = 不开 */
interface ContainerDialogState {
  mode: "create" | "rename";
  id: string;
  name: string;
}

export default function Calc() {
  const [containers, setContainers] = createSignal<CalcContainer[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  /** 当前容器下的记录（旧→新，录入序）；tab 过滤只做展示，不改台账 */
  const [records, setRecords] = createSignal<CalcRecord[]>([]);
  const [draft, setDraft] = createSignal("");
  /**
   * 解析失败的温和提示（「算式没看懂」/「除数不能为 0」/「这个日期不存在」/「数太大，算不出来」）；
   * 空串 = 不显示
   */
  const [hint, setHint] = createSignal("");
  /** 提交在途标志（防双击/双回车连发两条同参 add——清空输入已前移到发 IPC 之前，见 submit） */
  const [submitting, setSubmitting] = createSignal(false);
  const [editId, setEditId] = createSignal<string | null>(null);
  const [editTitle, setEditTitle] = createSignal("");
  const [editNote, setEditNote] = createSignal("");
  const [deleting, setDeleting] = createSignal<CalcRecord | null>(null);
  /** 新建 / 重命名容器弹窗（null = 关） */
  const [containerDialog, setContainerDialog] = createSignal<ContainerDialogState | null>(null);
  /** 删容器确认（带**条数**：确认文案点明「这本容器里的 N 条也会一起删」，§四 细则 #1） */
  const [deletingContainer, setDeletingContainer] = createSignal<{ container: CalcContainer; count: number } | null>(null);
  /** 右栏记录筛：全部 / 已标记（默认「全部」；只筛当前容器内记录） */
  const [tab, setTab] = createSignal<"all" | "saved">("all");
  /** IME 组合态标志（`compositionstart/end` 维护；与事件的 `isComposing` 双保险，见 onDraftKeyDown） */
  let composing = false;
  let streamEl: HTMLDivElement | undefined;
  let barEl: HTMLDivElement | undefined;
  const ctxMenu = useContextMenu<CalcRecord>();
  const containerMenu = useContextMenu<CalcContainer>();

  /** 左栏容器排序：新→旧（§四 4.x 细则 #2：新→旧；数据层给插入序=创建序，倒序只做展示） */
  const containersNewestFirst = createMemo(() => containers().slice().reverse());
  /** 当前容器（左栏高亮 + 右栏归属的判断收进 memo，别在 JSX 里现算——Solid 纪律） */
  const activeContainer = createMemo(() => containers().find((c) => c.id === activeId()) ?? null);
  /** 右栏可见记录 = 当前容器记录过 tab（「已标记」只筛 saved:true；两态语义零变动） */
  const visibleRecords = createMemo(() =>
    tab() === "saved" ? records().filter((r) => r.saved) : records(),
  );

  /** 输入框元素只在底部输入条里找——不读 DOM 值（值一律走 `draft()` 信号），只用它送焦点与插光标 */
  const inputEl = () => barEl?.querySelector<HTMLInputElement>("input") ?? null;
  const focusInput = () => inputEl()?.focus();

  /** 提交后滚到底：新的在下面，「滚到底才看见刚记的」是台账直觉（§四 右栏正序） */
  const scrollAfterRender = () => requestAnimationFrame(() => {
    if (streamEl) streamEl.scrollTop = streamEl.scrollHeight;
  });

  /** 失败出声的统一出口（IPC 的 `error` 有就用，没有就给一句人话，不显示 undefined） */
  const reportError = (error: string | null | undefined, fallback: string) =>
    showToast("error", error || fallback);

  /**
   * 拉容器列表并把选中项落在合法值上（返回本次应选中的 id）。
   * 兜底 = 新→旧排序里的最新一本（列表尾部）——新建的容器天然成为当前容器；
   * 删掉当前容器后也不会悬空（preferId 失效即回退）。
   */
  const reloadContainers = async (preferId?: string): Promise<string | null> => {
    const res = await api.calcs.listContainers();
    if (!res.success) {
      reportError(res.error, "容器列表读取失败");
      return null;
    }
    const list = res.data ?? [];
    setContainers(list);
    const wanted = preferId ?? activeId();
    const next = wanted && list.some((c) => c.id === wanted) ? wanted : (list.length ? list[list.length - 1].id : null);
    setActiveId(next);
    return next;
  };

  /** 拉当前容器的记录（scroll = 提交后滚到底） */
  const reloadRecords = async (containerId = activeId(), scroll = false): Promise<void> => {
    if (!containerId) {
      setRecords([]);
      return;
    }
    const res = await api.calcs.list(containerId);
    if (!res.success) {
      reportError(res.error, "计算历史读取失败");
      return;
    }
    setRecords(res.data ?? []);
    if (scroll) scrollAfterRender();
  };

  /** 点左栏一本容器 ⇒ 切换当前容器（该行高亮；右栏整列换成它的历史，滚到最新一条） */
  const selectContainer = async (id: string) => {
    if (id === activeId()) return;
    setActiveId(id);
    setHint("");
    await reloadRecords(id);
    scrollAfterRender();
  };

  /** 往光标处插入一段文本（`%` 与日期共用）；插完把焦点与光标还给输入框 */
  const insertAtCursor = (text: string) => {
    const el = inputEl();
    const cur = draft();
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? start;
    setDraft(cur.slice(0, start) + text + cur.slice(end));
    setHint("");
    focusInput();
    // 受控输入（value 来自信号）更新后光标会落到末尾，故在更新之后再按插入位置复位；
    // Solid 的 DOM 更新是同步的 ⇒ 一次微任务足够，不必等下一帧。
    queueMicrotask(() => {
      const el2 = inputEl();
      if (el2) el2.setSelectionRange(start + text.length, start + text.length);
    });
  };

  /** 点算式 = 整条回填（§四：在旧算式基础上改着再算，新条目从旧算式衍生，计算链自然形成） */
  const refill = (rec: CalcRecord) => {
    setDraft(rec.expression);
    setHint("");
    focusInput();
    queueMicrotask(() => {
      const el = inputEl();
      if (el) el.setSelectionRange(draft().length, draft().length);
    });
  };

  const submit = async () => {
    if (submitting()) return; // 双击/双回车：上一次还在路上时不再发第二条同参 add（否则落两条重复记录）
    const raw = draft().trim();
    if (!raw) return; // 空输入 / 纯空格：忽略（不提示、不落账）
    const containerId = activeId();
    if (!containerId) {
      // 理论上到不了（listContainers 保证至少一本「默认」）；真到了也不静默丢输入
      reportError(null, "没有可用的容器，请先新建容器");
      return;
    }
    const evaled = evaluateExpression(raw);
    if (!evaled.ok) {
      // 温和提示，不落账、不抛（§二.5：解析失败就是没看懂，不该进台账）
      setHint(evaled.message);
      return;
    }
    // 清空必须在发 IPC **之前**：原来写在 await 之后，两次快速提交会在各自 await 前都还没清空
    // ⇒ 两条 add 都带着同一份 draft 发出去（重复落账），第二次还会把第一次刚填的算式当草稿清掉。
    setSubmitting(true);
    setDraft("");
    setHint("");
    try {
      const res = await api.calcs.add({
        expression: evaled.expression,
        result: evaled.display,
        resultKind: evaled.kind,
        container_id: containerId,
      });
      if (!res.success) {
        reportError(res.error, "没记上，请重试");
        return;
      }
      await reloadRecords(containerId, true);
      focusInput();
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Enter 提交（Shift+Enter 不提交）。IME 组合态不提交：**两个判据都要**——
   * `composing` 由 compositionstart/end 维护（先例 = cloud 插件 `ChatView.ts:395-432`），
   * 而事件的 `isComposing` 兜住「组合刚结束、Enter 紧随其后」的那一帧；只信其中一个都会出现
   * 「选字的那下回车顺手记了一条半成品」。
   */
  const onDraftKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (composing || e.isComposing) return;
    e.preventDefault();
    void submit();
  };

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("success", `已复制${what}到剪贴板`);
    } catch (err) {
      // 剪贴板不可用（权限/无 xclip）——失败也要出声（文案单点 = lib/copyFeedback）
      showToast("error", COPY_ERROR_TITLE, err instanceof Error ? err.message : COPY_ERROR_FALLBACK);
    }
  };

  const toggleSaved = async (rec: CalcRecord) => {
    const res = await api.calcs.update({ id: rec.id, saved: !rec.saved });
    if (!res.success) {
      reportError(res.error, rec.saved ? "取消标记失败" : "标记失败");
      return;
    }
    await reloadRecords();
  };

  const openEdit = (rec: CalcRecord) => {
    setEditId(rec.id);
    setEditTitle(rec.title ?? "");
    setEditNote(rec.note ?? "");
  };

  /** 标题 / 备注补丁式保存：`''` = 清空（核层按 trim 后为空即删除字段，与「从未填过」同形态） */
  const saveEdit = async () => {
    const id = editId();
    if (!id) return;
    const res = await api.calcs.update({ id, title: editTitle(), note: editNote() });
    if (!res.success) {
      reportError(res.error, "保存失败，请重试");
      return;
    }
    setEditId(null);
    await reloadRecords();
  };

  const doDelete = async () => {
    const rec = deleting();
    if (!rec) return;
    const res = await api.calcs.remove(rec.id);
    setDeleting(null);
    if (!res.success) {
      reportError(res.error, "删除失败，请重试");
      return;
    }
    await reloadRecords();
  };

  /** 打开新建容器弹窗（名字留空，落笔即可命名） */
  const openCreateContainer = () => {
    setContainerDialog({ mode: "create", id: "", name: "" });
  };

  const openRenameContainer = (c: CalcContainer) => {
    setContainerDialog({ mode: "rename", id: c.id, name: c.name });
  };

  const containerDialogName = () => containerDialog()?.name ?? "";

  /** 新建 / 重命名共用保存（名字校验先在前端拦一次，核层同口径再拦——空名拒绝） */
  const saveContainerDialog = async () => {
    const dlg = containerDialog();
    if (!dlg) return;
    const name = dlg.name.trim();
    if (!name) {
      showToast("error", "容器名字不能为空");
      return;
    }
    const res =
      dlg.mode === "create"
        ? await api.calcs.createContainer({ name })
        : await api.calcs.renameContainer({ id: dlg.id, name });
    if (!res.success) {
      reportError(res.error, dlg.mode === "create" ? "新建容器失败，请重试" : "重命名失败，请重试");
      return;
    }
    setContainerDialog(null);
    // 新建 ⇒ 直接落到新容器（preferId = 新 id）；重命名 ⇒ 当前容器不动
    const nextId = await reloadContainers(dlg.mode === "create" ? res.data?.id : undefined);
    await reloadRecords(nextId);
    if (dlg.mode === "create") scrollAfterRender();
  };

  /** 删容器第一步：先数条数再开确认弹窗（「明示确认」意味着文案里的数字要先拿到，不是删完才报） */
  const askRemoveContainer = async (c: CalcContainer) => {
    const res = await api.calcs.list(c.id);
    if (!res.success) {
      reportError(res.error, "容器记录读取失败");
      return;
    }
    setDeletingContainer({ container: c, count: (res.data ?? []).length });
  };

  /** 删容器确认：连其中记录一起删（核层原子语义），删完把选中项落到仍存在的容器上 */
  const doRemoveContainer = async () => {
    const target = deletingContainer();
    if (!target) return;
    const res = await api.calcs.removeContainer(target.container.id);
    setDeletingContainer(null);
    if (!res.success) {
      reportError(res.error, "删除容器失败，请重试");
      return;
    }
    const nextId = await reloadContainers();
    await reloadRecords(nextId);
    scrollAfterRender();
  };

  /** 右键动词表对齐既有菜单措辞（§五）：复制结果 📋 / 复制算式 / 编辑标题备注 ✏️ / 标记一下（标记后变「取消标记」）/ 删除 🗑️（danger） */
  const menuItems = (): ContextMenuItem[] => {
    const rec = ctxMenu.payload();
    if (!rec) return [];
    return [
      { label: "复制结果", icon: "📋", action: () => void copyText(rec.result, "结果") },
      { label: "复制算式", icon: "📋", action: () => void copyText(rec.expression, "算式") },
      { label: "编辑标题备注", icon: "✏️", action: () => openEdit(rec) },
      {
        label: rec.saved ? "取消标记" : "标记一下",
        action: () => void toggleSaved(rec),
      },
      { label: "删除", icon: "🗑️", danger: true, action: () => setDeleting(rec) },
    ];
  };

  /** 容器右键动词表：重命名 / 删除（删除 = 连记录一起删 + 确认弹窗点明条数） */
  const containerMenuItems = (): ContextMenuItem[] => {
    const c = containerMenu.payload();
    if (!c) return [];
    return [
      { label: "重命名", icon: "✏️", action: () => openRenameContainer(c) },
      { label: "删除", icon: "🗑️", danger: true, action: () => void askRemoveContainer(c) },
    ];
  };

  onMount(() => {
    void (async () => {
      const id = await reloadContainers();
      await reloadRecords(id, true);
    })();
    // 落到页就聚焦输入框（Ctrl+= 跳页后可直接敲；首帧再兜一次——挂载期后到的插入有时会把焦点抢走）
    focusInput();
    requestAnimationFrame(focusInput);
  });

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      {/* 页头：标题 + 一行 hint（原面板头部副标题——常驻可见又不占输入条空间） */}
      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">计算</h1>
          <p class="text-surface-500 mt-1">回车记一条 · 点结果复制 · 点算式回填改着再算</p>
        </div>
      </div>

      {/* 主体：一张卡内双栏（左容器列表 280px + 右计算区），照 AI 助手双栏骨架 */}
      <div class="card flex-1 min-h-0 flex overflow-hidden">
        {/* 左栏：容器列表（新→旧；flex 列 + min-h-0 让列表在自己这格里滚，不把右栏顶变形） */}
        <aside class="w-[280px] shrink-0 border-r border-surface-200 flex flex-col min-h-0">
          <div class="px-4 py-3 border-b border-surface-200 flex items-center justify-between gap-2">
            <span class="text-sm font-semibold text-surface-700">容器</span>
            <button
              class="link-btn px-1.5 py-0.5 text-xs text-surface-500 hover:text-primary-600"
              title="新建一本容器（计算历史的目录）"
              onClick={openCreateContainer}
            >
              新建容器
            </button>
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto p-2">
            <Show when={containers().length === 0}>
              <div class="py-6 text-center text-xs text-surface-400">暂无容器</div>
            </Show>
            <For each={containersNewestFirst()}>
              {(c) => (
                <button
                  class="row-btn items-start rounded-lg hover:bg-surface-50"
                  classList={{ "bg-primary-600/[0.12]": c.id === activeId() }}
                  data-calc-container-id={c.id}
                  data-calc-side="container"
                  title="点一下切换到这本容器 · 右键重命名或删除"
                  onClick={() => void selectContainer(c.id)}
                  onContextMenu={(e) => containerMenu.open(e, c)}
                >
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-surface-900 truncate">{c.name}</div>
                    <div class="text-xs tabular-nums text-surface-400">{formatCalcTime(c.created)}</div>
                  </div>
                </button>
              )}
            </For>
          </div>
        </aside>

        {/* 右栏：当前容器下的计算区 = 顶部 tab + 条目流（旧→新，提交后滚底）+ 底部输入条 */}
        <div class="flex-1 min-w-0 flex flex-col">
          {/* 顶部「全部 / 已标记」tab（筛当前容器内记录；默认「全部」，§四 4.x 细则 #3） */}
          <div class="shrink-0 px-4 py-2 border-b border-surface-200 flex items-center justify-between gap-3">
            <div class="flex bg-surface-100 rounded-lg p-1">
              <button
                class={`seg-item ${tab() === "all" ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500 hover:text-surface-700"}`}
                data-calc-tab="all"
                onClick={() => setTab("all")}
              >
                全部
              </button>
              <button
                class={`seg-item ${tab() === "saved" ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500 hover:text-surface-700"}`}
                data-calc-tab="saved"
                onClick={() => setTab("saved")}
              >
                已标记
              </button>
            </div>
            {/* 当前容器名（右栏是「这本容器里的历史」，名字常驻可见，不在左栏靠回忆） */}
            <span class="min-w-0 truncate text-xs text-surface-400">{activeContainer()?.name ?? ""}</span>
          </div>

          <div ref={streamEl} class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
            <Show when={visibleRecords().length === 0}>
              <div class="py-6 text-center text-xs text-surface-400">
                {tab() === "saved" ? "这本容器还没有「已标记」的条目" : "还没有记录：输入算式按回车"}
              </div>
            </Show>
            <For each={visibleRecords()}>
              {(rec) => (
                <CalcEntryCard
                  rec={rec}
                  onRefill={refill}
                  onCopy={(r) => void copyText(r.result, "结果")}
                  onToggleSaved={(r) => void toggleSaved(r)}
                  onContextMenu={(e, r) => ctxMenu.open(e, r)}
                />
              )}
            </For>
          </div>

          {/* 解析失败提示（温和一句；打字即撤，不阻塞输入） */}
          <Show when={hint()}>
            <div class="shrink-0 px-4 pt-2 text-xs text-danger-600">{hint()}</div>
          </Show>

          {/* 底部输入条：一行框 + `%` + 日期（没有数字键盘，§四/§九）。
              `min-w-0` 不是装饰：文本框的 `min-width: auto` 是按内容算的（实测这条 placeholder
              把它顶到 347px），不给它就让整条 flex 行溢出——修法 = 允许输入框收缩
              （`flex-1` + `min-w-0`），剩下的宽度它自己吃干净。 */}
          <div ref={barEl} class="flex shrink-0 items-center gap-2 border-t border-surface-200 px-4 py-3">
            <Input
              class="flex-1 min-w-0"
              value={draft()}
              placeholder="输入算式，回车记一条"
              ariaLabel="算式输入"
              onInput={(e) => {
                setDraft(e.currentTarget.value);
                if (hint()) setHint("");
              }}
              onKeyDown={onDraftKeyDown}
              onCompositionStart={() => {
                composing = true;
              }}
              onCompositionEnd={() => {
                composing = false;
              }}
            />
            <button
              class="icon-btn h-9 w-9 shrink-0 text-sm text-surface-500 hover:bg-surface-100 hover:text-primary-600"
              aria-label="插入百分号"
              title="往光标处插入 %"
              onClick={() => insertAtCursor("%")}
            >
              %
            </button>
            {/* 日期走统一 DatePicker（禁原生 type="date"，uiInventory 红线）；
                选中的一天以 YYYY-MM-DD 插进算式，够 `2026-09-16 + 60` 与 `2026-11-15 - 2026-09-16` 两种形态 */}
            <DatePicker
              compact
              value=""
              placeholder="日期"
              ariaLabel="插入日期"
              onChange={(iso) => {
                if (iso) insertAtCursor(iso);
              }}
            />
          </div>
        </div>
      </div>

      {/* 编辑标题备注（framed 统一骨架；页脚裸 button 走 .btn-* 档——先例 ui/ConfirmDialog.tsx） */}
      <Show when={editId()}>
        <Modal
          open
          framed
          size="md"
          title="编辑标题备注"
          subtitle="标题与备注只跟着这一条走；留空即清空，不改算式与结果"
          onClose={() => setEditId(null)}
          footer={
            <>
              <button class="btn-secondary" onClick={() => setEditId(null)}>
                取消
              </button>
              <button class="btn-primary" onClick={() => void saveEdit()}>
                保存
              </button>
            </>
          }
        >
          <div class="dlg-field">
            <label class="dlg-label">标题</label>
            <Input
              value={editTitle()}
              placeholder="给这条起个名，如「新款装箱毛利」（可空）"
              ariaLabel="标题"
              onInput={(e) => setEditTitle(e.currentTarget.value)}
            />
          </div>
          <div class="dlg-field">
            <label class="dlg-label">备注</label>
            <Textarea
              class="w-full"
              rows={3}
              value={editNote()}
              placeholder="备注（可空），如「XX 客户的报价，含 15 个点毛利」"
              onInput={(e) => setEditNote(e.currentTarget.value)}
            />
          </div>
        </Modal>
      </Show>

      {/* 新建 / 重命名容器（同一具弹窗；framed 统一骨架） */}
      <Show when={containerDialog()}>
        <Modal
          open
          framed
          size="md"
          title={containerDialog()?.mode === "rename" ? "重命名容器" : "新建容器"}
          subtitle="容器是计算历史的目录：左栏切换，右栏只看当前容器"
          onClose={() => setContainerDialog(null)}
          footer={
            <>
              <button class="btn-secondary" onClick={() => setContainerDialog(null)}>
                取消
              </button>
              <button class="btn-primary" onClick={() => void saveContainerDialog()}>
                保存
              </button>
            </>
          }
        >
          <div class="dlg-field">
            <label class="dlg-label">容器名</label>
            <Input
              value={containerDialogName()}
              placeholder="给这本容器起个名，如「报价核算」（必填）"
              ariaLabel="容器名"
              onInput={(e) =>
                setContainerDialog((prev) => (prev ? { ...prev, name: e.currentTarget.value } : prev))
              }
              // Enter 即保存（先例 = RenameDialog.tsx:65）；IME 组合态不提交（同输入条的双判据口径）
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.isComposing) return;
                void saveContainerDialog();
              }}
            />
          </div>
        </Modal>
      </Show>

      {/* 删除记录：条目无盘上文件实体，不进回收站 ⇒ 只做二次确认后直接删（§三 / §八⑤ 拍板） */}
      <Show when={deleting()}>
        <ConfirmDialog
          title="删除这条计算？"
          message="删除后无法恢复（计算条目不进回收站）。"
          confirmLabel="删除"
          danger
          onConfirm={() => void doDelete()}
          onCancel={() => setDeleting(null)}
        />
      </Show>

      {/* 删除容器：连其中记录一起删，确认文案**点明条数**（§四 4.x 细则 #1 拍板） */}
      <Show when={deletingContainer()}>
        <ConfirmDialog
          title="删除这本容器？"
          message={
            (deletingContainer()?.count ?? 0) > 0
              ? `这本容器里的 ${deletingContainer()?.count} 条计算记录会一起删除，删除后无法恢复（不进回收站）。`
              : "这本容器里目前没有计算记录；删除后无法恢复。"
          }
          confirmLabel="删除"
          danger
          onConfirm={() => void doRemoveContainer()}
          onCancel={() => setDeletingContainer(null)}
        />
      </Show>

      <Show when={ctxMenu.show()}>
        <ContextMenu x={ctxMenu.x()} y={ctxMenu.y()} onClose={ctxMenu.close} items={menuItems()} />
      </Show>
      <Show when={containerMenu.show()}>
        <ContextMenu x={containerMenu.x()} y={containerMenu.y()} onClose={containerMenu.close} items={containerMenuItems()} />
      </Show>
    </div>
  );
}