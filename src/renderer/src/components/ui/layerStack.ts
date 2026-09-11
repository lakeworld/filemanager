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

// 模块级单监听（随应用生命周期常驻，无泄漏）
window.addEventListener("keydown", onKeydown);

/** 入栈；返回 { id, remove }（组件 onCleanup / 关闭时调用 remove） */
export function pushLayer(layer: Omit<Layer, "id">): { id: number; remove: () => void } {
  const id = nextId++;
  stack.push({ ...layer, id });
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

/** 测试辅助：清空栈 */
export function clearStackForTest(): void {
  stack = [];
}
