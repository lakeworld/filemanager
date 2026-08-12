/**
 * 报价新建/编辑表单弹窗（v2.4.9 S3b，PLAN §3.4）：列表页「新建」与详情页「编辑」共用。
 * 字段：date（默认今天，YYYY-MM-DD）/客户下拉（来自客户台账，可空——报价可不挂客户）/
 *       单号（新建留空自动生成、可手输；编辑只读展示——Task 7 疑虑 2 定稿：单号不可改）/notes。
 * 明细行动态编辑：≥1 行，每行 product/sku/qty/unit_price；amount 自动计算展示（round2 同 core 口径）；
 *       合计 total_amount 实时汇总（写入由 core 重算，页面只展示）。
 * 校验（前端友好提示 + core 双保险）：明细 ≥1 行、qty≥1、unit_price≥0、品名非空。
 * 归档：选本地文件 → quotes.archiveFile（按日期年份归档 报价/<YYYY>/）→ 保存带 file_path；
 *       Task 7 疑虑 1 定稿：不做移除附件功能——UI 不提供移除按钮，file_path 有值仅展示文件名（可预览/换绑）。
 * 状态机联动：status='已确认' 时明细行只读锁定（须先转修订中才能编辑——core 已强制，UI 同步禁用）。
 * 查重：新建手输单号重名 → core create 拒绝（error 含已有记录摘要）→ toast 提示，不提供强制继续。
 */
import { Show, For, createSignal } from "solid-js";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { showToast } from "~/stores/notifyBanner";
import { openPreview } from "~/stores/preview";
import DatePicker from "~/components/DatePicker";
import type { QuoteRecord, CustomerInfo, FileEntry } from "~/types";

/** 明细行表单态（qty/unit_price 字符串输入，保存时校验转换；amount 实时计算） */
interface LineForm {
  product: string;
  sku: string;
  qty: string;
  unit_price: string;
}

/** 金额两位小数（同 core round2 口径；仅展示与页内合计，写入由 core 重算） */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 行小计 = round2(qty × unit_price)；非法输入返回 NaN（展示 "-"） */
function lineAmount(l: LineForm): number {
  const q = Number(l.qty);
  const p = Number(l.unit_price);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return NaN;
  return round2(q * p);
}

function fmtMoney(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-";
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function baseNameOf(relPath: string): string {
  return relPath.split("/").pop() || relPath;
}

/** 归档文件相对路径 → FileEntry（供 openPreview 预览；账物分离：文件缺失时预览失败并提示） */
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

const blankLine = (): LineForm => ({ product: "", sku: "", qty: "", unit_price: "" });

export default function QuoteFormModal(props: {
  mode: "create" | "edit";
  /** edit 模式必传（status='已确认' 时明细行只读锁定） */
  record?: QuoteRecord;
  customers: CustomerInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = props.mode === "edit";
  const rec = props.record;
  const locked = isEdit && rec?.status === "已确认"; // 已确认：明细只读锁定（core 同步拒绝）

  const [date, setDate] = createSignal(isEdit ? rec?.date ?? "" : toDateKey(new Date()));
  const [customer, setCustomer] = createSignal(rec?.customer ?? "");
  // 新建：留空自动生成、可手输；编辑：单号只读展示（生成后不可改）
  const [quotationNo, setQuotationNo] = createSignal(isEdit ? rec?.quotation_no ?? "" : "");
  const [notes, setNotes] = createSignal(rec?.notes ?? "");
  const [lines, setLines] = createSignal<LineForm[]>(
    isEdit && rec
      ? rec.lines.map((l) => ({
          product: l.product,
          sku: l.sku ?? "",
          qty: String(l.qty),
          unit_price: String(l.unit_price),
        }))
      : [blankLine()],
  );
  const [filePath, setFilePath] = createSignal(rec?.file_path ?? "");
  // 本次弹窗内已归档但尚未保存的文件（archiveFile 立即落盘，取消/查重拒绝会留下孤儿文件，关闭时提示）
  const [stagedArchive, setStagedArchive] = createSignal("");

  const setLine = (i: number, patch: Partial<LineForm>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const addLine = () => setLines((prev) => [...prev, blankLine()]);
  const removeLine = (i: number) => setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));

  /** 合计 = round2(Σ 行小计)；任一行非法 → 整表显示 "-"（只展示，不进计算） */
  const totalAmount = () => {
    const ls = lines();
    if (ls.length === 0) return NaN;
    let sum = 0;
    for (const l of ls) {
      const a = lineAmount(l);
      if (Number.isNaN(a)) return NaN;
      sum += a;
    }
    return round2(sum);
  };

  /** 选本地文件 → 归档到 报价/<YYYY>/（年份取报价日期）→ 相对路径回填表单 */
  const pickFile = async () => {
    const d = date();
    if (!d) {
      showToast("info", "请先选择报价日期，再归档文件（归档目录按报价日期年份）");
      return;
    }
    const src = await api.dialog.openFile("选择报价文件", [{ displayName: "所有文件", pattern: "*" }]);
    if (!src) return;
    const r = await api.quotes.archiveFile(src, d);
    if (r.success && r.data) {
      setFilePath(r.data);
      setStagedArchive(r.data);
    } else {
      showToast("error", "文件归档失败", r.error || "未知错误");
    }
  };

  /** 关闭弹窗：本次已归档未保存的文件提示可删除（取消或遮罩点击共用；不提供删除按钮） */
  const close = () => {
    const staged = stagedArchive();
    if (staged) {
      showToast("info", "刚归档的文件未保存为报价记录", `「${staged}」已落在 报价/<年份>/ 归档目录。如不需要，请到文件管理中删除该文件。`);
    }
    setStagedArchive("");
    props.onClose();
  };

  const save = async () => {
    const ls = lines();
    if (ls.length === 0) {
      showToast("info", "报价明细不能为空（至少 1 行）");
      return;
    }
    const validLines: { product: string; sku?: string; qty: number; unit_price: number; amount: number }[] = [];
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i];
      const product = l.product.trim();
      if (!product) {
        showToast("info", `明细第 ${i + 1} 行缺少品名`);
        return;
      }
      const qty = Number(l.qty);
      if (!Number.isFinite(qty) || qty < 1) {
        showToast("info", `明细第 ${i + 1} 行数量无效（应 ≥1）`);
        return;
      }
      const unitPrice = Number(l.unit_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        showToast("info", `明细第 ${i + 1} 行单价无效（应 ≥0）`);
        return;
      }
      validLines.push({ product, sku: l.sku.trim() || undefined, qty, unit_price: unitPrice, amount: round2(qty * unitPrice) });
    }
    const c = customer().trim();
    const n = notes().trim();
    const fp = filePath();

    let result;
    if (isEdit && rec) {
      const req = {
        quotation_no: rec.quotation_no,
        date: date(),
        // 已确认锁定：明细不随表单提交（core update 同样拒绝 lines），可改仅 日期/客户/备注/归档换绑
        lines: locked ? undefined : validLines,
        // 空字符串 = 清空字段（core update 语义：undefined 保留原值，'' 删除）
        customer: c,
        notes: n,
        file_path: fp !== rec.file_path ? fp || undefined : undefined,
      };
      result = await api.quotes.update(req);
    } else {
      result = await api.quotes.create({
        quotation_no: quotationNo().trim() || undefined,
        date: date(),
        customer: c || undefined,
        lines: validLines,
        notes: n || undefined,
        file_path: fp || undefined,
      });
    }
    if (result.success) {
      setStagedArchive("");
      showToast("success", isEdit ? "报价单已更新" : "报价单已创建");
      props.onSaved();
    } else {
      showToast("error", "保存失败", result.error || "未知错误");
    }
  };

  const inputCls =
    "w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-surface-100 disabled:text-surface-400";
  const labelCls = "block text-sm font-medium text-surface-700 mb-1";

  return (
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={close}>
      <div
        class="bg-white rounded-2xl w-full max-w-3xl p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 class="text-xl font-bold mb-4">{isEdit ? "编辑报价单" : "新建报价单"}</h2>
        <Show when={locked}>
          <p class="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-4">
            报价单已确认，明细行已锁定。如需修改明细，请先转「修订中」。
          </p>
        </Show>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label class={labelCls}>报价日期 *</label>
            <DatePicker value={date()} onChange={setDate} placeholder="选择报价日期" />
          </div>
          <div>
            <label class={labelCls}>关联客户</label>
            <select
              class="w-full px-3 py-2 border border-surface-200 rounded-lg bg-white text-sm"
              value={customer()}
              onChange={(e) => setCustomer(e.currentTarget.value)}
            >
              <option value="">不关联客户</option>
              <For each={props.customers}>
                {(c) => <option value={c.name}>{c.name}</option>}
              </For>
            </select>
          </div>
          <div>
            <label class={labelCls}>报价单号 {!isEdit && <span class="text-surface-400 font-normal">（留空自动生成）</span>}</label>
            <Show
              when={!isEdit}
              fallback={
                <input type="text" class={`${inputCls} bg-surface-100`} value={quotationNo()} disabled title="报价单号生成后不可修改" />
              }
            >
              <input
                type="text"
                class={inputCls}
                placeholder="如：QT-20260812-001"
                value={quotationNo()}
                onInput={(e) => setQuotationNo(e.currentTarget.value)}
              />
            </Show>
          </div>
        </div>

        {/* 明细行 */}
        <div class="mt-4">
          <div class="flex items-center justify-between mb-2">
            <label class="text-sm font-medium text-surface-700">明细行 *</label>
            <Show when={!locked}>
              <button type="button" class="btn-secondary text-xs px-2 py-1" onClick={addLine}>
                ➕ 添加明细行
              </button>
            </Show>
          </div>
          <div
            class="px-3 py-2 text-xs text-surface-400 grid items-center gap-2 rounded-lg bg-surface-50"
            style={{ "grid-template-columns": "minmax(150px,1.4fr) minmax(90px,0.9fr) minmax(70px,0.7fr) minmax(90px,0.9fr) minmax(90px,0.9fr) 28px" }}
          >
            <span>品名 *</span>
            <span>货号</span>
            <span>数量 *</span>
            <span>单价（元）*</span>
            <span class="text-right">小计</span>
            <span />
          </div>
          <div class="flex flex-col gap-2 mt-2">
            <For each={lines()}>
              {(l, i) => (
                <div
                  class="grid items-center gap-2"
                  style={{ "grid-template-columns": "minmax(150px,1.4fr) minmax(90px,0.9fr) minmax(70px,0.7fr) minmax(90px,0.9fr) minmax(90px,0.9fr) 28px" }}
                >
                  <input
                    type="text"
                    class={inputCls}
                    placeholder="品名"
                    value={l.product}
                    disabled={locked}
                    onInput={(e) => setLine(i(), { product: e.currentTarget.value })}
                  />
                  <input
                    type="text"
                    class={inputCls}
                    placeholder="货号"
                    value={l.sku}
                    disabled={locked}
                    onInput={(e) => setLine(i(), { sku: e.currentTarget.value })}
                  />
                  <input
                    type="number"
                    min="1"
                    step="1"
                    class={inputCls}
                    placeholder="1"
                    value={l.qty}
                    disabled={locked}
                    onInput={(e) => setLine(i(), { qty: e.currentTarget.value })}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    class={inputCls}
                    placeholder="0.00"
                    value={l.unit_price}
                    disabled={locked}
                    onInput={(e) => setLine(i(), { unit_price: e.currentTarget.value })}
                  />
                  <span class={`text-right tabular-nums text-sm ${Number.isNaN(lineAmount(l)) ? "text-surface-300" : "text-surface-900"}`}>
                    {fmtMoney(lineAmount(l))}
                  </span>
                  <Show when={!locked}>
                    <button
                      type="button"
                      class="text-surface-300 hover:text-red-500 text-sm disabled:opacity-30"
                      title="删除该行"
                      disabled={lines().length <= 1}
                      onClick={() => removeLine(i())}
                    >
                      ✕
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <div class="flex justify-end items-center gap-2 mt-2">
            <span class="text-sm text-surface-500">
              合计
              <span class={`ml-2 font-medium tabular-nums ${Number.isNaN(totalAmount()) ? "text-surface-300" : "text-surface-900"}`}>
                ¥{fmtMoney(totalAmount())}
              </span>
            </span>
          </div>
        </div>

        <div class="mt-4">
          <label class={labelCls}>备注</label>
          <textarea
            class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
            rows={2}
            placeholder="添加备注..."
            value={notes()}
            onInput={(e) => setNotes(e.currentTarget.value)}
          />
        </div>

        {/* 归档（不做移除附件功能：已归档仅展示文件名 + 预览/换绑，无移除按钮——Task 7 疑虑 1 定稿） */}
        <div class="mt-4">
          <label class={labelCls}>报价文件（归档至 报价/&lt;年份&gt;/，可不归档）</label>
          <Show
            when={filePath()}
            fallback={
              <button type="button" class="btn-secondary text-sm" onClick={() => void pickFile()}>
                📂 选择本地文件并归档
              </button>
            }
          >
            <div class="flex items-center gap-2 text-sm">
              <span class="truncate text-surface-600" title={filePath()}>
                📎 {filePath()}
              </span>
              <button
                type="button"
                class="text-primary-600 hover:text-primary-700 text-xs shrink-0"
                onClick={() => {
                  const entry = fileEntryOf(filePath());
                  if (entry) openPreview(entry, {});
                }}
              >
                预览
              </button>
              <button type="button" class="text-surface-500 hover:text-primary-600 text-xs shrink-0" onClick={() => void pickFile()}>
                换绑
              </button>
            </div>
          </Show>
        </div>

        <div class="flex gap-3 justify-end mt-6">
          <button class="btn-secondary" onClick={close}>取消</button>
          <button class="btn-primary" onClick={() => void save()}>
            {isEdit ? "保存" : "确认创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
