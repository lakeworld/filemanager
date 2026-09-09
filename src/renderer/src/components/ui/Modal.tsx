import { Show, onMount, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { pushLayer, isTop } from "./layerStack";

/**
 * Modal 底座（v2.5.1 T2，D2 完整契约）：
 * - role="dialog" + aria-modal="true" + aria-label（=title，D6）
 * - Esc 与 overlay 点击仅栈顶响应（layerStack）；lockOpen 时两者均不触发 onClose
 * - 打开时焦点入 panel 首个可聚焦元素，Tab/Shift-Tab 循环困于栈顶 panel，关闭后焦点还原触发源
 * - 进入过渡 opacity + scale-95→100 150ms（transform/opacity only，D13；v2.5.8 D7 起曲线 = outExpo，
 *   预态与动画一起住在 index.css 的 .modal-panel 里，prefers-reduced-motion 单点可关）
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
  /**
   * v2.5.8 弹窗专项：framed = 统一骨架（头部标题/副标题/关闭钮 + 固定页脚动作区，仅字段区滚动）。
   * 默认 false = 渲染与迁移前逐字一致（19 个既有调用点零改动）。
   * 开 framed 时 title 会**显示**出来（此前只进 aria-label），调用方须删掉自己手写的 `<h2>` 标题，
   * 并把底部按钮放进 `footer`。
   */
  framed?: boolean;
  /** framed 头部副标题（一句话说明这个弹窗在干什么/影响范围） */
  subtitle?: JSX.Element;
  /** framed 页脚内容（通常是一组动作按钮），固定在面板底部 */
  footer?: JSX.Element;
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
    // framed 形态头部有「关闭」钮，但它不是用户的输入目标——带 data-no-auto-focus 的元素跳过，
    // 焦点照旧落在首个字段（保持与迁移前一致的行为，e2e 打字/回车类用例零改动）
    const el = Array.from(panelRef.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
      (n) => !n.hasAttribute("data-no-auto-focus"),
    );
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
        class={`modal-panel w-full ${SIZE_MAP[props.size ?? "md"]} ${
          props.framed ? "modal-panel-framed" : ""
        } transition-[opacity,transform] duration-fast`}
        onClick={(e) => e.stopPropagation()}
      >
        {props.framed ? (
          <>
            <div class="dlg-header">
              <div class="min-w-0">
                <div class="dlg-title">{props.title}</div>
                <Show when={props.subtitle}>
                  <div class="dlg-sub">{props.subtitle}</div>
                </Show>
              </div>
              {/* data-no-auto-focus：打开时焦点落首个字段而不是关闭钮；Tab 循环仍可走到 */}
              <button
                type="button"
                class="dlg-close"
                aria-label="关闭"
                data-no-auto-focus=""
                onClick={requestClose}
              >
                ✕
              </button>
            </div>
            <div class="dlg-body">{props.children}</div>
            <Show when={props.footer}>
              <div class="dlg-footer">{props.footer}</div>
            </Show>
          </>
        ) : (
          props.children
        )}
      </div>
    </div>
  );
}

export default function Modal(props: ModalProps) {
  return <Show when={props.open}>{<ModalInner {...props} />}</Show>;
}
