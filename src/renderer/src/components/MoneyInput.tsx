/**
 * 金额/数量输入（v2.5.5 B2，PLAN §三）：
 * type=text + inputMode=decimal——输入中只过滤非法字符（filterMoneyInput，不打断输入），
 * 失焦才格式化为两位小数（formatMoneyBlur 回填）。
 * min/max 仅作提示属性（type=text 下 min/max 被浏览器完全忽略、不生效也不硬挡——纯文档说明）；
 * 保存仍走各表单既有 Number() + core 校验（本组件零校验、零值域强制，行为不变）。
 *
 * 失焦回写纪律：纯表示层格式化（2 → 2.00）不回写信号，避免脏守卫（B1-B）误报「放弃未保存内容？」；
 *              语义变化（超长小数截两位 / 非法清空）才 onChange——保存值 = 用户所见值。
 */
import { filterMoneyInput, formatMoneyBlur } from "~/lib/moneyInput";

interface MoneyInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** v2.5.7（D2 表单控件统一）注释修正：type=text 下 min/max 被浏览器完全忽略（非惰性，是不生效）——仅供调用方文档化意图 */
  min?: number;
  max?: number;
  class?: string;
}

export default function MoneyInput(props: MoneyInputProps) {
  return (
    <input
      type="text"
      inputMode="decimal"
      class={props.class ?? "input"}
      placeholder={props.placeholder}
      disabled={props.disabled}
      min={props.min}
      max={props.max}
      value={props.value}
      onInput={(e) => {
        const v = filterMoneyInput(e.currentTarget.value);
        if (v !== e.currentTarget.value) e.currentTarget.value = v;
        props.onChange(v);
      }}
      onBlur={(e) => {
        const raw = e.currentTarget.value;
        const formatted = formatMoneyBlur(raw);
        if (formatted === raw) return;
        e.currentTarget.value = formatted;
        // 仅语义变化才回写信号（截两位/非法清空）；纯格式（2→2.00）不回写，防脏守卫误报
        const changed =
          formatted === "" || raw === "" ? formatted !== raw : !Object.is(Number(raw), Number(formatted));
        if (changed) props.onChange(formatted);
      }}
    />
  );
}
