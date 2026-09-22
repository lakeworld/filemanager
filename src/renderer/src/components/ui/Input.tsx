import type { JSX } from "solid-js";

/**
 * 输入框底座（v2.5.1 T2）：走 input 组件类；error 加 danger 边框。
 * Solid 纪律（D11）：禁解构 props。
 *
 * v2.5.8 D9（W4 控件统一 II）：把页面侧最后一批手写输入串收进来，因此补齐调用点**实际在用**
 * 的原生属性面（度量口径见 `内部四批合并审查记录`：不猜需求，按调用点清单加）。
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
  /**
   * v2.5.8 D14（样式统一收口）：**行内编辑档**——`h-auto px-2 py-1 rounded`（高度随内容，≈26px），
   * 给「点文字变成输入框」这种嵌在行里的紧凑框用（`.input` 是 h-9 的表单单档，硬套会把行撑高）。
   * 为什么做进底座而不是让 7 个调用点各写一串几何：那正是本卡要清的账——材质住一处，调用点只给排布。
   * 为什么不是复用 `.input-compact`：它是 `px-2 py-2`（≈38px）外加 `w-28`，与行内框不是一档几何
   * （2026-09-12 实测；PLAN §二 那句"`.input-compact` 应能直接承接"是错判，已在 PLAN 更正）。
   */
  compact?: boolean;
  /**
   * 挂载即聚焦。原生 `autofocus` **不会**穿过组件边界——底座不显式声明并透传，调用点写了就是静默失效
   * （D9 那批 `aria-label` 被吞是同族坑，仓里有专钉连字符属性的门禁）。`Settings.tsx:370` 的重命名框依赖它。
   */
  autoFocus?: boolean;
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
      autofocus={props.autoFocus}
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
      /**
       * 拼接顺序 = 底座档 → 状态档 → 调用方排布类。编辑态描边一类的**语义色**留给调用点走 `class`
       * （如 `Settings.tsx:370` 的 `border-primary-300`）：底座只管材质与几何，颜色随语义变。
       */
      class={`input ${props.compact ? "h-auto px-2 py-1 rounded" : ""} ${props.error ? "border-danger-400 focus:border-danger-500 focus:ring-danger-500/30" : ""} ${props.class ?? ""}`}
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
