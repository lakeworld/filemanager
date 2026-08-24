import { Show, onMount, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { pushLayer, isTop } from "./layerStack";

/**
 * Modal 底座（v2.5.1 T2，D2 完整契约）：
 * - role="dialog" + aria-modal="true" + aria-label（=title，D6）
 * - Esc 与 overlay 点击仅栈顶响应（layerStack）；lockOpen 时两者均不触发 onClose
 * - 打开时焦点入 panel 首个可聚焦元素，Tab/Shift-Tab 循环困于栈顶 panel，关闭后焦点还原触发源
 * - 进入过渡 opacity + scale-95→100 150ms（transform/opacity only，D13）
 * - open=false 时 UNMOUNT 不渲染（对齐现状 Show 语义）
 * 业务态守卫（如 MoveDialog 闲时可关、BatchTagDialog 关闭带副作用）由调用方在 onClose 内实现。
 * v2.5.5（P0）：脏守卫底座——可选 dirty/onCloseRequest：dirty 时遮罩/Esc 改调 onCloseRequest
 * （调用方弹「放弃未保存内容？」二次确认），非 dirty 直接 onClose；lockOpen 恒真优先。
 * Solid 纪律（D11）：禁解构 props，一律 props.x 访问。
 */

const SIZE_MAP: Record<string, string> = {
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  size?: "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
  /** default = bg-black/50；dark = bg-black/70（FilePreviewModal 预览变体） */
  tone?: "default" | "dark";
  /** 进行中禁关（ArchiveProgressDialog）：Esc/overlay 均不触发 onClose */
  lockOpen?: boolean;
  /**
   * v2.5.5（P0，B1 任务 B）：脏守卫——dirty 为真且提供了 onCloseRequest 时，
   * 遮罩/Esc 改调 onCloseRequest（调用方实现「放弃未保存内容？」二次确认）而非直接 onClose；
   * dirty 为假或无 onCloseRequest → 行为不变（直接 onClose）。lockOpen 恒真优先。
   */
  dirty?: boolean;
  onCloseRequest?: () => void;
  title?: string;
  children: JSX.Element;
}

/** 内部实现组件：Show 挂载时才注册层栈/焦点（open=false 时整体不渲染） */
function ModalInner(props: ModalProps) {
  let panelRef: HTMLDivElement | undefined;
  let lastFocused: Element | null = null;
  let myId = 0;
  let removeLayer: (() => void) | undefined;

  const canClose = () => !props.lockOpen;

  /** 统一关闭入口：lockOpen 恒真优先；dirty 且有 onCloseRequest → 走守卫；否则直接 onClose */
  const requestClose = () => {
    if (!canClose()) return;
    if (props.dirty && props.onCloseRequest) props.onCloseRequest();
    else props.onClose();
  };

  const handleEscape = () => {
    requestClose();
  };

  const focusFirst = () => {
    if (!panelRef) return;
    const el = panelRef.querySelector<HTMLElement>(FOCUSABLE);
    el?.focus();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    // 仅栈顶 Modal 参与焦点困守（D2）
    if (!isTop(myId)) return;
    if (e.key !== "Tab") return;
    if (!panelRef) return;
    const focusables = Array.from(panelRef.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panelRef.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panelRef.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  onMount(() => {
    lastFocused = document.activeElement;
    const layer = pushLayer({ onEscape: handleEscape });
    myId = layer.id;
    removeLayer = layer.remove;
    focusFirst();
    window.addEventListener("keydown", handleKeydown);
  });

  onCleanup(() => {
    removeLayer?.();
    window.removeEventListener("keydown", handleKeydown);
    // 焦点还原触发源
    if (lastFocused instanceof HTMLElement) lastFocused.focus();
  });

  return (
    <div
      class={props.tone === "dark" ? "modal-overlay-dark" : "modal-overlay"}
      onClick={() => {
        requestClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        class={`modal-panel w-full ${SIZE_MAP[props.size ?? "md"]} transition-[opacity,transform] duration-fast scale-95 opacity-0 animate-[modalIn_150ms_ease-out_forwards]`}
        onClick={(e) => e.stopPropagation()}
      >
        {props.children}
      </div>
    </div>
  );
}

export default function Modal(props: ModalProps) {
  return <Show when={props.open}>{<ModalInner {...props} />}</Show>;
}
