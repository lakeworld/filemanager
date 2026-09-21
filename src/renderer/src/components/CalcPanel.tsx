import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import Input from "~/components/ui/Input";
import Textarea from "~/components/ui/Textarea";
import Modal from "~/components/ui/Modal";
import ConfirmDialog from "~/components/ConfirmDialog";
import ContextMenu from "~/components/ContextMenu";
import type { ContextMenuItem } from "~/components/ContextMenu";
import DatePicker from "~/components/DatePicker";
import { pushLayer } from "~/components/ui/layerStack";
import { useContextMenu } from "~/hooks/useContextMenu";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import { calcPanelOpen, closeCalcPanel } from "~/stores/calcPanel";
import { COPY_ERROR_FALLBACK, COPY_ERROR_TITLE } from "~/lib/copyFeedback";
import { evaluateExpression, formatCalcTime } from "../../../shared/calc";
import type { CalcRecord } from "~/types";

/**
 * 计算面板（v2.5.9/A7「计算」）——悬浮面板 + 计算历史流。
 *
 * 权威 = `docs/INTERNAL/PLAN-v2.6-计算.md` §四（UI 照示意图钉死）与 §八 四条拍板
 * （悬浮面板 / 侧栏项 + `Ctrl+=` / v1 不做挂靠 / 删除走确认弹窗）。
 *
 * 版式（§四逐条落地）：上历史流（对话式，**旧的在上、新的在下**）+ 底部输入条（一行框 + `%` + 日期）。
 * 一行 = 左上算式小灰字〔点一下回填输入框「改着再算」〕/ 右上结果大字 + 相对时间小灰字〔点一下复制〕；
 * 有备注多一行浅字，已转正多一枚「已存资料」小 chip（两态唯一视觉差异）；
 * hover 时结果与时间**原位**隐去，换「复制 / 存为资料」两枚小按钮（写法先例 `InvoiceCards.tsx:212`）。
 * **没有数字键盘**——用户直接敲键盘（§九 明确不做）。
 *
 * 两条口径与核层对齐：
 * - 求值只走 `shared/calc.evaluateExpression`（双端同一份实现，台账只存展示态）：
 *   成功才落账，失败只显示温和文案、**不落账、不抛**（§二.5 容错三条）；
 * - `api.calcs.*` 的 `ok === false`（`ApiResult.success === false`）分支一律出声（toast），不静默吞。
 *
 * 层栈纪律：面板入栈但**不标 `modal: true`**——它是「手头正干着别的」时随手开的一块浮层，
 * 不是用户被关进工作面（§八②「算账场景是手头正干着别的，不该切页」）。标了会把页面级快捷键
 * 整片挡掉（`shortcuts.ts` 的让位判据），那正是本仓 v2.5.9 按键归属修复要区分的东西。
 */

/** 历史流里的一行（行内不做数据操作，动作全部经 props 回调回面板；Solid 纪律：禁解构 props） */
function CalcHistoryRow(props: {
  rec: CalcRecord;
  onRefill: (rec: CalcRecord) => void;
  onCopy: (rec: CalcRecord) => void;
  onToggleSaved: (rec: CalcRecord) => void;
  onContextMenu: (e: MouseEvent, rec: CalcRecord) => void;
}) {
  return (
    <div
      class="group rounded-lg px-3 py-2 transition-colors hover:bg-surface-50"
      title="点结果复制 · 点算式回填改着再算 · 右键更多"
      onContextMenu={(e) => props.onContextMenu(e, props.rec)}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          {/* 有标题先显示标题行（§四 行结构：眼睛先看结果，再看这行是怎么来的） */}
          <Show when={props.rec.title}>
            <div class="text-sm font-medium text-surface-900 truncate">{props.rec.title}</div>
          </Show>
          {/* 算式 = 展示态（× ÷ 已渲染）；点一下回填输入框，链式引用就从这里长出来 */}
          <button
            class="link-btn flex w-full min-w-0 text-left text-xs text-surface-400 hover:text-primary-600"
            title="点一下，把这条算式填回输入框改着再算"
            onClick={() => props.onRefill(props.rec)}
          >
            <span class="truncate">{props.rec.expression}</span>
          </button>
          <Show when={props.rec.note}>
            <div class="text-xs text-surface-400 truncate mt-0.5">{props.rec.note}</div>
          </Show>
        </div>
        {/* 右上：结果大字 + 相对时间；hover 时两者原位淡出，同位置淡入两枚小按钮 */}
        <div class="relative shrink-0 text-right">
          <div class="transition-opacity group-hover:opacity-0">
            <button
              class="link-btn text-lg font-semibold leading-tight tabular-nums text-surface-900 hover:text-primary-700"
              title="点击复制结果"
              onClick={() => props.onCopy(props.rec)}
            >
              {props.rec.result}
            </button>
            {/* 时间取 `created` 而不是 `updated`：历史流是「什么时候记的」时间线，
                而 `updated` 会被「编辑标题备注 / 转正」刷成当下（核层 update 里就是 `new Date()`），
                用它会让三天前记的一条在今天冒头——台账的时间轴语义比"最近改过"更重要。 */}
            <div class="text-xs tabular-nums text-surface-400">{formatCalcTime(props.rec.created)}</div>
          </div>
          {/* hover 层必须连带 pointer-events 一起换挡：opacity-0 **不挡命中测试**，
              只做淡出会让这层隐形按钮盖住下面的结果——实测后果是「点结果」点在隐形的
              「存为资料」上（右半边尤其危险：静默转正）。未 hover 时整层不接指针，
              hover 到行内才接（group-hover:pointer-events-auto），两条路都回到原型。 */}
          <div class="pointer-events-none absolute inset-0 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            <button
              class="link-btn px-1.5 py-0.5 text-xs text-surface-500 hover:text-primary-600"
              title="复制结果"
              onClick={() => props.onCopy(props.rec)}
            >
              复制
            </button>
            <button
              class="link-btn px-1.5 py-0.5 text-xs text-surface-500 hover:text-primary-600"
              title={props.rec.saved ? "取消转正（回到暂存）" : "存为资料"}
              onClick={() => props.onToggleSaved(props.rec)}
            >
              {/* 文案跟着状态走：已转正的行这枚按钮点下去是**取消转正**（toggleSaved），
                  原来两态都写「存为资料」，是文案与行为相反 */}
              {props.rec.saved ? "取消转正" : "存为资料"}
            </button>
          </div>
        </div>
      </div>
      <Show when={props.rec.saved}>
        <span class="chip mt-1 bg-success-50 text-success-700">已存资料</span>
      </Show>
    </div>
  );
}

function CalcPanelInner() {
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
  /** IME 组合态标志（`compositionstart/end` 维护；与事件的 `isComposing` 双保险，见 onDraftKeyDown） */
  let composing = false;
  let listEl: HTMLDivElement | undefined;
  let barEl: HTMLDivElement | undefined;
  const ctxMenu = useContextMenu<CalcRecord>();

  /** 输入框元素只在底部输入条里找——不读 DOM 值（值一律走 `draft()` 信号），只用它送焦点与插光标 */
  const inputEl = () => barEl?.querySelector<HTMLInputElement>("input") ?? null;
  const focusInput = () => inputEl()?.focus();

  const scrollToBottom = () => {
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  };
  /** 提交后滚到底：新的在下面，「滚到底才看见刚记的」是台账直觉（§四 正序） */
  const scrollAfterRender = () => requestAnimationFrame(scrollToBottom);

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
      reportError(res.error, rec.saved ? "取消转正失败" : "存为资料失败");
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

  /** 右键动词表对齐既有菜单措辞（§五）：复制结果 📋 / 复制算式 / 编辑标题备注 ✏️ / 存为资料（转正后变「取消转正」）/ 删除 🗑️（danger） */
  const menuItems = (): ContextMenuItem[] => {
    const rec = ctxMenu.payload();
    if (!rec) return [];
    return [
      { label: "复制结果", icon: "📋", action: () => void copyText(rec.result, "结果") },
      { label: "复制算式", icon: "📋", action: () => void copyText(rec.expression, "算式") },
      { label: "编辑标题备注", icon: "✏️", action: () => openEdit(rec) },
      {
        label: rec.saved ? "取消转正" : "存为资料",
        action: () => void toggleSaved(rec),
      },
      { label: "删除", icon: "🗑️", danger: true, action: () => setDeleting(rec) },
    ];
  };

  onMount(() => {
    // 入层栈（不标 modal，见文件头）：Esc 只派栈顶，右键菜单/日期面板叠在面板上时先关它们
    const layer = pushLayer({ onEscape: closeCalcPanel });
    onCleanup(() => layer.remove());
    void reload(true);
    // 打开即聚焦输入框；首帧再兜一次——挂载期后到的插入（如预览/拖拽）有时会把焦点抢走
    focusInput();
    requestAnimationFrame(focusInput);
  });

  return (
    <>
      {/* 遮罩：点外部关闭（比 Modal 的 bg-black/50 淡——面板刻意「不挡视线」） */}
      <div class="fixed inset-0 z-modal bg-black/20" onClick={closeCalcPanel} />
      {/* 右对齐、上留头高：不挡侧栏与标题栏（这是刻意的几何，不是随手给的偏移）。
          卡片必须与遮罩**同级 z**（`z-modal`）——遮罩带 z-index、卡片不带时，带 z-index 的那个
          会盖在不带的上面（两者是兄弟节点，命中测试先看 z 再看 DOM 序），实测后果是
          「面板看得见、点什么都点在遮罩上」（点击被遮罩吃掉，只有键盘可用）。
          同级后由 DOM 序决定：卡片在后 ⇒ 卡片在上、可点，遮罩只剩四周那一圈。 */}
      <div class="modal-panel modal-panel-framed absolute right-8 top-16 z-modal max-h-[72vh] w-[420px]">
        <div class="dlg-header flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="dlg-title">计算</div>
            <div class="dlg-sub">回车记一条 · 点结果复制 · 点算式回填改着再算</div>
          </div>
          <button
            class="icon-btn shrink-0 px-1.5 text-surface-400 hover:bg-surface-100 hover:text-surface-600"
            aria-label="关闭计算面板"
            title="关闭（Esc）"
            onClick={closeCalcPanel}
          >
            ✕
          </button>
        </div>

        {/* 历史流（正序：旧的在上、新的在下；提交后滚到底）。flex-1 + min-h-0 让超长历史在自己这格里滚，
            不把底部输入条顶出面板 */}
        <div ref={listEl} class="flex-1 min-h-0 overflow-y-auto px-1.5 py-2">
          <Show when={records().length === 0}>
            <div class="py-6 text-center text-xs text-surface-400">还没有记录：输入算式按回车</div>
          </Show>
          <For each={records()}>
            {(rec) => (
              <CalcHistoryRow
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
          <div class="shrink-0 px-3 pt-2 text-xs text-danger-600">{hint()}</div>
        </Show>

        {/* 底部输入条：一行框 + `%` + 日期（没有数字键盘，§四/§九）。
            `min-w-0` 不是装饰：文本框的 `min-width: auto` 是按内容算的（实测这条 placeholder
            把它顶到 347px），不给它就让整条 flex 行溢出卡片——实测后果是日期触发器被挤出卡片
            右缘 37px（视觉上少一截、且超出部分的点击落到遮罩上），并连带触发
            「聚焦 → 浏览器把它滚回视野 → 滚动事件 → DatePicker 自己关掉面板」那条链。
            修法 = 允许输入框收缩（`flex-1` + `min-w-0`），剩下的宽度它自己吃干净。 */}
        <div ref={barEl} class="flex shrink-0 items-center gap-2 bg-surface-50 px-3 py-2.5">
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
    </>
  );
}

/** 面板本体只在打开时挂载（层栈入栈、历史拉取、聚焦都跟着挂载走，关闭即整体卸载） */
export default function CalcPanel() {
  return <Show when={calcPanelOpen()}>{<CalcPanelInner />}</Show>;
}