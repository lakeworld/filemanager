/**
 * 层栈（v2.5.1 T2，D2）：Modal 与 Portal 弹出层（DatePicker/TagInput/ContextMenu）共用的模块级栈。
 * - 全局单 keydown 监听，Esc 只派栈顶
 * - 焦点困守只对栈顶 Modal 生效（非栈顶 Modal 不抢焦点）
 * - 消费顺序：弹出层 > 弹窗 > 页面（先入栈的层级更低）
 * 用法：pushLayer({ onEscape }) 返回移除函数（组件 onCleanup 调用）。
 */

interface Layer {
  id: number;
  onEscape?: () => void;
}

let stack: Layer[] = [];
let nextId = 1;

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
