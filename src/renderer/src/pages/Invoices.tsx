/**
 * 发票管理页（v2.4.7，PLAN §6/§7）：发票台账 + 入库单 双 Tab。
 *
 * 台账（invoices.json）：表格（号码/日期/开票方/购买方/金额/状态/客户/待办日期）
 *   + 筛选（状态/客户/30 天待办）+ 搜索（号码/开票方/购买方）+ 新建/编辑弹窗
 *   + 行内状态流转（顺序「→」+ 下拉可回退）+ Excel 导出 + 筛选结果金额合计行。
 * 入库单（inbound.json）：表格（编号/日期/供应商/关联产品集/金额/备注）+ 新建/编辑弹窗
 *   + 文件预览 + 关联产品集 chip 跳转。
 *
 * 设计要点：
 * - 页内内存过滤（PLAN §六：台账量级千内页内过滤，不建索引）——list() 全量拉取后由本页
 *   过滤/搜索/合计；30 天待办窗口口径与 core isDueSoon 一致（本地时区解析 YYYY-MM-DD，
 *   前后 30 天，已入账排除）。
 * - 账物分离（PLAN §3.3）：删除记录不删文件（弹窗可选「同时删除归档文件」，走回收站 file
 *   单条目）；文件被删/被回收时记录保留、整行灰显 + 「文件缺失」徽标，不级联删记录。
 * - 文件缺失检测：加载后按工作区相对路径调 files.workspaceUrl（主进程 fsp.stat 校验）批量
 *   探活，并发上限 8（仿 FileThumbnail 并发闸），结果存 missingFiles 信号。
 * - 文件预览：由台账记录构造 FileEntry（台账不含体积/修改时间，size=0/modified='' 仅影响
 *   预览页信息行）→ openPreview（图片走 previewUrl 降采样副本、PDF 走 qihebox:// 协议，
 *   符合渲染层纪律 PERF-SOP §四）。
 * - 归档：新建/编辑弹窗内选本地文件 → invoices.archiveFile / inbound.archiveFile（按日期年份
 *   归档到 发票/<YYYY>/、入库/<YYYY>/）→ 以返回的相对路径作 file_path 保存；已归档可预览/换绑。
 * - 深链：?dueSoon=1 进入即开启「30 天待办」筛选（仪表盘「发票待办」区块跳转用，PLAN §4.3）。
 * - 查重（§6.2）/状态枚举/日期归一化等校验全部由 core 承担：创建/编辑命中查重即拒绝并提示
 *   已有记录摘要，页面不重复实现。
 * 渲染层纪律：台账/入库列表走 VirtualGrid 虚拟滚动；本页不创建 Blob URL、无 setTimeout
 * （无 onCleanup 定时器清理项）。
 */
import { Show, For, createSignal, createEffect } from "solid-js";
import { useSearchParams, useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace, productSets, loadProductSets } from "~/stores/workspace";
// v2.4.7：关联客户下拉消费 clients store（单一数据源，与 Clients 页同源；PLAN §6.5）
import { customers, loadCustomers } from "~/stores/clients";
// v2.4.9 S2：供应商下拉（入库单供应商选择，选项来自 suppliers store）
import { suppliers, loadSuppliers } from "~/stores/suppliers";
import { openPreview } from "~/stores/preview";
import { loadTagDefs, tagList } from "~/stores/tags";
import { showToast } from "~/stores/notifyBanner";
import DatePicker from "~/components/DatePicker";
import TagInput from "~/components/TagInput";
import VirtualGrid from "~/components/VirtualGrid";
import EmptyState from "~/components/EmptyState";
import type { InvoiceRecord, InboundRecord, FileEntry } from "~/types";

// —— 本地类型（镜像 core 请求类型；wails/api.ts 门面类型落位后可由 ~/types 导入替代）——

type InvoiceStatus = InvoiceRecord["status"];

/** 台账列表过滤（与 core InvoiceListFilter 同形，页内过滤用） */
interface InvoiceListFilter {
  status?: InvoiceStatus;
  customer?: string;
  dueSoonOnly?: boolean;
  query?: string;
}

/** 新建发票请求（镜像 core InvoiceCreateRequest） */
interface InvoiceCreateRequest {
  number: string;
  code?: string;
  date: string;
  amount: number;
  seller: string;
  buyer: string;
  status: InvoiceStatus;
  customer?: string;
  due_date?: string;
  file_path: string;
  tags?: string[];
  notes?: string;
}

/** 编辑发票请求（镜像 core InvoiceUpdateRequest；newNumber 省略 = 号码不变） */
interface InvoiceUpdateRequest {
  number: string;
  newNumber?: string;
  code?: string;
  date?: string;
  amount?: number;
  seller?: string;
  buyer?: string;
  status?: InvoiceStatus;
  customer?: string;
  due_date?: string;
  file_path?: string;
  tags?: string[];
  notes?: string;
}

/** 入库单请求（镜像 core InboundCreateRequest / InboundUpdateRequest） */
interface InboundCreateRequest {
  id: string;
  date: string;
  supplier: string;
  /** 关联供应商名（名字引用；不校验存在性——供应商删除后编辑旧入库单放行；rename 由 BoxService.renameSupplier 级联） */
  supplier_id?: string;
  product_set?: string;
  file_path: string;
  amount?: number;
  notes?: string;
}

interface InvoiceFormState {
  number: string;
  code: string;
  date: string;
  amount: string;
  seller: string;
  buyer: string;
  status: InvoiceStatus;
  customer: string;
  due_date: string;
  file_path: string;
  tags: string[];
  notes: string;
}

interface InboundFormState {
  id: string;
  date: string;
  supplier: string;
  /** 关联供应商名（选择已有供应商下拉时填入；手输清空；供应商已删除旧单显示灰显占位） */
  supplier_id: string;
  product_set: string;
  amount: string;
  notes: string;
  file_path: string;
}

const STATUSES: InvoiceStatus[] = ["待报销", "已报销", "已入账"];

/** 待办窗口 = 距今 30 天（含已过期 30 天内），与 core isDueSoon / 证书到期提醒窗口同口径 */
const DUE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 记录是否落在待办窗口（due_date 本地时区解析 YYYY-MM-DD，状态 ≠ 已入账；解析失败不提醒） */
function isDueSoon(rec: InvoiceRecord, now = Date.now()): boolean {
  if (rec.status === "已入账" || !rec.due_date) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rec.due_date);
  if (!m) return false;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  if (Number.isNaN(t)) return false;
  return t >= now - DUE_WINDOW_MS && t <= now + DUE_WINDOW_MS;
}

function nextStatusOf(s: InvoiceStatus): InvoiceStatus {
  return STATUSES[Math.min(STATUSES.indexOf(s) + 1, STATUSES.length - 1)];
}

function statusChipClass(s: InvoiceStatus): string {
  switch (s) {
    case "待报销":
      return "bg-amber-50 text-amber-700";
    case "已报销":
      return "bg-blue-50 text-blue-700";
    case "已入账":
      return "bg-emerald-50 text-emerald-700";
  }
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 金额展示（仅展示与页内合计，不进任何计算，PLAN §3.3） */
function fmtMoney(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-";
}

/** 按扩展名分类（镜像主进程 classifyFileType） */
function fileTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"].includes(ext)) return "video";
  return "other";
}

function baseNameOf(relPath: string): string {
  return relPath.split("/").pop() || relPath;
}

/** 台账记录 file_path（工作区相对路径）→ FileEntry，供 openPreview 复用（账物分离：文件缺失时预览会失败并提示） */
function fileEntryOf(relPath: string): FileEntry | null {
  const ws = currentWorkspace()?.path;
  if (!ws) return null;
  return {
    name: baseNameOf(relPath),
    path: `${ws.replace(/\\/g, "/")}/${relPath}`,
    size: 0, // 台账记录不带文件体积，预览页信息行按 0 显示（不影响功能）
    modified: "",
    file_type: fileTypeOf(relPath),
    thumbnail_path: null,
  };
}

/** 归档文件字段（新建/编辑弹窗共用）：未归档 → 选择本地文件并归档；已归档 → 路径 + 预览 + 换绑 */
function ArchiveField(props: {
  label: string;
  filePath: string;
  missing: boolean;
  onPick: () => void;
  onPreview: () => void;
}) {
  return (
    <div>
      <label class="block text-sm font-medium text-surface-700 mb-1">{props.label}</label>
      <Show
        when={props.filePath}
        fallback={
          <button type="button" class="btn-secondary text-sm" onClick={props.onPick}>
            📂 选择本地文件并归档
          </button>
        }
      >
        <div class="flex items-center gap-2 text-sm">
          <span
            class={`truncate ${props.missing ? "text-red-600" : "text-surface-600"}`}
            title={props.filePath}
          >
            📎 {props.filePath}
          </span>
          <Show when={props.missing}>
            <span class="text-red-600 text-xs shrink-0">文件缺失</span>
          </Show>
          <button type="button" class="text-primary-600 hover:text-primary-700 text-xs shrink-0" onClick={props.onPreview}>
            预览
          </button>
          <button type="button" class="text-surface-500 hover:text-primary-600 text-xs shrink-0" onClick={props.onPick}>
            换绑
          </button>
        </div>
      </Show>
    </div>
  );
}

// 台账列模板（与表头/合计行一致；minmax 保证窄窗口下可截断）
const INVOICE_COL_TEMPLATE =
  "minmax(110px,1.1fr) minmax(85px,0.85fr) minmax(130px,1.3fr) minmax(130px,1.3fr) minmax(80px,0.8fr) minmax(165px,1.35fr) minmax(95px,0.95fr) minmax(90px,0.9fr) minmax(105px,0.85fr)";
// 入库单列模板
const INBOUND_COL_TEMPLATE =
  "minmax(110px,1.1fr) minmax(90px,0.9fr) minmax(150px,1.5fr) minmax(120px,1.2fr) minmax(85px,0.85fr) minmax(150px,1.5fr) minmax(105px,0.85fr)";

export default function Invoices() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // —— 双 Tab ——
  const [tab, setTab] = createSignal<"invoices" | "inbound">("invoices");

  // —— 台账 ——
  const [invoices, setInvoices] = createSignal<InvoiceRecord[]>([]);
  // 文件缺失表：file_path → 不存在（账物分离灰显）
  const [missingFiles, setMissingFiles] = createSignal<Record<string, boolean>>({});
  const [statusFilter, setStatusFilter] = createSignal("");
  const [customerFilter, setCustomerFilter] = createSignal("");
  const [dueSoonOnly, setDueSoonOnly] = createSignal(false);
  const [query, setQuery] = createSignal("");

  // —— 入库单 ——
  const [inboundRecords, setInboundRecords] = createSignal<InboundRecord[]>([]);

  // —— 弹窗状态 ——
  const [invoiceEditor, setInvoiceEditor] = createSignal<{ mode: "create" } | { mode: "edit"; record: InvoiceRecord } | null>(null);
  const [invoiceForm, setInvoiceForm] = createSignal<InvoiceFormState>({
    number: "", code: "", date: "", amount: "", seller: "", buyer: "",
    status: "待报销", customer: "", due_date: "", file_path: "", tags: [], notes: "",
  });
  const [inboundEditor, setInboundEditor] = createSignal<{ mode: "create" } | { mode: "edit"; record: InboundRecord } | null>(null);
  const [inboundForm, setInboundForm] = createSignal<InboundFormState>({
    id: "", date: "", supplier: "", supplier_id: "", product_set: "", amount: "", notes: "", file_path: "",
  });
  const [deleteTarget, setDeleteTarget] = createSignal<{ kind: "invoice" | "inbound"; key: string; name: string; withFile: boolean } | null>(null);
  // v2.4.7（评审 P2）：本次弹窗内已归档但尚未保存的文件（工作区相对路径）——archiveFile 立即落盘，
  // 取消/查重拒绝会留下孤儿文件，关闭弹窗时提示可删除（最小实现：文案说明，不提供删除按钮）
  const [stagedArchive, setStagedArchive] = createSignal("");

  // —— 加载（seq 序号守卫，v2.4.x 范式：切工作区后丢弃过期请求返回）——
  let invoiceSeq = 0;
  let inboundSeq = 0;

  /** 批量探活归档文件（并发 ≤8）；存在性结果按 seq 守卫后才写入 */
  const checkFilesExistence = async (list: InvoiceRecord[], seq: number) => {
    const ws = currentWorkspace()?.path;
    if (!ws) return;
    const base = ws.replace(/\\/g, "/");
    const missing: Record<string, boolean> = {};
    const queue = list.map((r) => r.file_path);
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length > 0) {
        const rel = queue.shift()!;
        const res = await api.files.workspaceUrl(`${base}/${rel}`).catch(() => null);
        if (!res?.success) missing[rel] = true;
      }
    });
    await Promise.all(workers);
    if (seq !== invoiceSeq) return; // 已切到别的加载，过期结果丢弃
    setMissingFiles(missing);
  };

  const loadInvoices = async () => {
    const seq = ++invoiceSeq;
    const result = await api.invoices.list();
    if (seq !== invoiceSeq) return;
    if (result.success && result.data) {
      setInvoices(result.data);
      void checkFilesExistence(result.data, seq);
    }
  };

  const loadInbound = async () => {
    const seq = ++inboundSeq;
    const result = await api.inbound.list();
    if (seq !== inboundSeq) return;
    if (result.success && result.data) {
      setInboundRecords(result.data);
    }
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadProductSets();
      loadTagDefs();
      loadCustomers();
      loadSuppliers(); // v2.4.9 S2：入库单供应商下拉选项
      loadInvoices();
      loadInbound();
    }
  });

  // 深链：?dueSoon=1 → 进入即开启「30 天待办」筛选（仪表盘「发票待办」区块跳转，PLAN §4.3）
  createEffect(() => {
    const q = searchParams.dueSoon;
    if (q && typeof q === "string" && (q === "1" || q === "true")) setDueSoonOnly(true);
  });

  // —— 台账页内过滤（状态/客户/30 天待办/号码·开票方·购买方搜索）+ 合计 ——
  const filteredInvoices = () => {
    const s = statusFilter();
    const c = customerFilter();
    const d = dueSoonOnly();
    const q = query().trim().toLowerCase();
    return invoices().filter((r) => {
      if (s && r.status !== s) return false;
      if (c && r.customer !== c) return false;
      if (d && !isDueSoon(r)) return false;
      if (q && ![r.number, r.seller, r.buyer].some((v) => v.toLowerCase().includes(q))) return false;
      return true;
    });
  };
  const totalAmount = () =>
    filteredInvoices().reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0);

  const customerExists = (name: string) => customers().some((c) => c.name === name);

  // —— 状态流转（行内顺序「→」+ 下拉回退，均走 setStatus 单入口）——
  const handleSetStatus = async (number: string, status: InvoiceStatus) => {
    const r = await api.invoices.setStatus(number, status);
    if (r.success) {
      showToast("success", `发票 ${number} 已流转为「${status}」`);
      void loadInvoices();
    } else {
      showToast("error", "状态更新失败", r.error || "未知错误");
    }
  };

  // —— 删除（账物分离：默认只删记录；弹窗可选同时删文件 → 走回收站 file 单条目）——
  const requestDelete = (kind: "invoice" | "inbound", key: string, name: string) =>
    setDeleteTarget({ kind, key, name, withFile: false });

  const confirmDelete = async () => {
    const t = deleteTarget();
    if (!t) return;
    const r =
      t.kind === "invoice"
        ? await api.invoices.remove(t.key, { deleteFile: t.withFile })
        : await api.inbound.remove(t.key, { deleteFile: t.withFile });
    if (r.success) {
      setDeleteTarget(null);
      showToast("success", t.kind === "invoice" ? "发票记录已删除" : "入库单记录已删除");
      if (t.kind === "invoice") void loadInvoices();
      else void loadInbound();
    } else {
      showToast("error", "删除失败", r.error || "未知错误");
    }
  };

  // —— 文件预览（复用 FilePreviewModal；图片走 previewUrl 降采样副本，PDF 走 qihebox:// 协议）——
  const previewInvoiceFile = (rec: InvoiceRecord) => {
    const entry = fileEntryOf(rec.file_path);
    if (entry) openPreview(entry, { onDelete: () => void loadInvoices() });
  };
  const previewInboundFile = (rec: InboundRecord) => {
    const entry = fileEntryOf(rec.file_path);
    if (entry) openPreview(entry, { onDelete: () => void loadInbound() });
  };
  const previewRelPath = (relPath: string) => {
    const entry = fileEntryOf(relPath);
    if (entry) openPreview(entry, {});
  };

  // —— 台账 新建/编辑 ——
  const openInvoiceCreate = () => {
    setInvoiceForm({
      number: "", code: "", date: toDateKey(new Date()), amount: "", seller: "", buyer: "",
      status: "待报销", customer: "", due_date: "", file_path: "", tags: [], notes: "",
    });
    setInvoiceEditor({ mode: "create" });
  };
  const openInvoiceEdit = (rec: InvoiceRecord) => {
    setInvoiceForm({
      number: rec.number,
      code: rec.code ?? "",
      date: rec.date,
      amount: String(rec.amount),
      seller: rec.seller,
      buyer: rec.buyer,
      status: rec.status,
      customer: rec.customer ?? "",
      due_date: rec.due_date ?? "",
      file_path: rec.file_path,
      tags: rec.tags ?? [],
      notes: rec.notes ?? "",
    });
    setInvoiceEditor({ mode: "edit", record: rec });
  };

  const setInvoiceField = <K extends keyof InvoiceFormState>(key: K, value: InvoiceFormState[K]) =>
    setInvoiceForm((prev) => ({ ...prev, [key]: value }));

  /** 选本地文件 → archiveFile 归档（按开票日期年份）→ 以相对路径回填表单 */
  const pickInvoiceFile = async () => {
    const date = invoiceForm().date;
    if (!date) {
      showToast("info", "请先选择开票日期，再归档文件（归档目录按开票日期年份）");
      return;
    }
    const src = await api.dialog.openFile("选择发票文件", [{ displayName: "所有文件", pattern: "*" }]);
    if (!src) return;
    const r = await api.invoices.archiveFile(src, date);
    if (r.success && r.data) {
      setInvoiceField("file_path", r.data);
      // v2.4.7：记录本次归档，弹窗未保存关闭时提示可删除
      setStagedArchive(r.data);
    } else {
      showToast("error", "文件归档失败", r.error || "未知错误");
    }
  };

  /** 关闭新建/编辑弹窗：本次已归档未保存的文件提示可删除（取消或遮罩点击共用） */
  const closeInvoiceEditor = () => {
    const staged = stagedArchive();
    if (staged) {
      showToast("info", "刚归档的文件未保存为发票记录", `「${staged}」已落在 发票/<年份>/ 归档目录。如不需要，请到文件管理中删除该文件。`);
    }
    setStagedArchive("");
    setInvoiceEditor(null);
  };

  const saveInvoice = async () => {
    const editor = invoiceEditor();
    const f = invoiceForm();
    const number = f.number.trim();
    if (!number) {
      showToast("info", "发票号码不能为空");
      return;
    }
    if (!f.file_path) {
      showToast("info", "请先选择并归档发票文件");
      return;
    }
    if (!f.date) {
      showToast("info", "请选择开票日期");
      return;
    }
    if (f.amount.trim() === "") {
      showToast("info", "金额不能为空");
      return;
    }
    const amount = Number(f.amount);
    if (!Number.isFinite(amount)) {
      showToast("info", "金额无效");
      return;
    }
    if (!f.seller.trim()) {
      showToast("info", "开票方不能为空");
      return;
    }
    if (!f.buyer.trim()) {
      showToast("info", "购买方不能为空");
      return;
    }
    const common = {
      code: f.code.trim(),
      date: f.date,
      amount,
      seller: f.seller.trim(),
      buyer: f.buyer.trim(),
      status: f.status,
      customer: f.customer.trim(),
      due_date: f.due_date,
      tags: f.tags,
      notes: f.notes.trim(),
    };
    let result;
    if (editor?.mode === "edit") {
      const orig = editor.record;
      result = await api.invoices.update({
        number: orig.number,
        newNumber: number !== orig.number ? number : undefined,
        ...common,
        // 未换绑文件时缺省（undefined）→ core 保持原 file_path
        file_path: f.file_path !== orig.file_path ? f.file_path : undefined,
      });
    } else {
      result = await api.invoices.create({ ...common, number, file_path: f.file_path });
    }
    if (result.success) {
      setStagedArchive(""); // 已保存为记录，文件不再孤儿
      setInvoiceEditor(null);
      showToast("success", editor?.mode === "edit" ? "发票已更新" : "发票已登记");
      void loadInvoices();
    } else {
      showToast("error", "保存失败", result.error || "未知错误");
    }
  };

  // —— 入库单 新建/编辑 ——
  const openInboundCreate = () => {
    setInboundForm({
      id: "", date: toDateKey(new Date()), supplier: "", supplier_id: "", product_set: "",
      amount: "", notes: "", file_path: "",
    });
    setInboundEditor({ mode: "create" });
  };
  const openInboundEdit = (rec: InboundRecord) => {
    setInboundForm({
      id: rec.id,
      date: rec.date,
      supplier: rec.supplier,
      supplier_id: rec.supplier_id ?? "",
      product_set: rec.product_set ?? "",
      amount: rec.amount !== undefined ? String(rec.amount) : "",
      notes: rec.notes ?? "",
      file_path: rec.file_path,
    });
    setInboundEditor({ mode: "edit", record: rec });
  };

  const setInboundField = <K extends keyof InboundFormState>(key: K, value: InboundFormState[K]) =>
    setInboundForm((prev) => ({ ...prev, [key]: value }));

  const pickInboundFile = async () => {
    const date = inboundForm().date;
    if (!date) {
      showToast("info", "请先选择入库日期，再归档文件（归档目录按入库日期年份）");
      return;
    }
    const src = await api.dialog.openFile("选择入库文件", [{ displayName: "所有文件", pattern: "*" }]);
    if (!src) return;
    const r = await api.inbound.archiveFile(src, date);
    if (r.success && r.data) {
      setInboundField("file_path", r.data);
      // v2.4.7：记录本次归档，弹窗未保存关闭时提示可删除
      setStagedArchive(r.data);
    } else {
      showToast("error", "文件归档失败", r.error || "未知错误");
    }
  };

  /** 关闭新建/编辑弹窗：本次已归档未保存的文件提示可删除（取消或遮罩点击共用） */
  const closeInboundEditor = () => {
    const staged = stagedArchive();
    if (staged) {
      showToast("info", "刚归档的文件未保存为入库单", `「${staged}」已落在 入库/<年份>/ 归档目录。如不需要，请到文件管理中删除该文件。`);
    }
    setStagedArchive("");
    setInboundEditor(null);
  };

  const saveInbound = async () => {
    const editor = inboundEditor();
    const f = inboundForm();
    if (!f.id.trim()) {
      showToast("info", "单据编号不能为空");
      return;
    }
    if (!f.file_path) {
      showToast("info", "请先选择并归档入库文件");
      return;
    }
    if (!f.date) {
      showToast("info", "请选择入库日期");
      return;
    }
    if (!f.supplier.trim()) {
      showToast("info", "供应商不能为空");
      return;
    }
    const req: InboundCreateRequest = {
      id: f.id.trim(),
      date: f.date,
      supplier: f.supplier.trim(),
      supplier_id: f.supplier_id.trim() || undefined,
      product_set: f.product_set.trim() || undefined,
      file_path: f.file_path,
      amount: f.amount.trim() !== "" ? Number(f.amount) : undefined,
      notes: f.notes.trim() || undefined,
    };
    const result = editor?.mode === "edit" ? await api.inbound.update(editor.record.id, req) : await api.inbound.create(req);
    if (result.success) {
      setStagedArchive(""); // 已保存为记录，文件不再孤儿
      setInboundEditor(null);
      showToast("success", editor?.mode === "edit" ? "入库单已更新" : "入库单已登记");
      void loadInbound();
    } else {
      showToast("error", "保存失败", result.error || "未知错误");
    }
  };

  // —— 导出（筛选结果导出，PLAN §6.5：合计行与导出同为筛选结果口径）——
  const handleExport = async () => {
    const records = filteredInvoices();
    if (records.length === 0) {
      showToast("info", "没有可导出的记录");
      return;
    }
    const path = await api.dialog.saveFile("导出发票台账", `发票台账_${toDateKey(new Date())}.xlsx`);
    if (!path) return;
    const r = await api.invoices.exportXlsx(path, records);
    if (r.success) {
      showToast("success", "Excel 台账已导出");
    } else {
      showToast("error", "导出失败", r.error || "未知错误");
    }
  };

  return (
    <div class="p-6 max-w-7xl mx-auto flex flex-col h-full">
      <div class="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">发票管理</h1>
          <p class="text-surface-500 mt-1">发票台账与入库归档</p>
        </div>
        <div class="flex bg-surface-100 rounded-lg p-1">
          <button
            class={`px-4 py-2 text-sm rounded-md transition-colors ${tab() === "invoices" ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500 hover:text-surface-700"}`}
            onClick={() => setTab("invoices")}
          >
            🧾 发票台账
          </button>
          <button
            class={`px-4 py-2 text-sm rounded-md transition-colors ${tab() === "inbound" ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500 hover:text-surface-700"}`}
            onClick={() => setTab("inbound")}
          >
            📥 入库单
          </button>
        </div>
      </div>

      {/* ============ 台账 Tab ============ */}
      <Show when={tab() === "invoices"}>
        <div class="flex flex-col md:flex-row gap-3 mb-4 shrink-0">
          <input
            type="text"
            class="flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm"
            placeholder="搜索发票号码 / 开票方 / 购买方..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <select
            class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
            value={statusFilter()}
            onChange={(e) => setStatusFilter(e.currentTarget.value)}
          >
            <option value="">全部状态</option>
            <For each={STATUSES}>
              {(s) => <option value={s}>{s}</option>}
            </For>
          </select>
          <select
            class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
            value={customerFilter()}
            onChange={(e) => setCustomerFilter(e.currentTarget.value)}
          >
            <option value="">全部客户</option>
            <For each={customers()}>
              {(c) => <option value={c.name}>{c.name}</option>}
            </For>
          </select>
          <select
            class="px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
            value={dueSoonOnly() ? "1" : ""}
            onChange={(e) => setDueSoonOnly(e.currentTarget.value === "1")}
          >
            <option value="">全部待办</option>
            <option value="1">⏰ 仅 30 天待办</option>
          </select>
        </div>

        <Show when={invoices().length === 0} fallback={
          <div class="flex-1 min-h-0 flex flex-col">
            <div class="card p-2 flex flex-col flex-1 min-h-0">
              <div class="flex items-center justify-between px-3 py-2 shrink-0">
                <span class="text-sm text-surface-500">
                  共 {filteredInvoices().length} 条 · 金额合计
                  <span class="font-medium text-surface-900"> ¥{fmtMoney(totalAmount())}</span>
                </span>
                <div class="flex gap-2">
                  <button class="btn-secondary text-sm" onClick={() => void handleExport()}>
                    📊 导出 Excel
                  </button>
                  <button class="btn-primary text-sm" onClick={openInvoiceCreate}>
                    <span>➕</span> 新建发票
                  </button>
                </div>
              </div>

              <Show when={filteredInvoices().length === 0} fallback={
                <>
                  <div
                    class="px-3 py-2 text-xs text-surface-400 grid items-center gap-2 shrink-0"
                    style={{ "grid-template-columns": INVOICE_COL_TEMPLATE }}
                  >
                    <span>号码</span>
                    <span>日期</span>
                    <span>开票方</span>
                    <span>购买方</span>
                    <span class="text-right">金额</span>
                    <span>状态</span>
                    <span>客户</span>
                    <span>待办日期</span>
                    <span class="text-right">操作</span>
                  </div>
                  <div class="flex-1 min-h-0">
                    <VirtualGrid
                      items={filteredInvoices()}
                      itemHeight={48}
                      columns={1}
                      gap={8}
                      // v2.4.7（评审 P2）：筛选/搜索变化时滚动归零（VirtualGrid scrollResetKey 约定）
                      scrollResetKey={`${statusFilter()}|${customerFilter()}|${dueSoonOnly()}|${query()}`}
                      renderItem={(rec) => (
                        <div
                          class={`px-3 py-2 rounded-lg grid items-center gap-2 text-sm transition-colors hover:bg-surface-50 ${missingFiles()[rec.file_path] ? "opacity-60" : ""}`}
                          style={{ "grid-template-columns": INVOICE_COL_TEMPLATE }}
                        >
                          <span class="font-medium text-surface-900 truncate min-w-0" title={rec.file_path}>
                            {rec.number}
                          </span>
                          <span class="text-surface-500 truncate min-w-0">{rec.date}</span>
                          <span class="truncate min-w-0">{rec.seller}</span>
                          <span class="truncate min-w-0">{rec.buyer}</span>
                          <span class="text-right tabular-nums text-surface-900">{fmtMoney(rec.amount)}</span>
                          <div class="flex items-center gap-1 min-w-0">
                            <span class={`text-xs px-2 py-0.5 rounded-full shrink-0 ${statusChipClass(rec.status)}`}>
                              {rec.status}
                            </span>
                            <Show when={rec.status !== "已入账"}>
                              <button
                                class="text-primary-600 hover:text-primary-700 text-xs shrink-0 px-0.5"
                                title={`流转为「${nextStatusOf(rec.status)}」`}
                                onClick={() => void handleSetStatus(rec.number, nextStatusOf(rec.status))}
                              >
                                →
                              </button>
                            </Show>
                            <select
                              class="text-xs border border-surface-200 rounded bg-white text-surface-600 shrink-0"
                              value={rec.status}
                              title="直接选择状态（可回退）"
                              onChange={(e) => void handleSetStatus(rec.number, e.currentTarget.value as InvoiceStatus)}
                            >
                              <For each={STATUSES}>
                                {(s) => <option value={s}>{s}</option>}
                              </For>
                            </select>
                          </div>
                          <div class="min-w-0">
                            <Show when={rec.customer} fallback={<span class="text-surface-300">-</span>}>
                              {(name) => (
                                <button
                                  class={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                                    customerExists(name())
                                      ? "bg-surface-100 text-surface-700 hover:bg-primary-50 hover:text-primary-700"
                                      : "bg-surface-50 text-surface-400"
                                  }`}
                                  title={customerExists(name()) ? "前往客户详情" : "客户已删除（字面值保留）"}
                                  onClick={() => {
                                    if (customerExists(name())) navigate(`/clients/${encodeURIComponent(name())}`);
                                  }}
                                >
                                  {name()}
                                </button>
                              )}
                            </Show>
                          </div>
                          <div class="flex items-center gap-1 min-w-0">
                            <span class="truncate text-surface-600 min-w-0">{rec.due_date || "-"}</span>
                            <Show when={isDueSoon(rec)}>
                              <span class="text-red-500 shrink-0" title="30 天内待办">⏰</span>
                            </Show>
                          </div>
                          <div class="flex items-center justify-end gap-1.5 min-w-0">
                            <Show when={missingFiles()[rec.file_path]}>
                              <span class="text-xs text-red-600 shrink-0" title="归档文件已缺失（不影响记录）">文件缺失</span>
                            </Show>
                            <button class="text-surface-400 hover:text-primary-600 text-sm shrink-0" title="预览文件" onClick={() => previewInvoiceFile(rec)}>
                              👁
                            </button>
                            <button class="text-surface-400 hover:text-primary-600 text-sm shrink-0" title="编辑" onClick={() => openInvoiceEdit(rec)}>
                              ✏️
                            </button>
                            <button class="text-surface-400 hover:text-red-500 text-sm shrink-0" title="删除" onClick={() => requestDelete("invoice", rec.number, rec.number)}>
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
                  <EmptyState icon="🧾" title="没有匹配的发票" desc="调整筛选条件或点击「新建发票」登记" />
                </div>
              </Show>
            </div>
          </div>
        }>
          <div class="flex-1 flex items-center justify-center">
            <EmptyState icon="🧾" title="暂无发票" desc="点击「新建发票」登记第一张发票">
              <button class="btn-primary" onClick={openInvoiceCreate}>新建发票</button>
            </EmptyState>
          </div>
        </Show>
      </Show>

      {/* ============ 入库单 Tab ============ */}
      <Show when={tab() === "inbound"}>
        <Show when={inboundRecords().length === 0} fallback={
          <div class="flex-1 min-h-0 flex flex-col">
            <div class="card p-2 flex flex-col flex-1 min-h-0">
              <div class="flex items-center justify-between px-3 py-2 shrink-0">
                <span class="text-sm text-surface-500">共 {inboundRecords().length} 条入库单</span>
                <button class="btn-primary text-sm" onClick={openInboundCreate}>
                  <span>➕</span> 新建入库单
                </button>
              </div>
              <div
                class="px-3 py-2 text-xs text-surface-400 grid items-center gap-2 shrink-0"
                style={{ "grid-template-columns": INBOUND_COL_TEMPLATE }}
              >
                <span>单据编号</span>
                <span>日期</span>
                <span>供应商</span>
                <span>关联产品集</span>
                <span class="text-right">金额</span>
                <span>备注</span>
                <span class="text-right">操作</span>
              </div>
              <div class="flex-1 min-h-0">
                <VirtualGrid
                  items={inboundRecords()}
                  itemHeight={48}
                  columns={1}
                  gap={8}
                  renderItem={(rec) => (
                    <div
                      class="px-3 py-2 rounded-lg grid items-center gap-2 text-sm transition-colors hover:bg-surface-50"
                      style={{ "grid-template-columns": INBOUND_COL_TEMPLATE }}
                    >
                      <span class="font-medium text-surface-900 truncate min-w-0" title={rec.file_path}>{rec.id}</span>
                      <span class="text-surface-500 truncate min-w-0">{rec.date}</span>
                      {/* v2.4.9 S2：供应商已删除 → 灰显占位（字面值保留，不可选但显示名称，同客户删除后灰显范式） */}
                      <Show when={rec.supplier_id && !suppliers().some((s) => s.name === rec.supplier_id)} fallback={<span class="truncate min-w-0">{rec.supplier}</span>}>
                        <span class="truncate min-w-0 text-surface-300" title="供应商已删除，名称仅作记录保留">
                          {rec.supplier}
                        </span>
                      </Show>
                      <div class="min-w-0">
                        <Show when={rec.product_set} fallback={<span class="text-surface-300">-</span>}>
                          {(name) => (
                            <button
                              class="text-xs px-2 py-0.5 rounded-full bg-surface-100 text-surface-700 hover:bg-primary-50 hover:text-primary-700 transition-colors"
                              title="前往产品集"
                              onClick={() => navigate(`/product-sets/${encodeURIComponent(name())}`)}
                            >
                              {name()}
                            </button>
                          )}
                        </Show>
                      </div>
                      <span class="text-right tabular-nums text-surface-900">
                        {rec.amount !== undefined ? fmtMoney(rec.amount) : "-"}
                      </span>
                      <span class="truncate min-w-0 text-surface-500">{rec.notes || "-"}</span>
                      <div class="flex items-center justify-end gap-1.5 min-w-0">
                        <button class="text-surface-400 hover:text-primary-600 text-sm shrink-0" title="预览文件" onClick={() => previewInboundFile(rec)}>
                          👁
                        </button>
                        <button class="text-surface-400 hover:text-primary-600 text-sm shrink-0" title="编辑" onClick={() => openInboundEdit(rec)}>
                          ✏️
                        </button>
                        <button class="text-surface-400 hover:text-red-500 text-sm shrink-0" title="删除" onClick={() => requestDelete("inbound", rec.id, rec.id)}>
                          🗑️
                        </button>
                      </div>
                    </div>
                  )}
                />
              </div>
            </div>
          </div>
        }>
          <div class="flex-1 flex items-center justify-center">
            <EmptyState icon="📥" title="暂无入库单" desc="点击「新建入库单」登记第一条记录">
              <button class="btn-primary" onClick={openInboundCreate}>新建入库单</button>
            </EmptyState>
          </div>
        </Show>
      </Show>

      {/* ============ 发票 新建/编辑 弹窗 ============ */}
      <Show when={invoiceEditor()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={closeInvoiceEditor}>
          <div
            class="bg-white rounded-2xl w-full max-w-2xl p-6 shadow-xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="text-xl font-bold mb-4">{invoiceEditor()?.mode === "edit" ? "编辑发票" : "新建发票"}</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">发票号码 *</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：25312000000012345678"
                  value={invoiceForm().number}
                  onInput={(e) => setInvoiceField("number", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">发票代码</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="数电票可留空"
                  value={invoiceForm().code}
                  onInput={(e) => setInvoiceField("code", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">开票日期 *</label>
                <DatePicker
                  value={invoiceForm().date}
                  onChange={(d) => setInvoiceField("date", d)}
                  placeholder="选择开票日期"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">金额（价税合计，元）*</label>
                <input
                  type="number"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：1250.50"
                  value={invoiceForm().amount}
                  onInput={(e) => setInvoiceField("amount", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">开票方 *</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="销售方名称"
                  value={invoiceForm().seller}
                  onInput={(e) => setInvoiceField("seller", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">购买方抬头 *</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="购买方名称"
                  value={invoiceForm().buyer}
                  onInput={(e) => setInvoiceField("buyer", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">状态</label>
                <select
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg bg-white text-sm"
                  value={invoiceForm().status}
                  onChange={(e) => setInvoiceField("status", e.currentTarget.value as InvoiceStatus)}
                >
                  <For each={STATUSES}>
                    {(s) => <option value={s}>{s}</option>}
                  </For>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">关联客户</label>
                <select
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg bg-white text-sm"
                  value={invoiceForm().customer}
                  onChange={(e) => setInvoiceField("customer", e.currentTarget.value)}
                >
                  <option value="">不关联客户</option>
                  <For each={customers()}>
                    {(c) => <option value={c.name}>{c.name}</option>}
                  </For>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">待办日期</label>
                <DatePicker
                  value={invoiceForm().due_date}
                  onChange={(d) => setInvoiceField("due_date", d)}
                  placeholder="认证抵扣期 / 报销截止"
                />
              </div>
            </div>
            <div class="mt-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">标签</label>
              <TagInput
                value={invoiceForm().tags}
                onChange={(t) => setInvoiceField("tags", t)}
                options={tagList()}
                placeholder="输入标签按回车"
              />
            </div>
            <div class="mt-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
              <textarea
                class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                rows={2}
                placeholder="添加备注..."
                value={invoiceForm().notes}
                onInput={(e) => setInvoiceField("notes", e.currentTarget.value)}
              />
            </div>
            <div class="mt-4">
              <ArchiveField
                label="发票文件 *（归档至 发票/&lt;年份&gt;/）"
                filePath={invoiceForm().file_path}
                missing={!!invoiceForm().file_path && missingFiles()[invoiceForm().file_path]}
                onPick={() => void pickInvoiceFile()}
                onPreview={() => invoiceForm().file_path && previewRelPath(invoiceForm().file_path)}
              />
            </div>
            <div class="flex gap-3 justify-end mt-6">
              <button class="btn-secondary" onClick={closeInvoiceEditor}>取消</button>
              <button class="btn-primary" onClick={() => void saveInvoice()}>
                {invoiceEditor()?.mode === "edit" ? "保存" : "确认登记"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* ============ 入库单 新建/编辑 弹窗 ============ */}
      <Show when={inboundEditor()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={closeInboundEditor}>
          <div
            class="bg-white rounded-2xl w-full max-w-2xl p-6 shadow-xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="text-xl font-bold mb-4">{inboundEditor()?.mode === "edit" ? "编辑入库单" : "新建入库单"}</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">单据编号 *</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="如：RK-2026-001"
                  value={inboundForm().id}
                  onInput={(e) => setInboundField("id", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">入库日期 *</label>
                <DatePicker
                  value={inboundForm().date}
                  onChange={(d) => setInboundField("date", d)}
                  placeholder="选择入库日期"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">供应商 *</label>
                {/* v2.4.9 S2：供应商下拉（选项来自 suppliers store；选择时填 supplier 为名 + supplier_id 为名）。
                    兼容手输：下方自由文本输入保留；手输时清空 supplier_id 关联。 */}
                <select
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg bg-white text-sm mb-2"
                  value={inboundForm().supplier_id}
                  onChange={(e) => {
                    const name = e.currentTarget.value;
                    setInboundField("supplier", name);
                    setInboundField("supplier_id", name);
                  }}
                >
                  <option value="">手输 / 不关联已有供应商</option>
                  <For each={suppliers()}>
                    {(s) => <option value={s.name}>{s.name}</option>}
                  </For>
                  {/* 供应商已删除的旧单：supplier_id 字面值保留，灰显占位（不可选） */}
                  <Show when={inboundForm().supplier_id && !suppliers().some((s) => s.name === inboundForm().supplier_id)}>
                    <option value={inboundForm().supplier_id} disabled class="text-surface-400">
                      {inboundForm().supplier_id}（已删除）
                    </option>
                  </Show>
                </select>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="供应商名称"
                  value={inboundForm().supplier}
                  onInput={(e) => {
                    setInboundField("supplier", e.currentTarget.value);
                    // 手输时清空 supplier_id（仅下拉选择建立关联；重命名/删除旧值不再误绑）
                    setInboundField("supplier_id", "");
                  }}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">关联产品集</label>
                <select
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg bg-white text-sm"
                  value={inboundForm().product_set}
                  onChange={(e) => setInboundField("product_set", e.currentTarget.value)}
                >
                  <option value="">不关联产品集</option>
                  <For each={productSets()}>
                    {(ps) => <option value={ps.name}>{ps.name}</option>}
                  </For>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">金额合计（元）</label>
                <input
                  type="number"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="仅展示，不进计算"
                  value={inboundForm().amount}
                  onInput={(e) => setInboundField("amount", e.currentTarget.value)}
                />
              </div>
            </div>
            <div class="mt-4">
              <label class="block text-sm font-medium text-surface-700 mb-1">备注</label>
              <textarea
                class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                rows={2}
                placeholder="添加备注..."
                value={inboundForm().notes}
                onInput={(e) => setInboundField("notes", e.currentTarget.value)}
              />
            </div>
            <div class="mt-4">
              <ArchiveField
                label="入库文件 *（归档至 入库/&lt;年份&gt;/）"
                filePath={inboundForm().file_path}
                missing={!!inboundForm().file_path && missingFiles()[inboundForm().file_path]}
                onPick={() => void pickInboundFile()}
                onPreview={() => inboundForm().file_path && previewRelPath(inboundForm().file_path)}
              />
            </div>
            <div class="flex gap-3 justify-end mt-6">
              <button class="btn-secondary" onClick={closeInboundEditor}>取消</button>
              <button class="btn-primary" onClick={() => void saveInbound()}>
                {inboundEditor()?.mode === "edit" ? "保存" : "确认登记"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* ============ 删除确认（账物分离：默认只删记录） ============ */}
      <Show when={deleteTarget()}>
        {(t) => (
          <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setDeleteTarget(null)}>
            <div class="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <h3 class="text-lg font-semibold mb-2">
                删除{t().kind === "invoice" ? "发票" : "入库单"}记录
              </h3>
              <p class="text-sm text-surface-600 mb-4">
                确定删除「{t().name}」的{t().kind === "invoice" ? "发票台账" : "入库单"}记录吗？
                账物分离：删除记录不影响归档文件。
              </p>
              <label class="flex items-center gap-2 text-sm text-surface-700 mb-6 cursor-pointer">
                <input
                  type="checkbox"
                  class="w-4 h-4 accent-red-600"
                  checked={t().withFile}
                  onChange={() => setDeleteTarget((p) => (p ? { ...p, withFile: !p.withFile } : p))}
                />
                同时删除归档文件（移入回收站）
              </label>
              <div class="flex gap-3 justify-end">
                <button class="btn-secondary" onClick={() => setDeleteTarget(null)}>取消</button>
                <button
                  class="inline-flex items-center justify-center gap-2 px-4 py-2 bg-red-500 text-white font-medium rounded-lg transition-all duration-200 hover:bg-red-600 active:scale-95"
                  onClick={() => void confirmDelete()}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
