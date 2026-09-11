import type { JSX } from "solid-js";

/**
 * 输入框底座（v2.5.1 T2）：走 input 组件类；error 加 danger 边框。
 * Solid 纪律（D11）：禁解构 props。
 *
 * v2.5.8 D9（W4 控件统一 II）：把页面侧最后一批手写输入串收进来，因此补齐调用点**实际在用**
 * 的原生属性面（度量口径见 `审查-2026-09-12-D9-D12-四批合一-r1.md`：不猜需求，按调用点清单加）。
 * 加的都是纯透传，不含逻辑；**不要**在这里发明新档位——小尺寸内联编辑器等异形几何按 §五.2
 * 走各自的显式 props（如 `compact`），不合规的写法由 `uiInventory` 门禁拦。
 */

interface InputProps {
  value?: string;
  placeholder?: string;
  type?: string;
  error?: boolean;
  disabled?: boolean;
  /** 排布类（宽度 / flex / min-w）继续由调用方给，底座只管材质 */
  class?: string;
  /** 关联 <label for> 或 e2e 定位用 */
  id?: string;
  /** 表单语义名（部分调用点靠它做 DOM 查询） */
  name?: string;
  /** 无可见 label 时的可访问名（T4 规范：aria-label / aria-labelledby / label 三者必居其一） */
  ariaLabel?: string;
  /** 只读展示态（如报价单号生成后不可改） */
  readonly?: boolean;
  maxLength?: number;
  /** 数值输入的上下界（批量重命名「起始序号」用 `min={0}`）；不给则不设，行为同原生 */
  min?: number;
  max?: number;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "decimal" | "tel" | "search" | "email" | "url";
  enterKeyHint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send";
  /** 悬停说明（只放"为什么只读/规则是什么"这类信息，不做装饰） */
  title?: string;
  /** 极少数调用点要动态尺寸（如弹窗内联编辑的宽度跟随内容） */
  style?: JSX.CSSProperties;
  onInput?: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
  onChange?: (e: Event & { currentTarget: HTMLInputElement }) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onKeyUp?: (e: KeyboardEvent) => void;
  onPaste?: (e: ClipboardEvent & { currentTarget: HTMLInputElement }) => void;
  onFocus?: (e: FocusEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  onCompositionStart?: (e: CompositionEvent) => void;
  onCompositionEnd?: (e: CompositionEvent) => void;
}

export default function Input(props: InputProps) {
  return (
    <input
      type={props.type ?? "text"}
      value={props.value ?? ""}
      placeholder={props.placeholder}
      disabled={props.disabled}
      readonly={props.readonly}
      id={props.id}
      name={props.name}
      aria-label={props.ariaLabel}
      maxlength={props.maxLength}
      min={props.min}
      max={props.max}
      autocomplete={props.autoComplete}
      inputmode={props.inputMode}
      enterkeyhint={props.enterKeyHint}
      title={props.title}
      style={props.style}
      class={`input ${props.error ? "border-danger-400 focus:border-danger-500 focus:ring-danger-500/30" : ""} ${props.class ?? ""}`}
      onInput={props.onInput}
      onChange={props.onChange}
      onKeyDown={props.onKeyDown}
      onKeyUp={props.onKeyUp}
      onPaste={props.onPaste}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onCompositionStart={props.onCompositionStart}
      onCompositionEnd={props.onCompositionEnd}
    />
  );
}
