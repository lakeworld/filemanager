/**
 * 报价详情/编辑页（v2.4.9 S3b，PLAN §3.4，路由 /quotes/:no）：
 * 展示报价单（单号/日期/客户/状态/备注/归档文件 + 明细行 + 合计）+ 状态流转按钮组 + 编辑弹窗 + 删除。
 * 状态流转（草稿→已确认/已确认→修订中/修订中→草稿|已确认；已确认→草稿 disabled）与列表页同组件；
 * 编辑弹窗复用 QuoteFormModal（status='已确认' 时明细行只读锁定，与 core 一致）。
 * 删除：ConfirmDialog「删除报价记录（归档文件保留）」——账物分离，删除不删文件。
 */
import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { customers, loadCustomers } from "~/stores/clients";
import { showToast } from "~/stores/notifyBanner";
import { currentEditPrefill, clearEditPrefill } from "~/stores/createPrefill";
import { openPreview } from "~/stores/preview";
import EmptyState from "~/components/EmptyState";
import ConfirmDialog from "~/components/ConfirmDialog";
import QuoteStatusActions from "~/components/QuoteStatusActions";
import QuoteFormModal from "~/components/QuoteFormModal";
import FileThumbnail from "~/components/FileThumbnail";
import ContextMenu from "~/components/ContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import type { QuoteRecord, CustomerInfo, FileEntry, DirBrowseEntry } from "~/types";

function fmtMoney(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-";
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileEntryOf(relPath: string): FileEntry | null {
  const ws = currentWorkspace()?.path;
  if (!ws) return null;
  return {
    name: relPath.split("/").pop() || relPath,
    path: `${ws.replace(/\\/g, "/")}/${relPath}`,
    size: 0,
    modified: "",
    file_type: relPath.toLowerCase().endsWith(".pdf") ? "pdf" : "image",
    thumbnail_path: null,
  };
}

function InfoRow(props: { label: string; value?: string; muted?: boolean }) {
  return (
    <div>
      <span class="text-xs text-surface-400 block">{props.label}</span>
      <span class={`text-sm ${props.muted ? "text-surface-300" : props.value ? "text-surface-700" : "text-surface-300"}`}>
        {props.value || "—"}
      </span>
    </div>
  );
}

// v2.5.3（P2-12）：加载序号模块级（照 Images imageLoadSeq 先例）——卸载清理递增后跨挂载延续计数，
// 旧实例在途链持有的旧值永远不会与新实例的计数撞号，过期结果必被丢弃
let quoteDetailLoadSeq = 0;

export default function QuoteDetail() {
  const navigate = useNavigate();
  const params = useParams();

  const [record, setRecord] = createSignal<QuoteRecord | null>(null);
  const [editing, setEditing] = createSignal(false);
  // v2.5.4（弹一 C-6）：编辑预填注入记录（建议改动合并后的记录传给弹窗；手动编辑时为 null 用原记录）
  const [editRecord, setEditRecord] = createSignal<QuoteRecord | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  // v2.5.5（打磨 2）：报价文档文件夹（报价/<YYYY>/<单号>/）——按钮选择导入（用户拍板：台账一律按钮，拖拽导入仅产品集全局）
  const [docs, setDocs] = createSignal<DirBrowseEntry[]>([]);
  const docCtx = useContextMenu<DirBrowseEntry>();

  const loadDocs = async () => {
    const cur = record();
    if (!cur) return;
    const r = await api.quotes.docList(cur.quotation_no, cur.date).catch(() => null);
    if (r?.success) setDocs(r.data ?? []);
  };
  createEffect(() => {
    if (record()) void loadDocs();
  });

  /** 按钮选择多文件 → 复制进报价文档文件夹 */
  const handleAddDocs = async () => {
    const cur = record();
    if (!cur) return;
    const paths = await api.dialog.openFiles("选择文件（可多选）", [{ displayName: "所有文件", pattern: "*" }]);
    if (!paths || paths.length === 0) return;
    const r = await api.quotes.docCopy(cur.quotation_no, cur.date, paths);
    if (r.success) {
      showToast("success", `已添加 ${r.data?.length ?? 0} 个文件到文档文件夹`);
      void loadDocs();
    } else {
      showToast("error", "添加失败", r.error || "未知错误");
    }
  };

  const docMenuItems = () => {
    const d = docCtx.payload();
    if (!d) return [];
    return buildFileContextMenuItems({
      file: d,
      onPreview: () => openPreview(d, { onDelete: () => void loadDocs() }),
      onOpenDefault: (f) => void api.files.openWithDefaultApp(f.path),
      onShowInExplorer: (paths) => void api.files.showFilesInExplorer(paths),
      onCopy: (paths) => void api.files.copyFilesToClipboard(paths),
      onDelete: () => void loadDocs(),
    });
  };

  const quotationNo = () => {
    const no = params.no || "";
    try {
      return decodeURIComponent(no);
    } catch {
      return no;
    }
  };

  // v2.5.3（P2-12）：卸载即递增加载代（模块级）——未完成的加载链校验失效后立即退出
  onCleanup(() => {
    quoteDetailLoadSeq++;
  });

  // v2.5.3（P2-14）：加载开始时清空旧 record，失败不再残留旧单（防「已删除单仍显示」）
  const loadQuote = async (no: string) => {
    const s = ++quoteDetailLoadSeq;
    setRecord(null);
    if (!no) return;
    const r = await api.quotes.get(no);
    if (s !== quoteDetailLoadSeq) return;
    if (r.success) setRecord(r.data ?? null);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadCustomers();
      // v2.5.2：参数同步读入 effect 体内（受 Solid 追踪）——/quotes/A → /quotes/B 路由参数变化时
      // 组件实例复用不重载、详情页停留在旧记录（照 ProductSets psName 先例）
      loadQuote(quotationNo());
    }
  });
  // v2.5.4（弹一 C-6）：编辑预填消费（单条制）——key=报价单号 → 建议改动合并到记录后打开编辑弹窗。
  // 记录异步加载（loadQuote）：未就绪不消费不清；始终找不到 = 忽略（不崩）。
  createEffect(() => {
    currentEditPrefill("quote");
    const edit = currentEditPrefill("quote");
    if (!edit) return;
    const cur = record();
    if (!cur) return;
    setEditRecord({ ...cur, ...(edit.payload as Partial<QuoteRecord>) });
    setEditing(true);
    clearEditPrefill("quote");
  });

  const customerExists = (name?: string) => !!name && customers().some((c) => c.name === name);

  const doDelete = async () => {
    const r = await api.quotes.delete(quotationNo());
    if (r.success) {
      showToast("success", "报价记录已删除（归档文件保留）");
      navigate("/quotes");
    } else {
      showToast("error", "删除失败", r.error || "未知错误");
    }
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center gap-2 mb-2 text-sm text-surface-500 shrink-0">
        <button class="hover:text-primary-600" onClick={() => navigate("/quotes")}>报价</button>
        <span>/</span>
        <span class="text-surface-900 font-medium">{quotationNo()}</span>
      </div>

      <Show when={record()} fallback={
        <EmptyState icon="📄" title="报价单不存在" desc="该报价单可能已被删除，或工作区已切换">
          <button class="btn-primary" onClick={() => navigate("/quotes")}>返回报价列表</button>
        </EmptyState>
      }>
        {(rec) => (
          <>
            <div class="flex items-center justify-between mb-6 shrink-0">
              <div>
                <h1 class="text-2xl font-bold text-surface-900">{rec().quotation_no}</h1>
                <p class="text-surface-500 mt-1">报价单详情与状态流转</p>
              </div>
              <div class="flex items-center gap-2">
                <button class="btn-secondary text-sm" onClick={() => { setEditRecord(null); setEditing(true); }}>
                  ✏️ 编辑
                </button>
                <button
                  class="btn-secondary text-sm text-danger-600 hover:bg-danger-50 hover:border-danger-200"
                  onClick={() => setConfirmDelete(true)}
                >
                  🗑️ 删除报价
                </button>
              </div>
            </div>

            {/* 信息卡 */}
            <div class="card p-6 mb-6 shrink-0">
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-semibold text-surface-900">报价信息</h3>
                <QuoteStatusActions quotationNo={rec().quotation_no} status={rec().status} onChanged={() => void loadQuote(quotationNo())} />
              </div>
              <div class="grid grid-cols-1 md:grid-cols-4 gap-x-6 gap-y-3">
                <InfoRow label="报价日期" value={rec().date} />
                <InfoRow label="关联客户" value={rec().customer} muted={!!rec().customer && !customerExists(rec().customer)} />
                <InfoRow label="创建于" value={rec().created_at} />
                <InfoRow label="更新于" value={rec().updated_at} />
              </div>
              <Show when={rec().confirmed_at}>
                <p class="text-xs text-surface-400 mt-2">确认于 {rec().confirmed_at}</p>
              </Show>
              <Show when={rec().notes}>
                <p class="text-sm text-surface-600 mt-4 whitespace-pre-wrap">{rec().notes}</p>
              </Show>
              {/* 归档文件（不做移除附件功能：仅展示文件名 + 预览；file_path 有值时显示） */}
              <Show when={rec().file_path}>
                <div class="flex items-center gap-2 text-sm mt-4">
                  <span class="truncate text-surface-600" title={rec().file_path}>📎 {rec().file_path}</span>
                  <button
                    class="text-primary-600 hover:text-primary-700 text-xs shrink-0"
                    onClick={() => {
                      const entry = fileEntryOf(rec().file_path);
                      if (entry) openPreview(entry, { onDelete: () => void loadQuote(quotationNo()) });
                    }}
                  >
                    预览
                  </button>
                </div>
              </Show>
            </div>

            {/* 明细行 */}
            <div class="card p-6 shrink-0">
              <h3 class="text-lg font-semibold text-surface-900 mb-4">报价明细</h3>
              <div
                class="px-3 py-2 text-xs text-surface-400 grid items-center gap-2 rounded-lg bg-surface-50"
                style={{ "grid-template-columns": "minmax(160px,1.4fr) minmax(100px,0.9fr) minmax(80px,0.7fr) minmax(100px,0.9fr) minmax(100px,0.9fr)" }}
              >
                <span>品名</span>
                <span>货号</span>
                <span>数量</span>
                <span class="text-right">单价（元）</span>
                <span class="text-right">小计</span>
              </div>
              <div class="flex flex-col mt-1">
                <For each={rec().lines}>
                  {(l) => (
                    <div
                      class="px-3 py-2 grid items-center gap-2 text-sm border-b border-surface-100 last:border-0"
                      style={{ "grid-template-columns": "minmax(160px,1.4fr) minmax(100px,0.9fr) minmax(80px,0.7fr) minmax(100px,0.9fr) minmax(100px,0.9fr)" }}
                    >
                      <span class="text-surface-900 truncate min-w-0">{l.product}</span>
                      <span class="text-surface-500 truncate min-w-0">{l.sku || "-"}</span>
                      <span class="tabular-nums">{l.qty}</span>
                      <span class="text-right tabular-nums">{fmtMoney(l.unit_price)}</span>
                      <span class="text-right tabular-nums text-surface-900">{fmtMoney(l.amount)}</span>
                    </div>
                  )}
                </For>
                <div class="flex justify-end items-center gap-2 px-3 py-2 mt-1">
                  <span class="text-sm text-surface-500">
                    合计
                    <span class="ml-2 font-medium tabular-nums text-surface-900">¥{fmtMoney(rec().total_amount)}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* 文档文件夹（v2.5.5 打磨 2）：报价/<YYYY>/<单号>/——按钮选择导入（台账统一按钮，拖拽导入仅产品集全局） */}
            <div class="card p-6 shrink-0 mt-6">
              <div class="flex items-center justify-between mb-3">
                <h3 class="text-lg font-semibold text-surface-900">文档（{docs().length}）</h3>
                <div class="flex items-center gap-2">
                  <span class="text-xs text-surface-400">报价/{rec().date.slice(0, 4)}/{rec().quotation_no}/</span>
                  <button class="btn-secondary text-sm" onClick={() => void handleAddDocs()}>
                    📂 选择文件并添加
                  </button>
                </div>
              </div>
              <div class="rounded-xl border border-surface-200 p-4 min-h-[120px]">
                <Show when={docs().length === 0} fallback={
                  <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    <For each={docs()}>
                      {(d) => (
                        <div
                          class="card p-2 cursor-pointer select-none hover:shadow-card-hover"
                          onClick={() => openPreview(d, { onDelete: () => void loadDocs() })}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            docCtx.open(e, d);
                          }}
                          title={`${d.name}\n单击预览 · 右键更多操作`}
                        >
                          <div class="h-20 rounded-lg bg-surface-100 overflow-hidden flex items-center justify-center">
                            <FileThumbnail filePath={d.path} fileType={d.file_type} />
                          </div>
                          <div class="text-xs font-medium truncate mt-1.5 px-0.5">{d.name}</div>
                          <div class="text-[10px] text-surface-400 px-0.5">{formatBytes(d.size)}</div>
                        </div>
                      )}
                    </For>
                  </div>
                }>
                  <div class="flex flex-col items-center justify-center gap-1 py-6 text-surface-400">
                    <span class="text-2xl">📎</span>
                    <span class="text-sm">还没有文档——点右上「选择文件并添加」把报价单、合同、产品图放进来</span>
                  </div>
                </Show>
              </div>
            </div>
          </>
        )}
      </Show>

      {/* v2.5.5（打磨 2）：文档卡片右键菜单 */}
      <Show when={docCtx.show()}>
        <ContextMenu x={docCtx.x()} y={docCtx.y()} onClose={docCtx.close} items={docMenuItems()} />
      </Show>

      {/* 编辑弹窗（status='已确认' 时明细行只读锁定；v2.5.4 C-6：编辑预填用合并记录） */}
      <Show when={editing() && record()}>
        <QuoteFormModal
          mode="edit"
          record={editRecord() ?? record()!}
          customers={customers() as CustomerInfo[]}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void loadQuote(quotationNo());
          }}
        />
      </Show>

      {/* 删除确认（账物分离：只删记录，归档文件保留） */}
      <Show when={confirmDelete()}>
        <ConfirmDialog
          title="删除报价记录"
          message={`确定删除报价记录「${quotationNo()}」吗？删除报价记录（归档文件保留）：只删除台账记录，原件仍保留在 报价/<年份>/ 目录。`}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            setConfirmDelete(false);
            void doDelete();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      </Show>
    </div>
  );
}
