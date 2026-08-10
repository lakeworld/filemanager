import { Show, For, createResource, createSignal, createEffect } from "solid-js";
import { A } from "@solidjs/router";
import { api } from "~/wails/api";
import { openPreview } from "~/stores/preview";
import EmptyState from "~/components/EmptyState";
import type { ApiResult, DashboardStats, FileEntry } from "~/types";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function Dashboard() {
  const [stats] = createResource(() => api.dashboard.stats() as Promise<{ success: boolean; data: DashboardStats | null; error: string }>);
  const [expiringCerts, setExpiringCerts] = createSignal<[string, string, string][]>([]);

  createEffect(() => {
    api.dashboard.expiringCerts().then((result: ApiResult<[string, string, string][]>) => {
      if (result.success && result.data) {
        setExpiringCerts(result.data);
      }
    });
  });

  const statCards = [
    { label: "产品集", value: () => stats()?.data?.total_product_sets ?? 0, icon: "📦", color: "bg-blue-50 text-blue-700", href: "/product-sets" },
    { label: "图片", value: () => stats()?.data?.total_images ?? 0, icon: "🖼️", color: "bg-purple-50 text-purple-700", href: "/images" },
    { label: "证书", value: () => stats()?.data?.total_certs ?? 0, icon: "📜", color: "bg-orange-50 text-orange-700", href: "/certs" },
  ];

  return (
    <div class="p-6 max-w-7xl mx-auto">
      <div class="mb-8">
        <h1 class="text-2xl font-bold text-surface-900">仪表盘</h1>
        <p class="text-surface-500 mt-1">概览您的工作区状态</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <For each={statCards}>
          {(card) => (
            <A href={card.href} class="block h-full" title={`查看全部${card.label}`}>
              <div class="card p-5 h-full transition-shadow hover:shadow-card-hover">
                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-sm text-surface-500 mb-1">{card.label}</div>
                    <div class="text-3xl font-bold text-surface-900">{card.value()}</div>
                  </div>
                  <div class={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl ${card.color}`}>
                    {card.icon}
                  </div>
                </div>
              </div>
            </A>
          )}
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
                    class="flex items-center gap-3 p-3 rounded-lg bg-orange-50 hover:bg-orange-100 transition-colors"
                    title={`在证书库查看「${productSet}」的证书`}
                  >
                    <div class="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center text-lg">⚠️</div>
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
      </div>
    </div>
  );
}
