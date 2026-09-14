/**
 * 层栈（v2.5.1 T2，D2）：Modal 与 Portal 弹出层（DatePicker/TagInput/ContextMenu）共用的模块级栈。
 * - 全局单 keydown 监听，Esc 只派栈顶
 * - 焦点困守只对栈顶 Modal 生效（非栈顶 Modal 不抢焦点）
 * - 消费顺序：弹出层 > 弹窗 > 页面（先入栈的层级更低）；`lowest` 层永远垫在所有普通层之下
 * 用法：pushLayer({ onEscape }) 返回移除函数（组件 onCleanup 调用）。
 */

interface Layer {
  id: number;
  onEscape?: () => void;
  /**
   * **弹窗级层**（v2.5.9 按键归属修复新增）：用户「正在这个层里干活」的那一类——
   * `ui/Modal` 家族（含 ConfirmDialog / 各种表单弹窗）与预览弹窗。
   * 置真 ⇒ 栈里有它时，注册方标了 `pageOnly` 的**页面级快捷键**一律让位
   * （判据见 `shortcuts.ts` 的派发与 `hasModalLayer()`）。
   * 为什么要是显式标记而不是「凡非 `lowest` 者皆弹窗」：层栈里还有一批**非弹窗的常驻/瞬时层**
   * （`FileBrowserView` 的「剪切标记」Esc 撤销层、`Header` 工作区菜单、SearchSelect/TagInput/DatePicker 面板、
   * `ContextMenu`），它们不是「用户刚打开的一个工作面」——尤其剪切标记层，Ctrl+V 正是它的下游动作，
   * 把它当弹窗会直接废掉「Ctrl+X → 换目录 → Ctrl+V」这条主路径。
   */
  modal?: boolean;
  /**
   * 置底层：入栈但排在所有普通层**之下**。
   * 给「常驻在页面上的浮层」用（v2.5.8 D10 `ui/SelectionBar`：选中后常驻底部的多选条）。
   * 它不是用户「刚刚打开」的东西，而是一直在那儿的页面级能力，所以 Esc 的归属必须永远
   * 让位于真正后开的弹窗 / 右键菜单 / DatePicker——否则会出现「右键 → Esc 本该关菜单，
   * 结果先把选中清了、菜单还挂着」（D10 e2e `context-menu:182` 实测抓到的形态：
   * 右键那一下同时选中了卡片，浮条与菜单在同一次提交里各自入栈，后入栈的浮条反而压在菜单上）。
   */
  lowest?: boolean;
}

let stack: Layer[] = [];
let nextId = 1;

/**
 * 入栈位置：`lowest` 层插在**所有普通层之下**（但仍排在已有的置底层之后，保持后开先关）。
 * 这么做而不是在取栈顶时挑挑拣拣，是因为栈顶还被 `topLayerId()` / `isTop()` 用来判
 * 「焦点困守归谁」——那条路径只认末位。带常驻浮条的页面照样能开弹窗（发票页选中若干行
 * 再开编辑弹窗），若让浮条压在弹窗上面，弹窗就丢了焦点困守。
 */
const insertLayer = (layer: Layer): void => {
  if (!layer.lowest) {
    stack.push(layer);
    return;
  }
  let i = 0;
  while (i < stack.length && stack[i].lowest) i++;
  stack.splice(i, 0, layer);
};

const onKeydown = (e: KeyboardEvent): void => {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (top) {
    // 消费 Esc：后续监听（页面级 Esc 如 FilePreviewModal）经 defaultPrevented 让位；
    // 层内 onEscape 同步触发 Solid 渲染移除本层后，同事件不再传播给页面监听
    e.preventDefault();
    top.onEscape?.();
  }
};

// 模块级单监听（随应用生命周期常驻，无泄漏）。
// typeof 守卫只为让纯 node 环境（vitest）能 import 本模块钉住入栈顺序与 Esc 派发的单测——
// 渲染进程里 window 恒存在，浏览器行为零变化。
if (typeof window !== "undefined") window.addEventListener("keydown", onKeydown);

/** 入栈；返回 { id, remove }（组件 onCleanup / 关闭时调用 remove） */
export function pushLayer(layer: Omit<Layer, "id">): { id: number; remove: () => void } {
  const id = nextId++;
  // 必须走 insertLayer 而不是 stack.push：直接 push 会让 lowest 参数成为死代码——
  // 常驻浮条照样压在刚开的弹窗/右键菜单上面，抢走第一次 Esc，并让弹窗丢了 isTop 焦点困守。
  insertLayer({ ...layer, id });
  return {
    id,
    remove: () => {
      stack = stack.filter((x) => x.id !== id);
    },
  };
}

/** 当前栈顶 id（无层返回 0） */
export function topLayerId(): number {
  return stack.length > 0 ? stack[stack.length - 1].id : 0;
}

/** 指定 id 是否为栈顶（焦点困守/Esc 归属判断） */
export function isTop(id: number): boolean {
  return topLayerId() === id;
}

/**
 * 栈里是否开着**弹窗级层**（页面级快捷键的让位判据，v2.5.9）。
 * 读的是「有没有」而不是「栈顶是谁」：弹窗上还能再叠确认框（预览里删文件就是两层），
 * 只要底下还压着页面，页面就该让位——判栈顶会让「弹窗 + 确认框」这种现场漏判。
 */
export function hasModalLayer(): boolean {
  return stack.some((l) => l.modal === true);
}

/** 测试辅助：清空栈 */
export function clearStackForTest(): void {
  stack = [];
}

/**
 * 测试辅助：直接跑一次 Esc 派发（等价于 window 上那次 keydown）。
 * 纯 node 环境下模块级监听未挂（见上方 typeof window 守卫），故用它来钉
 * 「Esc 只派栈顶 + 消费后 defaultPrevented」这两条不变式。
 */
export function dispatchEscapeForTest(): { prevented: boolean } {
  let prevented = false;
  onKeydown({ key: "Escape", preventDefault: () => { prevented = true; } } as unknown as KeyboardEvent);
  return { prevented };
}
