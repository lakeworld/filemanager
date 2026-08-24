/**
 * 金额/数量输入过滤与失焦格式化（v2.5.5 B2，PLAN §三）。
 *
 * 纯 TS 零依赖（不 import Solid/DOM/electron），tests/unit 可 node 直测。
 *
 * filterMoneyInput —— 输入中逐字符过滤：
 *   只留数字与小数点；仅允许一个小数点（多余的删除）；负号仅允许前导；
 *   其余字符丢弃。不打断输入（组件 onInput 每键只调本函数回填）。
 *
 * formatMoneyBlur —— 失焦格式化：
 *   空 / 非法（Number 不可有限解析）→ ''；0 保留（含 '-0' 归 '0.00'）；负数允许（- 前缀）；
 *   超长小数截两位（字符串级截断、不四舍五入，规避 0.29*100 类浮点误差）；
 *   数字格式化为两位小数（1.2 → 1.20）。
 *
 * 组合语义：'abc1.2.3' 由 filter('abc1.2.3')='1.23' → format('1.23')='1.23' 达成。
 * 保存仍走各表单既有 Number() + core 校验（本模块零校验、零值域强制）。
 */

/** 输入中过滤非法字符：只留数字/小数点/前导负号；仅一个小数点；多余小数点删除。 */
export function filterMoneyInput(raw: string): string {
  let out = "";
  let hasDot = false;
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") {
      out += ch;
    } else if (ch === ".") {
      if (!hasDot) {
        out += ch;
        hasDot = true;
      }
    } else if (ch === "-") {
      // 负号仅允许前导（首个有效字符），其余位置丢弃
      if (out === "") out += ch;
    }
    // 其余字符丢弃
  }
  return out;
}

/** 失焦格式化：两位小数 + 超长小数截两位；空/非法 → ''；0 保留；负数允许。 */
export function formatMoneyBlur(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const n = Number(s);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "0.00";
  // 非常规数值形式（指数/进制等，组件输入不会产生）：退化 Number 标准两位小数
  if (!/^-?\d*\.?\d*$/.test(s)) return n.toFixed(2);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ""] = body.split(".");
  const intNorm = intPart === "" ? "0" : intPart.replace(/^0+(?=\d)/, "") || "0";
  const frac2 = (fracPart + "00").slice(0, 2);
  return `${neg ? "-" : ""}${intNorm}.${frac2}`;
}
