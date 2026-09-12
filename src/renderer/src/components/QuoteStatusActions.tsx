/**
 * 报价状态徽标 + 流转按钮组（v2.4.9 S3b）：列表页与详情页共用。
 * 状态机矩阵（与 core quotes.ts STATUS_TRANSITIONS 一致）：
 *   草稿 → 已确认；已确认 → 修订中；修订中 → 草稿 / 已确认；已确认 → 草稿 拒绝。
 * 已确认状态下「转草稿」按钮渲染为 disabled（e2e 断言该按钮禁用；core 层同样拒绝该跳转）。
 * 状态判定一律以 status 字段为准（confirmed_at 在修订中仍保留，勿读它判定——Task 7 Minor 3）。
 */
import { Show, createSignal } from "solid-js";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import type { QuoteRecord } from "~/types";

type QuoteStatus = QuoteRecord["status"];

export function statusChipClass(s: QuoteStatus): string {
  switch (s) {
    case "草稿":
      return "bg-warning-50 text-warning-700";
    case "已确认":
      return "bg-success-50 text-success-700";
    case "修订中":
      return "bg-info-50 text-info-700";
  }
}

export default function QuoteStatusActions(props: {
  quotationNo: string;
  status: QuoteStatus;
  /** 流转成功后的回调（刷新列表/详情） */
  onChanged: () => void;
}) {
  // v2.5.3（P2-10）：流转请求在途——按钮 disabled + 入口守卫，防连点重复提交
  const [saving, setSaving] = createSignal(false);

  const go = async (to: QuoteStatus) => {
    if (saving()) return;
    setSaving(true);
    try {
      const r = await api.quotes.setStatus(props.quotationNo, to);
      if (r.success) {
        showToast("success", `报价 ${props.quotationNo} 已流转为「${to}」`);
        props.onChanged();
      } else {
        showToast("error", "状态更新失败", r.error || "未知错误");
      }
    } finally {
      setSaving(false);
    }
  };

  // v2.5.8 D14（样式统一收口）：`.btn-*` 档名一律写在**调用点的 class 字面量**里，只有与语义无关的
  // 尺寸/禁用档留在这个串里。原因：门禁（`uiInventory.test.ts`）与清点器都是按标签体扫 class 原文，
  // 类名一旦藏进变量拼接就看不见——改前本文件 5 处就是这样被全部记成「无过渡」的（`transition-colors`
  // 当时住在这个 const 里，调用点读不到）。
  // ⚠ 本串禁止再挂 transition 工具类（如 transition-colors）：它是工具类，会盖掉 `.btn-*` 组件档里的
  // `transition-[background-color,transform]`，把 W4/D8 刚对齐的按压缩放节奏打死。
  const btnSize =
    "text-xs px-2 py-0.5 rounded-md shrink-0 disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
      <span class={`chip shrink-0 ${statusChipClass(props.status)}`}>
        {props.status}
      </span>
      <Show when={props.status === "草稿"}>
        <button class={`btn-secondary ${btnSize} bg-primary-50 text-primary-700 hover:bg-primary-100`} disabled={saving()} onClick={() => void go("已确认")}>
          确认
        </button>
      </Show>
      <Show when={props.status === "已确认"}>
        <button class={`btn-secondary ${btnSize} text-surface-600 hover:bg-primary-50 hover:text-primary-700`} disabled={saving()} onClick={() => void go("修订中")}>
          转修订中
        </button>
        <button class={`btn-secondary ${btnSize} text-surface-400`} disabled title="已确认后须先转修订中，不能直接转回草稿">
          转草稿
        </button>
      </Show>
      <Show when={props.status === "修订中"}>
        <button class={`btn-secondary ${btnSize} text-surface-600 hover:bg-warning-50 hover:text-warning-700`} disabled={saving()} onClick={() => void go("草稿")}>
          转草稿
        </button>
        <button class={`btn-secondary ${btnSize} bg-primary-50 text-primary-700 hover:bg-primary-100`} disabled={saving()} onClick={() => void go("已确认")}>
          确认
        </button>
      </Show>
    </div>
  );
}
