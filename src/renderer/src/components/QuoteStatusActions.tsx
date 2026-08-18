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

  const btnBase =
    "text-xs px-2 py-0.5 rounded-md transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
      <span class={`text-xs px-2 py-0.5 rounded-full shrink-0 ${statusChipClass(props.status)}`}>
        {props.status}
      </span>
      <Show when={props.status === "草稿"}>
        <button class={`${btnBase} bg-primary-50 text-primary-700 hover:bg-primary-100`} disabled={saving()} onClick={() => void go("已确认")}>
          确认
        </button>
      </Show>
      <Show when={props.status === "已确认"}>
        <button class={`${btnBase} bg-surface-100 text-surface-600 hover:bg-primary-50 hover:text-primary-700`} disabled={saving()} onClick={() => void go("修订中")}>
          转修订中
        </button>
        <button class={`${btnBase} bg-surface-100 text-surface-400`} disabled title="已确认后须先转修订中，不能直接转回草稿">
          转草稿
        </button>
      </Show>
      <Show when={props.status === "修订中"}>
        <button class={`${btnBase} bg-surface-100 text-surface-600 hover:bg-warning-50 hover:text-warning-700`} disabled={saving()} onClick={() => void go("草稿")}>
          转草稿
        </button>
        <button class={`${btnBase} bg-primary-50 text-primary-700 hover:bg-primary-100`} disabled={saving()} onClick={() => void go("已确认")}>
          确认
        </button>
      </Show>
    </div>
  );
}
