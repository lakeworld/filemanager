import { Show, For, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import VirtualGrid from "~/components/VirtualGrid";
import EmptyState from "~/components/EmptyState";
import ContextMenu from "~/components/ContextMenu";
import type { ContextMenuItem } from "~/components/ContextMenu";
import { useContextMenu } from "~/hooks/useContextMenu";
import { buildFileContextMenuItems } from "~/utils/fileContextMenu";
import { api } from "~/wails/api";
// v2.5.8 D19（B1）：复制反馈统一（成功/失败都出声）
import { copyFilesWithFeedback } from "~/utils/copyAction";
import { currentWorkspace } from "~/stores/workspace";
import { STATUSES, statusChipClass, fmtMoney, isDueSoon, baseNameOf } from "./utils";
import type { InvoiceRecord, InvoiceStatus } from "./types";

/**
 * 发票台账卡片网格（PLAN-v2.5.5 §一 任务1，B3 任务 A 卡片化——去表格）：
 * 2~3 列紧凑网格，卡片 = 金额主视觉 / 号码+日期 / 开票方→购买方（ellipsis+title 悬浮全文）/
 * 状态徽章（点击弹出改状态，合并旧「徽章+下拉」两段式）/ 悬停操作（预览·编辑·删除）。
 * 多选：卡片左上角复选框 + 选中边框（selectedIds 由页面传入，Images.tsx 同款模式）。
 * 旧 InvoiceTable.tsx（表格）已删除——本组件为其卡片化替代，行为断言（预览/编辑/删除/状态流转回调）不变。
 */
export default function InvoiceCards(props: {
  rows: InvoiceRecord[];
  missing: Record<string, boolean>;
  customerExists: (name: string) => boolean;
  /** v2.5.7 补丁线：供应商 chip 存在性判断（镜像 customerExists） */
  supplierExists: (name: string) => boolean;
  selectedIds: string[];
  onToggleSelect: (number: string) => void;
  onSetStatus: (number: string, status: InvoiceStatus) => void;
  onPreview: (rec: InvoiceRecord) => void;
  onEdit: (rec: InvoiceRecord) => void;
  onDelete: (rec: InvoiceRecord) => void;
  scrollResetKey: string;
}) {
  const navigate = useNavigate();
  /** 状态弹层（点徽章弹出，合并两段式）：记录目标发票号与锚点坐标（fixed 定位，避开虚拟行 transform 层叠） */
  const [statusMenu, setStatusMenu] = createSignal<{ number: string; x: number; y: number } | null>(null);
  // v2.5.5 打磨 2：卡片右键菜单（预览/编辑/系统打开/在文件夹中显示/删除）
  const ctxMenu = useContextMenu<InvoiceRecord>();

  /** 归档文件相对路径 → FileEntry（供右键文件操作；与 Invoices.tsx fileEntryOf 同构） */
  const entryOf = (rel: string) => {
    const ws = currentWorkspace()?.path;
    if (!ws) return null;
    return {
      name: baseNameOf(rel),
      path: `${ws.replace(/\\/g, "/")}/${rel}`,
      size: 0,
      modified: "",
      file_type: rel.toLowerCase().endsWith(".pdf") ? "pdf" : "image",
      thumbnail_path: null,
    };
  };

  const menuItems = () => {
    const rec = ctxMenu.payload();
    if (!rec) return [];
    const items: ContextMenuItem[] = [];
    items.push({ label: "编辑", icon: "✏️", action: () => props.onEdit(rec) });
    if (rec.file_path) {
      const entry = entryOf(rec.file_path);
      if (entry) {
        items.push(
          ...buildFileContextMenuItems({
            file: entry,
            onPreview: () => props.onPreview(rec),
            onOpenDefault: (f) => void api.files.openWithDefaultApp(f.path),
            onShowInExplorer: (paths) => void api.files.showFilesInExplorer(paths),
            // v2.5.8 D19（B1）：右键「复制」原先 `void api.…` 成功失败全静默，改走统一反馈
            onCopy: (paths) => void copyFilesWithFeedback(api.files.copyFilesToClipboard, paths),
          }),
        );
      }
    }
    items.push({ label: "删除", icon: "🗑️", danger: true, action: () => props.onDelete(rec) });
    return items;
  };

  const openStatusMenu = (e: MouseEvent, number: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setStatusMenu({ number, x: Math.min(r.left, window.innerWidth - 150), y: r.bottom + 4 });
  };

  const menuRec = () => props.rows.find((r) => r.number === statusMenu()?.number);

  return (
    <>
      <Show when={props.rows.length === 0} fallback={
        <div
          data-selection-bar-pad
          class={`flex-1 min-h-0 ${props.selectedIds.length > 0 ? "pb-24" : ""}`}
        >
          {/* v2.5.8 精致化 D6 批 2 定性说明：台账行走 VirtualGrid = 高基数面，卡片**保持实底 .card**
              （PLAN §四 豁免：逐卡 backdrop-filter 是滚动卡顿与内存来源，09-08 用户真机反馈同因）。
              PLAN §三 批 2 原句「台账卡基数低 → 玻璃化」的前提在此二组件已不成立（v2.5.5 卡片化后走
              VirtualGrid），故玻璃化只落在页面骨架卡（Invoices.tsx / Quotes.tsx 容器），本处不做。 */}
          <VirtualGrid
            items={props.rows}
            itemHeight={150}
            columns={{ base: 1, md: 2, lg: 2, xl: 3 }}
            gap={12}
            scrollResetKey={props.scrollResetKey}
            renderItem={(rec) => {
              // v2.5.5（单选打勾修复）：必须是响应式 getter——renderItem 顶层 const 是普通值，
              // JSX 不追踪 → 单击选中后 checked/高亮不更新（工具条页面级正常，卡片内不响应）
              const isSel = () => props.selectedIds.includes(rec.number);
              return (
                <div
                  class={`card p-3 flex flex-col h-full relative select-none group transition-colors cursor-pointer ${isSel() ? "card-selected" : ""} ${props.missing[rec.file_path] ? "opacity-70" : ""}`}
                  onDblClick={() => props.onPreview(rec)}
                  onClick={(e) => {
                    // 单击卡片空白区域 = 切换选中（避开状态徽章/客户chip/悬停按钮/复选框等交互元素）
                    const t = e.target as HTMLElement;
                    if (t.closest("button, input, a")) return;
                    props.onToggleSelect(rec.number);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    ctxMenu.open(e, rec);
                  }}
                  title="单击选中 · 双击预览归档文件 · 右键更多操作"
                >
                  {/* 选择框 + 金额主视觉（v2.5.5 打磨 2：对齐产品集 Images——单击卡片也选中，选择框保留作选中反馈/直接勾选） */}
                  <div class="flex items-start justify-between gap-2 shrink-0">
                    <input
                      type="checkbox"
                      class="w-4 h-4 accent-primary-600 mt-1 shrink-0 cursor-pointer"
                      aria-label={`选择发票 ${rec.number}`}
                      checked={isSel()}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => props.onToggleSelect(rec.number)}
                    />
                    <div class="text-right min-w-0">
                      <span class="text-xl font-bold tabular-nums text-surface-900 leading-tight block truncate" title={`金额 ¥${fmtMoney(rec.amount)}`}>
                        ¥{fmtMoney(rec.amount)}
                      </span>
                    </div>
                  </div>
                  {/* 号码 + 日期 */}
                  <div class="flex items-center gap-2 mt-1 shrink-0 min-w-0">
                    <span class="font-medium text-sm text-surface-900 truncate min-w-0" title={rec.file_path || rec.number}>
                      {rec.number}
                    </span>
                    <span class="text-xs text-surface-400 shrink-0 tabular-nums">{rec.date}</span>
                    <Show when={isDueSoon(rec)}>
                      <span class="text-danger-500 text-xs shrink-0" title="30 天内待办">⏰</span>
                    </Show>
                  </div>
                  {/* 开票方 → 购买方（ellipsis + title 悬浮全文） */}
                  <div class="text-sm text-surface-600 truncate min-w-0 mt-0.5 shrink-0" title={rec.seller}>
                    <span class="text-surface-400">开票方</span> {rec.seller}
                  </div>
                  <div class="text-sm text-surface-600 truncate min-w-0 shrink-0" title={rec.buyer}>
                    <span class="text-surface-400">购买方</span> {rec.buyer}
                  </div>
                  {/* 状态徽章（点击弹改状态）+ 客户 chip + 悬停操作 */}
                  <div class="flex items-center gap-1.5 mt-2 shrink-0 min-w-0">
                    {/* 状态徽章：`.chip` 管形状、`.link-btn` 管节奏（原内联 `transition-colors` 已由档提供，删）；
                        ring 是「可点开菜单」的悬停提示，不属于档提供的项，保留。 */}
                    <button
                      class={`chip link-btn shrink-0 hover:ring-2 hover:ring-primary-300 ${statusChipClass(rec.status)}`}
                      title="点击修改状态"
                      onClick={(e) => openStatusMenu(e, rec.number)}
                    >
                      {rec.status} ▾
                    </button>
                    {/* v2.5.8 D14（样式统一收口）：客户/供应商两个跳转 chip 原来只挂 `.chip`（管形状：
                        内距/圆角/字号），节奏（过渡/禁用态）是各点自己粘的 `transition-colors`。现补挂
                        `.link-btn` 档并删掉那三个字的内联串；两分支的底色与文字色按语义原样保留
                        （存在=可点前往，已删=灰态）。 */}
                    <Show when={rec.customer} fallback={<span class="text-surface-300 text-xs shrink-0">无客户</span>}>
                      {(name) => (
                        <button
                          class={`chip link-btn shrink-0 ${
                            props.customerExists(name())
                              ? "bg-surface-100 text-surface-700 hover:bg-primary-50 hover:text-primary-700"
                              : "bg-surface-50 text-surface-400"
                          }`}
                          title={props.customerExists(name()) ? "前往客户详情" : "客户已删除（字面值保留）"}
                          onClick={() => {
                            if (props.customerExists(name())) navigate(`/clients/${encodeURIComponent(name())}`);
                          }}
                        >
                          {name()}
                        </button>
                      )}
                    </Show>
                    <Show when={rec.supplier} fallback={<span class="text-surface-300 text-xs shrink-0">无供应商</span>}>
                      {(name) => (
                        <button
                          class={`chip link-btn shrink-0 ${
                            props.supplierExists(name())
                              ? "bg-surface-100 text-surface-700 hover:bg-primary-50 hover:text-primary-700"
                              : "bg-surface-50 text-surface-400"
                          }`}
                          title={props.supplierExists(name()) ? "前往供应商详情" : "供应商已删除（字面值保留）"}
                          onClick={() => {
                            if (props.supplierExists(name())) navigate(`/suppliers/${encodeURIComponent(name())}`);
                          }}
                        >
                          {name()}
                        </button>
                      )}
                    </Show>
                    <Show when={props.missing[rec.file_path]}>
                      <span class="text-xs text-danger-600 shrink-0" title="归档文件已缺失（不影响记录）">缺失</span>
                    </Show>
                    {/* 悬停操作（查看归档文件 · 编辑 · 删除） */}
                    <div class="ml-auto flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      {/* v2.5.8 D14（样式统一收口）：三个纯图标钮收进 `.icon-btn` 档（居中 + 圆角 +
                          精确属性过渡 + 按压/禁用态）；文字色按语义保留（预览/编辑=主色，删除=危险红），
                          `text-sm` 是字号尺寸，一并保留。 */}
                      <button class="icon-btn text-sm text-surface-400 hover:text-primary-600" title="查看归档文件" onClick={() => props.onPreview(rec)}>
                        👁
                      </button>
                      <button class="icon-btn text-sm text-surface-400 hover:text-primary-600" title="编辑" onClick={() => props.onEdit(rec)}>
                        ✏️
                      </button>
                      <button class="icon-btn text-sm text-surface-400 hover:text-danger-500" title="删除" onClick={() => props.onDelete(rec)}>
                        🗑️
                      </button>
                    </div>
                  </div>
                </div>
              );
            }}
          />
        </div>
      }>
        <div class="flex-1 flex items-center justify-center">
          <EmptyState icon="🧾" title="没有匹配的发票" desc="调整筛选条件或点击「新建发票」登记" />
        </div>
      </Show>

      {/* 状态弹层（fixed 定位，独立于虚拟行层叠；点遮罩/选中状态关闭） */}
      <Show when={statusMenu()}>
        <div class="fixed inset-0 z-[80]" onClick={() => setStatusMenu(null)} />
        <div
          class="fixed z-[90] bg-white border border-surface-200 rounded-lg shadow-card-hover py-1 min-w-[130px]"
          style={{ left: `${statusMenu()!.x}px`, top: `${statusMenu()!.y}px` }}
        >
          {/* v2.5.8 D14（样式统一收口）：状态弹层的选项行收进 `.row-btn` 档（整行可点 + 精确属性
              过渡 + 按压/禁用态），与 `components/ContextMenu.tsx` 菜单行同一口径。
              尺寸 `px-3 py-1.5 gap-2 text-sm` 与悬停底色 `hover:bg-surface-50` 按「不改观感」原样保留
              （工具类在 utilities 层，稳定覆盖档内的 px-4 py-2.5 gap-3）。 */}
          <For each={STATUSES}>
            {(s) => (
              <button
                class="row-btn justify-between px-3 py-1.5 gap-2 text-sm hover:bg-surface-50"
                onClick={() => {
                  const m = statusMenu();
                  if (m) props.onSetStatus(m.number, s);
                  setStatusMenu(null);
                }}
              >
                <span class={`chip ${statusChipClass(s)}`}>{s}</span>
                <Show when={menuRec()?.status === s}>
                  <span class="text-primary-600 text-xs">✓</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* v2.5.5 打磨 2：卡片右键菜单（编辑/预览/系统打开/在文件夹中显示/复制/删除） */}
      <Show when={ctxMenu.show()}>
        <ContextMenu x={ctxMenu.x()} y={ctxMenu.y()} onClose={ctxMenu.close} items={menuItems()} />
      </Show>
    </>
  );
}
