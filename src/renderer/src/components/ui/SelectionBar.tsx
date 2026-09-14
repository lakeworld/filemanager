import { Show, For } from "solid-js";
import type { JSX } from "solid-js";
import { createEffect, onCleanup } from "solid-js";
import { registerShortcut } from "~/shortcuts";
import { selectionBarVisible } from "~/stores/appSettings";
import { pushLayer } from "./layerStack";
import {
  SELECTION_ACTION_CLASS,
  SELECTION_CLEAR_CLASS,
  selectionLabel,
  type SelectionActionTone,
} from "~/lib/selectionBar";

/**
 * 悬浮多选操作条（v2.5.8 D10 / 精致化 PLAN W5）。
 *
 * 立这条的原因：同一条「已选择 N 个 / 取消 / 批量动作」的横条，此前在七个地方各手写一份
 * （`FileBrowserView` / `Images` / `Certs` / `Notes` / `Invoices` 发票与入库 / `Quotes`），
 * 骨架一致而材质各异——Notes 那份早已改成底部悬浮，其余六份还挂在内嵌流里，
 * 于是「选中时列表被顶下 ~68px，第二次点击落到计数行上、双击开编辑丢失」这个坑
 * 只在没改过的页面上存在（`Notes.tsx:492` 注释里 e2e 事件轨迹抓实的那一条）。
 * 收成一处后这类位移缺陷不可能再在新页面复活。
 *
 * **形态 = 底部悬浮、不进文档流**：`fixed bottom-6` + 水平居中（居中写法见下方 JSX 注释——
 * 与 D10 初版用的 `left-1/2` + `-translate-x-1/2` 不同，那种写法和 `.fade-rise` 关键帧打架），
 * 各长列表页为滚动区预留底部 padding 防遮最后一行（出处 = 精致化 PLAN 的 W5 一节）。
 *
 * **材质 = 浮层，允许玻璃**：`.glass-panel` + 双层影 + 内亮边属 §四「一眼掠过的面」，
 * 与「弹窗/读字表面必须实底」那条红线不冲突——浮条上只有计数与按钮文字，
 * 且面积 ≪ 30% 视口、不做常驻高基数合成。后来者别按读字表面的标准判它违规。
 *
 * Solid 纪律（D11）：禁解构 props；值一律从 props 信号读。
 */

export interface SelectionAction {
  /** 按钮文案——W5 替换纪律：**与收编前一字不改**，既有 e2e 全靠 text 定位 */
  label: string;
  /** 缺省 default（白底描边）；primary = 主行动，danger = 批量删除那一档 */
  tone?: SelectionActionTone;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}

export interface SelectionBarProps {
  /**
   * 选中数；0 时整条不渲染，且**层栈与 Ctrl+A / Delete 注册都不挂**
   * （不会白占 Esc，更不会在无选中时把 Delete 吞成「删 0 条」确认框）。
   */
  count: number;
  /** 量词：个文件 / 张发票 / 条入库单 / 条报价 / 篇笔记 */
  noun: string;
  /** 动作反馈文案（原 FileBrowserView 的 `actionMessage()` 槽） */
  message?: string;
  actions: SelectionAction[];
  /** 清空选择；同时是 Esc 的落点（入层栈栈顶消费） */
  onClear: () => void;
  /**
   * 「全选可见」回调（v2.5.8 D11 / W6）：传了才注册 `Ctrl+A`。
   * 放在组件里注册而不是各页各挂一个监听——W6 的立身之本就是「全站一个 keydown」，
   * 且浮条存在 ⟺ 有选中，正是这两个键唯一有意义的时刻。
   */
  onSelectAll?: () => void;
  /** 「删除选中」回调（W6 的 `Delete`）：必须传既有的删除入口，**不得新造删除语义** */
  onDelete?: () => void;
}

export default function SelectionBar(props: SelectionBarProps): JSX.Element {
  /**
   * Ctrl+A / Delete 也走 `shortcuts.ts` 单注册点（**有选中期间**才接管，清零或卸载即注销）。
   * 两道不注册的闸门：① 未传对应回调 = 该页没有这个动作；② `count` 为 0 = 没有可操作的对象。
   * 闸门②是 2026-09-12 复审补的：早先只看①，而 Quotes / Invoices（发票与入库两处）的
   * `onDelete` 回调本身不带空守卫（`onDelete={() => setBatchDeleteConfirm(true)}` 这类），
   * 于是零选中时按 Delete 会弹「确定删除已选的 0 条报价记录吗？」——与 `shortcuts.ts` 里
   * 这两条 desc 的口径、以及 CHANGELOG「无选中时不消费」的承诺同时相反。
   * count 读在 effect 内 → 选中清零时自动注销，键原样放行给浏览器（Files 页靠的是页面侧
   * 回调自带守卫，所以 e2e `shortcuts.spec` 那条「未注册即原样放行」一直是假绿）。
   */
  createEffect(() => {
    if (props.count <= 0) return;
    const offs: (() => void)[] = [];
    if (props.onSelectAll) {
      const fn = props.onSelectAll;
      offs.push(
        registerShortcut("list.selectAll", () => {
          fn();
          return true;
        }, { pageOnly: true }),
      );
    }
    if (props.onDelete) {
      const fn = props.onDelete;
      offs.push(
        registerShortcut("list.delete", () => {
          fn();
          return true;
        }, { pageOnly: true }),
      );
    }
    onCleanup(() => offs.forEach((off) => off()));
  });

  /**
   * Esc 入层栈，**但以 `lowest` 置底入栈**。
   * 直觉上「后入栈即在栈顶、自然优先」就够了，实测不够：右键卡片那一刻，卡片同时被选中
   * （W5 的单选语义），浮条与 ContextMenu 在**同一次渲染提交**里各自入栈，谁排在后面
   * 取决于组件挂载顺序而非用户意图——浮条压在菜单之上，第一次 Esc 就去清了选择、菜单还挂着
   * （D10 e2e `context-menu:182` 就是这么红的）。
   * 语义上浮条也不该争：它是「一直在那儿的页面级能力」，不是用户刚打开的一层。
   * 置底同时保住另一件事——带选中态的页面开弹窗时，栈顶仍是弹窗，
   * `isTop()` 驱动的焦点困守不会因浮条而失效。
   */
  createEffect(() => {
    const n = props.count;
    if (n <= 0) return;
    const layer = pushLayer({ onEscape: () => props.onClear(), lowest: true });
    onCleanup(() => layer.remove());
  });

  return (
    // v2.5.8 D11（W7）：`selectionBar` 设置关 → 只隐藏浮条本身。
    // 上面的 Ctrl+A / Delete 注册与 Esc 入层栈**照旧生效**（选择态与键盘语义不随显隐变化，
    // 关掉的只是画面占用）。待拍板 #7「关闭后的内嵌双形态回退」今晚未拍板 → 按既定规则不做回退形态。
    <Show when={props.count > 0 && selectionBarVisible()}>
      {/* 居中用 left-0/right-0 + mx-auto，**不用** left-1/2 + -translate-x-1/2：
          Tailwind 3.4 的 translate-x 编译成 `transform: translate(var(--tw-translate-x), …)`，
          而本元素挂着 `.fade-rise`，其关键帧写了 `transform: translateY(8px→0)`——入场 300ms 内
          关键帧整体覆盖该类 transform，横向 -50% 丢失，浮条先贴左再在动画结束那帧跳回中间
          （2026-09-12 复审 P0 抓到的形态，`index.css` 的 fadeRise 定义在此）。
          w-max 让条按内容取宽（固定 + 左右都定值时 auto 外边距才居中得起来）；max-w 兜窄窗口换行。 */}
      <div
        class="fixed bottom-6 left-0 right-0 mx-auto z-30 w-max max-w-[92vw] flex items-center justify-between gap-4 p-3 glass-panel rounded-xl shadow-card-hover border border-primary-100 fade-rise"
        role="toolbar"
        aria-label="批量操作"
      >
        <div class="flex flex-col gap-1">
          <span class="text-sm text-primary-700 whitespace-nowrap">
            {selectionLabel(props.count, props.noun)}
          </span>
          <Show when={props.message}>
            <span class="text-xs text-primary-600">{props.message}</span>
          </Show>
        </div>
        <div class="flex gap-2">
          <button class={SELECTION_CLEAR_CLASS} onClick={() => props.onClear()}>
            取消选择
          </button>
          <For each={props.actions}>
            {(a) => (
              <button
                class={SELECTION_ACTION_CLASS[a.tone ?? "default"]}
                title={a.title}
                disabled={a.disabled}
                onClick={() => a.onClick()}
              >
                {a.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
