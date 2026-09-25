import { For } from "solid-js";
import { useNavigate } from "@solidjs/router";

/**
 * 台账入口卡（v2.6.1 B17 · PLAN §三 落点）：三行入口（发票 / 报价 / 计算），行式 `link-btn` + 一行说明。
 *
 * 2026-09-25 拍板：放「通用」页签底部，**不新开第五页签**——这三页的主入口仍是侧栏，这里只做
 * "设置页顺手给一条路"（用户在看工作区配置时想起来的台账，不该逼他先回侧栏）。
 * 路由字符串与侧栏同源（`/invoices` / `/quotes` / `/calc`）。
 */
const LEDGERS: { path: string; label: string; desc: string }[] = [
  { path: "/invoices", label: "发票台账", desc: "进项 / 销项发票与待办日期" },
  { path: "/quotes", label: "报价台账", desc: "报价单、明细与确认状态" },
  { path: "/calc", label: "计算台账", desc: "按容器分本的计算记录" },
];

export default function LedgerLinksCard() {
  const navigate = useNavigate();
  return (
    <div class="card card-glass p-6">
      <h2 class="text-lg font-semibold mb-2">台账入口</h2>
      <p class="text-sm text-surface-500 mb-4">三类台账的快捷入口（侧栏里同样能找到）。</p>
      <div class="flex flex-col divide-y divide-surface-100">
        <For each={LEDGERS}>
          {(l) => (
            <button
              class="link-btn w-full justify-between gap-4 py-2 text-sm text-surface-700 hover:text-primary-600"
              onClick={() => navigate(l.path)}
            >
              <span class="font-medium">{l.label}</span>
              <span class="text-xs text-surface-400">{l.desc}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}