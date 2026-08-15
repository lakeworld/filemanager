import { Show, For, createResource, createSignal, createEffect } from "solid-js";
import { A } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { openPreview } from "~/stores/preview";
import EmptyState from "~/components/EmptyState";
import type { ApiResult, DashboardStats, FileEntry, InvoiceRecord } from "~/types";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function Dashboard() {
  // v2.4.7 修复：统计卡随工作区切换刷新——resource 源键 = 当前工作区路径，切区即重新拉取
  const [stats] = createResource(
    () => currentWorkspace()?.path,
    () => api.dashboard.stats() as Promise<{ success: boolean; data: DashboardStats | null; error: string }>
  );
  const [expiringCerts, setExpiringCerts] = createSignal<[string, string, string][]>([]);
  // v2.4.7：发票待办（§4.3）——30 天内 due_date 且状态 ≠ 已入账，due_date 升序
  const [invoiceTodos, setInvoiceTodos] = createSignal<InvoiceRecord[]>([]);

  // v2.4.7 修复：到期提醒/发票待办 effect 显式依赖 currentWorkspace()（对齐 Clients/Invoices 范式），
  // 无工作区时不请求；切换工作区时 effect 重跑，数据随新工作区刷新
  createEffect(() => {
    if (!currentWorkspace()) return;
    api.dashboard.expiringCerts().then((result: ApiResult<[string, string, string][]>) => {
      if (result.success && result.data) {
        setExpiringCerts(result.data);
      }
    });
    // v2.4.7：发票待办（wails/api.ts 门面由 IPC 层并行补充，见任务报告交接点）
    api.dashboard.invoiceTodos().then((result: ApiResult<InvoiceRecord[]>) => {
      if (result.success && result.data) {
        setInvoiceTodos(result.data);
      }
    });
  });

  /** 统计卡元组（v2.4.9 打磨 M5：href 可选——报价卡外层 div 规避 A 嵌套 A；subText/subHref 可选——草稿数副链接） */
  interface StatCard {
    label: string;
    value: () => number;
    icon: string;
    color: string;
    href?: string;
    subText?: () => string;
    subHref?: string;
  }
  const statCards: StatCard[] = [
    { label: "产品集", value: () => stats()?.data?.total_product_sets ?? 0, icon: "📦", color: "bg-info-50 text-info-700", href: "/product-sets" },
    { label: "图片", value: () => stats()?.data?.total_images ?? 0, icon: "🖼️", color: "bg-purple-50 text-purple-700", href: "/images" },
    { label: "证书", value: () => stats()?.data?.total_certs ?? 0, icon: "📜", color: "bg-cert-50 text-cert-700", href: "/certs" },
    // v2.4.7（§4.3）：客户数统计卡
    { label: "客户", value: () => stats()?.data?.total_customers ?? 0, icon: "🤝", color: "bg-success-50 text-success-700", href: "/clients" },
    // v2.4.9 打磨 M5：供应商/报价统计卡（目录扫描口径，同 total_customers）
    { label: "供应商", value: () => stats()?.data?.total_suppliers ?? 0, icon: "🏭", color: "bg-cyan-50 text-cyan-700", href: "/suppliers" },
    // 报价卡：总报价数 + subText「草稿 N 条」副链接（外层无 href → div，subText 独立 A 导航，规避嵌套锚点）
    {
      label: "报价",
      value: () => stats()?.data?.total_quotes ?? 0,
      icon: "📄",
      color: "bg-warning-50 text-warning-700",
      subText: () => `草稿 ${stats()?.data?.draft_quotes ?? 0} 条`,
      subHref: `/quotes?status=${encodeURIComponent("草稿")}`,
    },
  ];

  return (
    <div class="p-6 max-w-7xl mx-auto">
      <div class="mb-8">
        <h1 class="text-2xl font-bold text-surface-900">仪表盘</h1>
        <p class="text-surface-500 mt-1">概览您的工作区状态</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <For each={statCards}>
          {(card) => {
            // v2.4.9 打磨 M5：报价卡无 href（subText 内嵌链接）→ 外层用 div，避免 A 嵌套 A
            // （HTML 解析器会提前闭合外层 A，副链接无法独立导航）；其余卡片保持整卡 A 跳转
            const inner = (
              <div class="card p-5 h-full transition-shadow hover:shadow-card-hover">
                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-sm text-surface-500 mb-1">{card.label}</div>
                    <div class="text-3xl font-bold text-surface-900">{card.value()}</div>
                    <Show when={card.subText}>
                      <div class="mt-1.5">
                        <Show
                          when={card.subHref}
                          fallback={<span class="text-xs text-surface-400">{card.subText!()}</span>}
                        >
                          {/* 副链接：独立 A 导航（M4 ?status= 预选契约）；阻止冒泡避免触发整卡跳转 */}
                          <A
                            href={card.subHref!}
                            class="text-xs text-primary-600 hover:text-primary-700"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {card.subText!()}
                          </A>
                        </Show>
                      </div>
                    </Show>
                  </div>
                  <div class={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl ${card.color}`}>
                    {card.icon}
                  </div>
                </div>
              </div>
            );
            return (
              <Show when={card.href} fallback={<div class="block h-full">{inner}</div>}>
                <A href={card.href!} class="block h-full" title={`查看全部${card.label}`}>
                  {inner}
                </A>
              </Show>
            );
          }}
        </For>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="card p-5">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold">最近文件</h2>
            <A href="/images" class="text-sm text-primary-600 hover:text-primary-700">查看全部</A>
          </div>
          <Show when={stats()?.data?.recent_files.length} fallback={<EmptyState title="暂无文件" />}>
            <div class="space-y-2">
              <For each={stats()?.data?.recent_files ?? []}>
                {(file) => (
                  <div
                    class="flex items-center gap-3 p-3 rounded-lg hover:bg-surface-50 transition-colors cursor-pointer"
                    onClick={() => void openPreview(file)}
                    title={`点击预览：${file.path}`}
                  >
                    <div class="w-10 h-10 rounded-lg bg-surface-100 flex items-center justify-center text-lg">
                      {file.file_type === "image" ? "🖼️" : file.file_type === "pdf" ? "📄" : "📎"}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium truncate">{file.name}</div>
                      <div class="text-xs text-surface-400">{file.modified}</div>
                    </div>
                    <div class="text-xs text-surface-400">{formatBytes(file.size)}</div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="card p-5">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold">到期提醒</h2>
            <span class="text-sm text-surface-400">30 天内到期</span>
          </div>
          <Show when={expiringCerts().length > 0} fallback={<EmptyState title="暂无到期证书" />}>
            <div class="space-y-2 max-h-80 overflow-y-auto">
              <For each={expiringCerts()}>
                {([productSet, fileName, expiry]) => (
                  <A
                    href={`/certs?productSet=${encodeURIComponent(productSet)}`}
                    class="flex items-center gap-3 p-3 rounded-lg bg-cert-50 hover:bg-cert-100 transition-colors"
                    title={`在证书库查看「${productSet}」的证书`}
                  >
                    <div class="w-10 h-10 rounded-lg bg-cert-100 flex items-center justify-center text-lg">⚠️</div>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium truncate">{fileName}</div>
                      <div class="text-xs text-surface-500">{productSet} · 到期日 {expiry}</div>
                    </div>
                  </A>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* v2.4.7（§4.3）：发票待办——30 天内 due_date 且状态 ≠ 已入账；点击跳 /invoices 带待办筛选 */}
        <div class="card p-5">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold">发票待办</h2>
            <span class="text-sm text-surface-400">30 天内待办日期</span>
          </div>
          <Show when={invoiceTodos().length > 0} fallback={<EmptyState title="暂无发票待办" />}>
            <div class="space-y-2 max-h-80 overflow-y-auto">
              <For each={invoiceTodos()}>
                {(inv) => (
                  <A
                    href="/invoices?dueSoon=1"
                    class="flex items-center gap-3 p-3 rounded-lg bg-warning-50 hover:bg-warning-100 transition-colors"
                    title={`在发票台账查看「${inv.number}」`}
                  >
                    <div class="w-10 h-10 rounded-lg bg-warning-100 flex items-center justify-center text-lg">🧾</div>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium truncate">{inv.number} · {inv.seller}</div>
                      <div class="text-xs text-surface-500">
                        {inv.customer ? `${inv.customer} · ` : ""}待办 {inv.due_date} · ¥{inv.amount}
                      </div>
                    </div>
                  </A>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
