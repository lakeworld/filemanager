import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
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
import type { CalcRecord } from "~/types";

/**
 * 计算页（v2.5.9/A7「计算」· 2026-09-22 深夜整页化修订）——整页双栏 + 计算历史流。
 *
 * 权威 = `内部计算设计文档（不进公开仓）` §四（2026-09-22 深夜用户拍板由「悬浮面板」改「整页」后的
 * 新版式）与 §八 四条拍板（v1 不做挂靠 / 删除走确认弹窗等仍有效）。
 *
 * 由来（用户原话）：「把这个计算撑满整个……然后左边是历史，右边是计算」+
 * 「和 AI 助手的界面其实差不多，但是不是对话，是记录条目」⇒ 骨架对标 cloud 插件 AI 助手
 * （左索引栏 + 右内容流 + 底部输入条），**只借形不借功能**：右栏是记录条目流，不是对话气泡。
 *
 * 版式（§四 逐条落地）：
 * - **左栏 = 历史索引**（≈280px，新→旧：最新在最上）：每行 = 标题（有则）/ 算式小灰字 / 结果大字；
 *   点一行 ⇒ 右栏对应条目滚入视野并高亮一下（`.card-selected`，1.2s 自熄）。
 * - **右栏 = 计算区**：上方记录条目流（**旧的在上、新的在下**——输入条贴底，回车记的新条目
 *   就在输入条上方，提交后自动滚到底）+ 底部输入条（一行框 + `%` + 日期）。
 * - **条目卡 = 大号记录条目**（不是聊天气泡）：标题 / 算式（点一下回填输入框「改着再算」，
 *   链式引用就从这里长出来）/ 结果大字 + 相对时间（点一下复制）/ 备注浅字 / 「已标记」小 chip
 *   （标记后两态唯一视觉差异）/ 常驻动作钮「复制」「标记一下 ⇄ 取消标记」。
 *   hover 隐藏按钮是窄条面板时代的版式，整宽大卡放得下常驻钮 ⇒ 不再藏。
 * - **没有数字键盘**——用户直接敲键盘（§九 明确不做）。
 *
 * 两条口径与核层对齐：
 * - 求值只走 `shared/calc.evaluateExpression`（双端同一份实现，台账只存展示态）：
 *   成功才落账，失败只显示温和文案、**不落账、不抛**（§二.5 容错三条）；
 * - `api.calcs.*` 的 `ok === false`（`ApiResult.success === false`）分支一律出声（toast），不静默吞。
 */

/** 历史索引栏里的一行（点击 = 右栏定位；行内不做数据操作，动作全在条目卡与右键菜单）。Solid 纪律：禁解构 props */
function CalcHistoryRow(props: {
  rec: CalcRecord;
  active: boolean;
  onJump: (rec: CalcRecord) => void;
}) {
  return (
    <button
      class="row-btn items-start rounded-lg hover:bg-surface-50"
      classList={{ "bg-primary-600/[0.12]": props.active }}
      data-calc-id={props.rec.id}
      data-calc-side="history"
      title="点一下，在右边定位到这一条"
      onClick={() => props.onJump(props.rec)}
    >
      <div class="min-w-0 flex-1">
        {/* 有标题先显示标题行（左栏扫读靠它；没有标题时算式就是主标识） */}
        <Show when={props.rec.title}>
          <div class="text-sm font-medium text-surface-900 truncate">{props.rec.title}</div>
        </Show>
        <div class="text-xs text-surface-400 truncate">{props.rec.expression}</div>
        <Show when={props.rec.saved}>
          <span class="chip mt-1 bg-success-50 text-success-700">已标记</span>
        </Show>
      </div>
      {/* 结果大字是左栏扫读的主信息（新→旧 + 行内含结果：一屏扫最多历史）；时间取 created 而不是
          updated——历史索引是「什么时候记的」时间线，updated 会被「编辑标题备注 / 标记」刷成当下，
          用它会让三天前记的一条在今天冒头。 */}
      <div class="shrink-0 text-right">
        <div class="text-base font-semibold leading-tight tabular-nums text-surface-900">
          {props.rec.result}
        </div>
        <div class="text-xs tabular-nums text-surface-400">{formatCalcTime(props.rec.created)}</div>
      </div>
    </button>
  );
}

/** 右栏的一条「记录条目」大卡（行内动作经 props 回调回页面；Solid 纪律：禁解构 props） */
function CalcEntryCard(props: {
  rec: CalcRecord;
  flash: boolean;
  onRefill: (rec: CalcRecord) => void;
  onCopy: (rec: CalcRecord) => void;
  onToggleSaved: (rec: CalcRecord) => void;
  onContextMenu: (e: MouseEvent, rec: CalcRecord) => void;
}) {
  return (
    <div
      class="card p-4"
      classList={{ "card-selected": props.flash }}
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

export default function Calc() {
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
  /** 左栏点了某行 ⇒ 右栏对应条目高亮一下（1.2s 自熄）；null = 无高亮 */
  const [flashId, setFlashId] = createSignal<string | null>(null);
  /** IME 组合态标志（`compositionstart/end` 维护；与事件的 `isComposing` 双保险，见 onDraftKeyDown） */
  let composing = false;
  let streamEl: HTMLDivElement | undefined;
  let barEl: HTMLDivElement | undefined;
  let flashTimer: number | undefined;
  const ctxMenu = useContextMenu<CalcRecord>();

  /** 输入框元素只在底部输入条里找——不读 DOM 值（值一律走 `draft()` 信号），只用它送焦点与插光标 */
  const inputEl = () => barEl?.querySelector<HTMLInputElement>("input") ?? null;
  const focusInput = () => inputEl()?.focus();

  /** 左栏索引 = 新→旧（records 是录入序：旧→新；倒序只做展示，不改台账） */
  const historyRows = () => records().slice().reverse();

  /** 提交后滚到底：新的在下面，「滚到底才看见刚记的」是台账直觉（§四 右栏正序） */
  const scrollAfterRender = () => requestAnimationFrame(() => {
    if (streamEl) streamEl.scrollTop = streamEl.scrollHeight;
  });

  /** 失败出声的统一出口（IPC 的 `error` 有就用，没有就给一句人话，不显示 undefined） */
  const reportError = (error: string | null | undefined, fallback: string) =>
    showToast("error", error || fallback);

  const reload = async (scroll = false) => {
    const res = await api.calcs.list();
    if (!res.success) {
      reportError(res.error, "计算历史读取失败");
      return;
    }
    setRecords(res.data ?? []);
    if (scroll) scrollAfterRender();
  };

  /** 点左栏一行 ⇒ 右栏对应条目滚入视野 + 高亮一下（页面里定位，不切任何状态） */
  const jumpTo = (rec: CalcRecord) => {
    const el = streamEl?.querySelector<HTMLElement>(`[data-calc-id="${rec.id}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
    setFlashId(rec.id);
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => setFlashId(null), 1200);
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
      });
      if (!res.success) {
        reportError(res.error, "没记上，请重试");
        return;
      }
      await reload(true);
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
    await reload();
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
    await reload();
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
    await reload();
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

  onMount(() => {
    void reload(true);
    // 落到页就聚焦输入框（Ctrl+= 跳页后可直接敲；首帧再兜一次——挂载期后到的插入有时会把焦点抢走）
    focusInput();
    requestAnimationFrame(focusInput);
  });

  onCleanup(() => window.clearTimeout(flashTimer));

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      {/* 页头：标题 + 一行 hint（原面板头部副标题——常驻可见又不占输入条空间） */}
      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">计算</h1>
          <p class="text-surface-500 mt-1">回车记一条 · 点结果复制 · 点算式回填改着再算</p>
        </div>
      </div>

      {/* 主体：一张卡内双栏（左历史索引 280px + 右计算区），照 AI 助手双栏骨架 */}
      <div class="card flex-1 min-h-0 flex overflow-hidden">
        {/* 左栏：历史索引（新→旧；flex 列 + min-h-0 让列表在自己这格里滚，不把右栏顶变形） */}
        <aside class="w-[280px] shrink-0 border-r border-surface-200 flex flex-col min-h-0">
          <div class="px-4 py-3 border-b border-surface-200 text-sm font-semibold text-surface-700">
            历史
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto p-2">
            <Show when={records().length === 0}>
              <div class="py-6 text-center text-xs text-surface-400">暂无历史</div>
            </Show>
            <For each={historyRows()}>
              {(rec) => (
                <CalcHistoryRow
                  rec={rec}
                  active={flashId() === rec.id}
                  onJump={jumpTo}
                />
              )}
            </For>
          </div>
        </aside>

        {/* 右栏：计算区 = 上条目流（旧→新，提交后滚底）+ 下输入条 */}
        <div class="flex-1 min-w-0 flex flex-col">
          <div ref={streamEl} class="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
            <Show when={records().length === 0}>
              <div class="py-6 text-center text-xs text-surface-400">还没有记录：输入算式按回车</div>
            </Show>
            <For each={records()}>
              {(rec) => (
                <CalcEntryCard
                  rec={rec}
                  flash={flashId() === rec.id}
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

      {/* 删除：条目无盘上文件实体，不进回收站 ⇒ 只做二次确认后直接删（§三 / §八⑤ 拍板） */}
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

      <Show when={ctxMenu.show()}>
        <ContextMenu x={ctxMenu.x()} y={ctxMenu.y()} onClose={ctxMenu.close} items={menuItems()} />
      </Show>
    </div>
  );
}
