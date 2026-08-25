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
import { Show, For, createSignal, createEffect } from "solid-js";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { showToast } from "~/stores/notifyBanner";
import { openPreview } from "~/stores/preview";
import DatePicker from "~/components/DatePicker";
import MoneyInput from "~/components/MoneyInput"; // v2.5.5（B2）：数量/单价输入统一
import Modal from "~/components/ui/Modal";
import ConfirmDialog from "~/components/ConfirmDialog"; // v2.5.5（B1-B）：脏守卫「放弃未保存内容？」二次确认
import type { QuoteRecord, CustomerInfo, FileEntry } from "~/types";
import type { QuotePrefill } from "~/stores/createPrefillNormalize";

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
  /** v2.5.4 预填（PLAN-v2.5.4 §3.4）：仅 create 模式消费；组件随 Show 每次新开重挂载，初始化即 seed */
  initial?: QuotePrefill | null;
  customers: CustomerInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = props.mode === "edit";
  const rec = props.record;
  const prefill = !isEdit ? props.initial : null;
  const locked = isEdit && rec?.status === "已确认"; // 已确认：明细只读锁定（core 同步拒绝）

  // —— v2.5.5（B1-B）：初始快照（mount 时捕获；组件随 Show 每次新开重挂载，即打开基准）——
  const initDate = isEdit ? rec?.date ?? "" : prefill?.date ?? toDateKey(new Date());
  const initCustomer = isEdit ? rec?.customer ?? "" : prefill?.customer ?? "";
  const initNo = isEdit ? rec?.quotation_no ?? "" : prefill?.quotation_no ?? "";
  const initNotes = isEdit ? rec?.notes ?? "" : prefill?.notes ?? "";
  const initLines: LineForm[] =
    isEdit && rec
      ? rec.lines.map((l) => ({
          product: l.product,
          sku: l.sku ?? "",
          qty: String(l.qty),
          unit_price: String(l.unit_price),
        }))
      : prefill?.lines?.length
        ? prefill.lines.map((l) => ({
            product: l.product ?? "",
            sku: l.sku ?? "",
            qty: l.qty != null ? String(l.qty) : "",
            unit_price: l.unit_price != null ? String(l.unit_price) : "",
          }))
        : [blankLine()];
  const initFilePath = isEdit ? rec?.file_path ?? "" : prefill?.file_path ?? "";

  const [date, setDate] = createSignal(initDate);
  const [customer, setCustomer] = createSignal(initCustomer);
  // 新建：留空自动生成、可手输；编辑：单号只读展示（生成后不可改）
  const [quotationNo, setQuotationNo] = createSignal(initNo);
  const [notes, setNotes] = createSignal(initNotes);
  const [lines, setLines] = createSignal<LineForm[]>(initLines);
  const [filePath, setFilePath] = createSignal(initFilePath);
  // B1 P0 归档后移：本次弹窗内已选文件但尚未保存的待归档源（选文件只暂存，保存时才 archiveFile）
  const [stagedArchive, setStagedArchive] = createSignal<{ sourcePath: string; date: string } | null>(null);
  // v2.5.3（P2-10）：保存中——按钮 disabled + save 入口守卫，防连点双创建（照 CreateClientModal saving 先例）
  const [saving, setSaving] = createSignal(false);
  // v2.5.5（B1-B）：脏守卫「放弃未保存内容？」确认弹窗开关（防叠加触发）
  const [discardOpen, setDiscardOpen] = createSignal(false);

  const setLine = (i: number, patch: Partial<LineForm>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  // v2.5.4（预填 e2e 抓出）：客户下拉 options 随 customers store 异步刷新重建时浏览器丢选中，
  // Solid 不会在子节点变化时重设 value——customers 变化后补应用一次（预填/编辑初始选中依赖此）
  let customerSelectRef: HTMLSelectElement | undefined;
  createEffect(() => {
    props.customers;
    const v = customer();
    if (customerSelectRef && customerSelectRef.value !== v) customerSelectRef.value = v;
  });

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

  /** 关闭弹窗：只清暂存 + 关闭，零落盘（脏守卫在 dirty 时接管二次确认，此处不再 toast） */
  const close = () => {
    setStagedArchive(null);
    setDiscardOpen(false);
    props.onClose();
  };

  /** v2.5.5（B1-B）：脏判定 = 暂存源 OR create 模式预填 file_path（防孤儿）OR 表单相对打开快照有改动 */
  const dirty = () => {
    if (stagedArchive()) return true;
    if (!isEdit && filePath() !== "") return true; // 预填 file_path 未登记 → 防孤儿（B0 §六）
    return (
      date() !== initDate ||
      customer() !== initCustomer ||
      quotationNo() !== initNo ||
      notes() !== initNotes ||
      filePath() !== initFilePath ||
      JSON.stringify(lines()) !== JSON.stringify(initLines)
    );
  };

  /** 关闭请求：dirty → 弹「放弃未保存内容？」；否则直关（取消按钮与遮罩/Esc 同路） */
  const requestClose = () => {
    if (discardOpen()) return; // 确认弹窗打开期间防叠加触发
    if (dirty()) setDiscardOpen(true);
    else close();
  };

  /** B1 P0 保存失败回滚：删除本次归档刚产生的副本（只删精确 rel，force+catch，走回收站 file API 不级联台账） */
  const rollbackArchived = async (rel: string) => {
    const ws = currentWorkspace()?.path;
    if (!ws || !rel) return;
    const r = await api.files.delete([`${ws.replace(/\\/g, "/")}/${rel}`]).catch(() => null);
    if (!r?.success) {
      console.warn("[rollbackArchived] 回滚删除归档副本失败", rel, r?.error);
    }
  };

  const save = async () => {
    if (saving()) return; // 连点守卫（P2-10：防自动单号连点生成两条记录）
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
    const staged = stagedArchive(); // B1 P0 归档后移：暂存源（待归档），保存时才 archiveFile
    let fp = filePath();

    setSaving(true);
    try {
      let result;
      if (isEdit && rec) {
        // 换绑：先归档暂存源，再 update（失败回滚本次刚归档的副本；未换绑缺省 → core 保持原 file_path）
        if (staged) {
          const arch = await api.quotes.archiveFile(staged.sourcePath, staged.date || date());
          if (arch.success && arch.data) {
            fp = arch.data;
          } else {
            showToast("error", "文件归档失败", arch.error || "未知错误");
            return;
          }
        }
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
        if (!result.success && staged) await rollbackArchived(fp);
      } else {
        // —— B1 P0 归档后移：先归档暂存源，再 create ——
        // 注：quotes.checkNumber 未在 IPC 面暴露（协议面零变更），无法保存前预检；
        //     core create 对重复单号拒绝 → 用「归档 → create → 失败回滚」等效闭环，不留孤儿
        if (staged) {
          const arch = await api.quotes.archiveFile(staged.sourcePath, staged.date || date());
          if (arch.success && arch.data) {
            fp = arch.data;
          } else {
            showToast("error", "文件归档失败", arch.error || "未知错误");
            return;
          }
        }
        result = await api.quotes.create({
          quotation_no: quotationNo().trim() || undefined,
          date: date(),
          customer: c || undefined,
          lines: validLines,
          notes: n || undefined,
          file_path: fp || undefined,
        });
        if (!result.success && staged) await rollbackArchived(fp);
      }
      if (result.success) {
        setStagedArchive(null);
        showToast("success", isEdit ? "报价单已更新" : "报价单已创建");
        props.onSaved();
      } else {
        showToast("error", "保存失败", result.error || "未知错误");
      }
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-surface-100 disabled:text-surface-400";
  const labelCls = "block text-sm font-medium text-surface-700 mb-1";

  return (
    <>
      <Modal
        open
        title={isEdit ? "编辑报价单" : "新建报价单"}
        size="3xl"
        onClose={close}
        // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc 走 onCloseRequest（二次确认）
        dirty={dirty()}
        onCloseRequest={requestClose}
      >
      <div class="p-6">
        <h2 class="text-xl font-bold mb-4">{isEdit ? "编辑报价单" : "新建报价单"}</h2>
        <Show when={locked}>
          <p class="text-sm text-warning-700 bg-warning-50 rounded-lg px-3 py-2 mb-4">
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
              ref={(el) => { customerSelectRef = el; }}
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
                  <MoneyInput
                    class={inputCls}
                    placeholder="1"
                    min={1}
                    value={l.qty}
                    disabled={locked}
                    onChange={(v) => setLine(i(), { qty: v })}
                  />
                  <MoneyInput
                    class={inputCls}
                    placeholder="0.00"
                    min={0}
                    value={l.unit_price}
                    disabled={locked}
                    onChange={(v) => setLine(i(), { unit_price: v })}
                  />
                  <span class={`text-right tabular-nums text-sm ${Number.isNaN(lineAmount(l)) ? "text-surface-300" : "text-surface-900"}`}>
                    {fmtMoney(lineAmount(l))}
                  </span>
                  <Show when={!locked}>
                    <button
                      type="button"
                      class="text-surface-300 hover:text-danger-500 text-sm disabled:opacity-30"
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

        {/* 归档文件（v2.5.5 打磨 2：移除「选择本地文件并归档」按钮——多文档统一走详情页文档区拖拽；
            已归档仅只读展示 + 预览，无换绑/移除） */}
        <Show when={filePath()}>
          <div class="mt-4">
            <label class={labelCls}>报价文件</label>
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
            </div>
          </div>
        </Show>

        <div class="flex gap-3 justify-end mt-6">
          {/* v2.5.5（B1-B）：取消与遮罩/Esc 同路——dirty 时走 requestClose（二次确认） */}
          <button class="btn-secondary" onClick={requestClose}>取消</button>
          <button class="btn-primary" onClick={() => void save()} disabled={saving()}>
            {isEdit ? "保存" : "确认创建"}
          </button>
        </div>
      </div>
      </Modal>
      {/* v2.5.5（B1-B）：脏守卫「放弃未保存内容？」二次确认（独立 Modal 叠层，打开期间遮罩/Esc 不叠加触发） */}
      <Show when={discardOpen()}>
        <ConfirmDialog
          title="放弃未保存内容？"
          message="该弹窗有未保存的修改或待归档文件，放弃后将不会保存任何内容（已选文件不会归档）。"
          confirmLabel="放弃修改"
          cancelLabel="继续编辑"
          danger
          onConfirm={close}
          onCancel={() => setDiscardOpen(false)}
        />
      </Show>
    </>
  );
}
