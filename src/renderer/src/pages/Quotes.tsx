/**
 * 报价列表页（v2.4.9 S3b，PLAN §3.4）：台账表 + 新建 + 行内状态流转 + 删除。
 * 台账（报价.json）：列 = 单号/日期/客户/状态徽标/金额（两位小数展示）；行点击进 /quotes/:no 详情。
 * 状态流转按钮组（草稿→已确认/已确认→修订中/修订中→草稿|已确认；已确认→草稿 按钮 disabled——
 *   core 矩阵一致，状态判定用 status 不用 confirmed_at——Task 7 Minor 3）。
 * 删除：ConfirmDialog「删除报价记录（归档文件保留）」——账物分离，删除不删文件。
 * 客户删除 → 记录保留字面值灰显（S2b 供应商已删除灰显先例：text-surface-300 + title 说明）。
 * 归档文件缺失：记录保留、整行 opacity 灰显（账物分离；缺失由 workspaceUrl 探活批量检测，并发 ≤8 仿发票）。
 * 筛选（v2.4.9 打磨 M4，PLAN §3.4）：状态/客户/日期范围页内过滤；?status= URL 预选（单向不回写，
 *   非法值回退「全部」）；筛选变化 scrollResetKey 滚动归零。
 */
import { Show, For, createSignal, createEffect } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { customers, loadCustomers } from "~/stores/clients";
import { showToast } from "~/stores/notifyBanner";
import { openPreview } from "~/stores/preview";
import VirtualGrid from "~/components/VirtualGrid";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import ConfirmDialog from "~/components/ConfirmDialog";
import QuoteStatusActions from "~/components/QuoteStatusActions";
import QuoteFormModal from "~/components/QuoteFormModal";
import type { QuoteRecord, CustomerInfo, FileEntry } from "~/types";

/** 台账列模板（与表头/行一致；minmax 保证窄窗口下可截断） */
const QUOTE_COL_TEMPLATE =
  "minmax(150px,1.2fr) minmax(95px,0.9fr) minmax(120px,1.1fr) minmax(220px,1.7fr) minmax(95px,0.8fr) minmax(80px,0.65fr)";

/** 报价状态枚举（对齐 core paths.ts QUOTE_STATUSES 口径；筛选下拉 + URL ?status= 预选校验共用） */
const QUOTE_STATUSES: QuoteRecord["status"][] = ["草稿", "已确认", "修订中"];

function fmtMoney(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-";
}

function baseNameOf(relPath: string): string {
  return relPath.split("/").pop() || relPath;
}

/** 归档文件相对路径 → FileEntry（供 openPreview；文件缺失时预览失败并提示） */
function fileEntryOf(relPath: string): FileEntry | null {
  const ws = currentWorkspace()?.path;
  if (!ws) return null;
  return {
    name: baseNameOf(relPath),
    path: `${ws.replace(/\\/g, "/")}/${relPath}`,
    size: 0,
    modified: "",
    file_type: relPath.toLowerCase().endsWith(".pdf") ? "pdf" : "image",
    thumbnail_path: null,
  };
}

export default function Quotes() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [quotes, setQuotes] = createSignal<QuoteRecord[]>([]);
  // v2.5.2：首载 loading——空态不闪现（照 FileBrowserView 先例）
  const [loading, setLoading] = createSignal(true);
  const [missingFiles, setMissingFiles] = createSignal<Record<string, boolean>>({});
  const [creating, setCreating] = createSignal(false);
  const [deleteTarget, setDeleteTarget] = createSignal<{ no: string } | null>(null);

  // —— 筛选信号（v2.4.9 M4：状态/客户/日期范围；"" = 全部/未限定）——
  const [statusFilter, setStatusFilter] = createSignal("");
  const [customerFilter, setCustomerFilter] = createSignal("");
  const [dateFrom, setDateFrom] = createSignal("");
  const [dateTo, setDateTo] = createSignal("");

  let seq = 0;

  /** 批量探活归档文件（并发 ≤8，仿发票）；存在性结果按 seq 守卫 */
  const checkFilesExistence = async (list: QuoteRecord[], s: number) => {
    const ws = currentWorkspace()?.path;
    if (!ws) return;
    const base = ws.replace(/\\/g, "/");
    const missing: Record<string, boolean> = {};
    const queue = list.map((r) => r.file_path).filter(Boolean);
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length > 0) {
        const rel = queue.shift()!;
        const res = await api.files.workspaceUrl(`${base}/${rel}`).catch(() => null);
        if (!res?.success) missing[rel] = true;
      }
    });
    await Promise.all(workers);
    if (s !== seq) return;
    setMissingFiles(missing);
  };

  const loadQuotes = async () => {
    const s = ++seq;
    setLoading(true);
    try {
      const result = await api.quotes.list();
      if (s !== seq) return;
      if (result.success && result.data) {
        setQuotes(result.data);
        void checkFilesExistence(result.data, s);
      }
    } finally {
      // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
      if (s === seq) setLoading(false);
    }
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadCustomers();
      loadQuotes();
    }
  });

  // 深链：?status=草稿 → 进入即开启状态筛选（M5 仪表盘「报价」卡跳转，PLAN §3.4 M4）
  // 单向：筛选变化不回写 URL；非法 status（非 草稿/已确认/修订中）回退「全部」（对齐 core assertStatus 口径）
  createEffect(() => {
    const q = searchParams.status;
    if (q && typeof q === "string") {
      setStatusFilter((QUOTE_STATUSES as readonly string[]).includes(q) ? q : "");
    }
  });

  // —— 页内过滤（状态/客户/日期范围；报价页无搜索框，不做关键词搜索；list() 全量返回，渲染层过滤同发票）——
  const filteredQuotes = () => {
    const s = statusFilter();
    const c = customerFilter();
    const df = dateFrom();
    const dt = dateTo();
    return quotes().filter((r) => {
      if (s && r.status !== s) return false;
      if (c && r.customer !== c) return false;
      // date 为 "YYYY-MM-DD" 字符串，字典序即时间序；区间比较含两端
      if (df && r.date < df) return false;
      if (dt && r.date > dt) return false;
      return true;
    });
  };

  const customerExists = (name?: string) => !!name && customers().some((c) => c.name === name);

  const previewFile = (rec: QuoteRecord) => {
    if (!rec.file_path) return;
    const entry = fileEntryOf(rec.file_path);
    if (entry) openPreview(entry, { onDelete: () => void loadQuotes() });
  };

  const confirmDelete = async () => {
    const t = deleteTarget();
    if (!t) return;
    const r = await api.quotes.delete(t.no);
    if (r.success) {
      setDeleteTarget(null);
      showToast("success", "报价记录已删除（归档文件保留）");
      void loadQuotes();
    } else {
      showToast("error", "删除失败", r.error || "未知错误");
    }
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">报价管理</h1>
          <p class="text-surface-500 mt-1">报价单台账与文件归档</p>
        </div>
        <button class="btn-primary text-sm" onClick={() => setCreating(true)}>
          <span>➕</span> 新建报价
        </button>
      </div>

      {/* 筛选区（v2.4.9 M4：状态/客户/日期范围；客户下拉只列现存 customers()，已删客户报价仅「全部」可见） */}
      <div class="flex flex-col md:flex-row gap-3 mb-4 shrink-0">
        <select
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          aria-label="状态筛选"
          value={statusFilter()}
          onChange={(e) => setStatusFilter(e.currentTarget.value)}
        >
          <option value="">全部状态</option>
          <For each={QUOTE_STATUSES}>
            {(s) => <option value={s}>{s}</option>}
          </For>
        </select>
        <select
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
          aria-label="客户筛选"
          value={customerFilter()}
          onChange={(e) => setCustomerFilter(e.currentTarget.value)}
        >
          <option value="">全部客户</option>
          <For each={customers()}>
            {(c) => <option value={c.name}>{c.name}</option>}
          </For>
        </select>
        <input
          type="date"
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm"
          aria-label="起始日期"
          value={dateFrom()}
          onInput={(e) => setDateFrom(e.currentTarget.value)}
        />
        <span class="text-surface-400 self-center text-sm shrink-0">至</span>
        <input
          type="date"
          class="px-3 py-2 border border-surface-200 rounded-lg text-sm"
          aria-label="结束日期"
          value={dateTo()}
          onInput={(e) => setDateTo(e.currentTarget.value)}
        />
      </div>

      <Show when={quotes().length === 0} fallback={
        <div class="flex-1 min-h-0 flex flex-col">
          <div class="card p-2 flex flex-col flex-1 min-h-0">
            <div class="flex items-center justify-between px-3 py-2 shrink-0">
              <span class="text-sm text-surface-500">共 {filteredQuotes().length} 条报价</span>
            </div>

            <Show when={filteredQuotes().length === 0} fallback={
              <>
                <div
                  class="px-3 py-2 text-xs text-surface-400 grid items-center gap-2 shrink-0"
                  style={{ "grid-template-columns": QUOTE_COL_TEMPLATE }}
                >
                  <span>单号</span>
                  <span>日期</span>
                  <span>客户</span>
                  <span>状态</span>
                  <span class="text-right">金额</span>
                  <span class="text-right">操作</span>
                </div>
                <div class="flex-1 min-h-0">
                  <VirtualGrid
                    items={filteredQuotes()}
                    itemHeight={48}
                    columns={1}
                    gap={8}
                    // v2.4.9 M4：筛选变化时滚动归零（VirtualGrid scrollResetKey 约定，对齐发票 Invoices.tsx）
                    scrollResetKey={`${statusFilter()}|${customerFilter()}|${dateFrom()}|${dateTo()}`}
                    renderItem={(rec) => (
                  <div
                    class={`px-3 py-2 rounded-lg grid items-center gap-2 text-sm transition-colors hover:bg-surface-50 ${missingFiles()[rec.file_path] ? "opacity-60" : ""}`}
                    style={{ "grid-template-columns": QUOTE_COL_TEMPLATE }}
                  >
                    <button
                      class="font-medium text-primary-700 hover:underline text-left truncate min-w-0"
                      title="查看报价详情"
                      onClick={() => navigate(`/quotes/${encodeURIComponent(rec.quotation_no)}`)}
                    >
                      {rec.quotation_no}
                    </button>
                    <span class="text-surface-500 truncate min-w-0">{rec.date}</span>
                    {/* 客户删除 → 字面值灰显（S2b 供应商已删除灰显先例）；存在 → chip 点击跳客户详情 */}
                    <Show when={rec.customer} fallback={<span class="text-surface-300">-</span>}>
                      {(name) => (
                        <Show
                          when={customerExists(name())}
                          fallback={
                            <span class="truncate min-w-0 text-surface-300" title="客户已删除，名称仅作记录保留">
                              {name()}
                            </span>
                          }
                        >
                          <button
                            class="text-xs px-2 py-0.5 rounded-full bg-surface-100 text-surface-700 hover:bg-primary-50 hover:text-primary-700 transition-colors w-fit"
                            title="前往客户详情"
                            onClick={() => navigate(`/clients/${encodeURIComponent(name())}`)}
                          >
                            {name()}
                          </button>
                        </Show>
                      )}
                    </Show>
                    <QuoteStatusActions quotationNo={rec.quotation_no} status={rec.status} onChanged={() => void loadQuotes()} />
                    <span class="text-right tabular-nums text-surface-900">{fmtMoney(rec.total_amount)}</span>
                    <div class="flex items-center justify-end gap-1.5 min-w-0">
                      <Show when={missingFiles()[rec.file_path]}>
                        <span class="text-xs text-danger-600 shrink-0" title="归档文件已缺失（不影响记录）">缺失</span>
                      </Show>
                      <Show when={rec.file_path}>
                        <button class="text-surface-400 hover:text-primary-600 text-sm shrink-0" title="预览归档文件" onClick={() => previewFile(rec)}>
                          👁
                        </button>
                      </Show>
                      <button class="text-surface-400 hover:text-danger-500 text-sm shrink-0" title="删除" onClick={() => setDeleteTarget({ no: rec.quotation_no })}>
                        🗑️
                      </button>
                    </div>
                  </div>
                )}
              />
                </div>
              </>
            }>
              <div class="flex-1 flex items-center justify-center">
                <EmptyState icon="📄" title="没有匹配的报价" desc="调整筛选条件试试" />
              </div>
            </Show>
          </div>
        </div>
      }>
        <div class="flex-1 flex items-center justify-center">
          {/* v2.5.2：首载 loading 兜底，空态不闪现 */}
          <Show when={!loading()} fallback={<Loading text="报价加载中…" />}>
            <EmptyState icon="📄" title="暂无报价" desc="点击「新建报价」登记第一张报价单">
              <button class="btn-primary" onClick={() => setCreating(true)}>新建报价</button>
            </EmptyState>
          </Show>
        </div>
      </Show>

      {/* 新建报价弹窗（明细行动态编辑 + 归档 + 单号留空自动生成） */}
      <Show when={creating()}>
        <QuoteFormModal
          mode="create"
          customers={customers() as CustomerInfo[]}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void loadQuotes();
          }}
        />
      </Show>

      {/* 删除确认（账物分离：只删记录，归档文件保留） */}
      <Show when={deleteTarget()}>
        <ConfirmDialog
          title="删除报价记录"
          message={`确定删除报价记录「${deleteTarget()!.no}」吗？删除报价记录（归档文件保留）：只删除台账记录，原件仍保留在 报价/<年份>/ 目录。`}
          confirmLabel="删除"
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      </Show>
    </div>
  );
}
