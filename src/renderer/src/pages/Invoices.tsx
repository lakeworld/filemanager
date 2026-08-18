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
import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { useSearchParams, useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace, productSets, loadProductSets } from "~/stores/workspace";
// v2.4.7：关联客户下拉消费 clients store（单一数据源，与 Clients 页同源；PLAN §6.5）
import { customers, loadCustomers } from "~/stores/clients";
// v2.4.9 S2：供应商下拉（入库单供应商选择，选项来自 suppliers store）
import { suppliers, loadSuppliers } from "~/stores/suppliers";
import { openPreview } from "~/stores/preview";
import {
  STATUSES,
  isDueSoon,
  nextStatusOf,
  statusChipClass,
  toDateKey,
  fmtMoney,
  baseNameOf,
  fileTypeOf,
  INVOICE_COL_TEMPLATE,
  INBOUND_COL_TEMPLATE,
} from "./invoices/utils";
import ArchiveField from "./invoices/ArchiveField";
import InvoiceEditorModal from "./invoices/InvoiceEditorModal";
import InboundEditorModal from "./invoices/InboundEditorModal";
import InvoiceTable from "./invoices/InvoiceTable";
import InboundTable from "./invoices/InboundTable";
import InvoiceToolbar from "./invoices/InvoiceToolbar";
import DeleteRecordModal from "./invoices/DeleteRecordModal";
import { loadTagDefs, tagList } from "~/stores/tags";
import { showToast } from "~/stores/notifyBanner";
import DatePicker from "~/components/DatePicker";
import TagInput from "~/components/TagInput";
import VirtualGrid from "~/components/VirtualGrid";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import type { InvoiceRecord, InboundRecord, FileEntry } from "~/types";
import type { InvoiceFormState, InboundFormState } from "./invoices/types";

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


/** 台账记录 file_path（工作区相对路径）→ FileEntry，供 openPreview 复用（账物分离：文件缺失时预览会失败并提示） */
function fileEntryOf(relPath: string): FileEntry | null {
  const ws = currentWorkspace()?.path;
  if (!ws) return null;
  return {
    name: baseNameOf(relPath),
    path: `${ws.replace(/\\/g, "/")}/${relPath}`,
    size: 0,
    modified: "",
    file_type: fileTypeOf(relPath),
    thumbnail_path: null,
  };
}

// v2.5.3（P2-12）：加载序号模块级（照 Images imageLoadSeq 先例）——卸载清理递增后跨挂载延续计数，
// 重新挂载不再从 0 计数：旧实例在途链持有的旧值永远不会与新实例的计数撞号，过期结果必被丢弃
let invoiceLoadSeq = 0;
let inboundLoadSeq = 0;

export default function Invoices() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // —— 双 Tab ——
  const [tab, setTab] = createSignal<"invoices" | "inbound">("invoices");

  // —— 台账 ——
  const [invoices, setInvoices] = createSignal<InvoiceRecord[]>([]);
  // v2.5.2：首载 loading——空态不闪现（照 FileBrowserView 先例）
  const [loading, setLoading] = createSignal(true);
  // 文件缺失表：file_path → 不存在（账物分离灰显）
  const [missingFiles, setMissingFiles] = createSignal<Record<string, boolean>>({});
  const [statusFilter, setStatusFilter] = createSignal("");
  const [customerFilter, setCustomerFilter] = createSignal("");
  const [dueSoonOnly, setDueSoonOnly] = createSignal(false);
  const [query, setQuery] = createSignal("");

  // —— 入库单 ——
  const [inboundRecords, setInboundRecords] = createSignal<InboundRecord[]>([]);
  // v2.5.3（P2-6）：入库单 tab 首载 loading——空态不闪现（照同页发票 tab loading 先例）
  const [inboundLoading, setInboundLoading] = createSignal(true);

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
  // v2.5.3（P2-10）：保存中——发票/入库单弹窗共用（一次只开一个弹窗），按钮 disabled + handler 入口守卫防连点双创建
  const [saving, setSaving] = createSignal(false);
  // v2.4.7（评审 P2）：本次弹窗内已归档但尚未保存的文件（工作区相对路径）——archiveFile 立即落盘，
  // 取消/查重拒绝会留下孤儿文件，关闭弹窗时提示可删除（最小实现：文案说明，不提供删除按钮）
  const [stagedArchive, setStagedArchive] = createSignal("");

  // —— 加载（seq 序号守卫，v2.4.x 范式：切工作区后丢弃过期请求返回）——
  // v2.5.3（P2-12）：序号本体模块级（invoiceLoadSeq/inboundLoadSeq），onCleanup 递增防跨挂载撞号
  onCleanup(() => {
    invoiceLoadSeq++;
    inboundLoadSeq++;
  });

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
    if (seq !== invoiceLoadSeq) return; // 已切到别的加载，过期结果丢弃
    setMissingFiles(missing);
  };

  const loadInvoices = async () => {
    const seq = ++invoiceLoadSeq;
    setLoading(true);
    try {
      const result = await api.invoices.list();
      if (seq !== invoiceLoadSeq) return;
      if (result.success && result.data) {
        setInvoices(result.data);
        void checkFilesExistence(result.data, seq);
      }
    } finally {
      // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
      if (seq === invoiceLoadSeq) setLoading(false);
    }
  };

  const loadInbound = async () => {
    const seq = ++inboundLoadSeq;
    setInboundLoading(true);
    try {
      const result = await api.inbound.list();
      if (seq !== inboundLoadSeq) return;
      if (result.success && result.data) {
        setInboundRecords(result.data);
      }
    } finally {
      // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
      if (seq === inboundLoadSeq) setInboundLoading(false);
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
    if (saving()) return; // 连点守卫（P2-10）
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
    setSaving(true);
    try {
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
    } finally {
      setSaving(false);
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
    if (saving()) return; // 连点守卫（P2-10）
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
    setSaving(true);
    try {
      const result = editor?.mode === "edit" ? await api.inbound.update(editor.record.id, req) : await api.inbound.create(req);
      if (result.success) {
        setStagedArchive(""); // 已保存为记录，文件不再孤儿
        setInboundEditor(null);
        showToast("success", editor?.mode === "edit" ? "入库单已更新" : "入库单已登记");
        void loadInbound();
      } else {
        showToast("error", "保存失败", result.error || "未知错误");
      }
    } finally {
      setSaving(false);
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
        <InvoiceToolbar
          query={query()}
          statusFilter={statusFilter()}
          customerFilter={customerFilter()}
          dueSoonOnly={dueSoonOnly()}
          onQuery={setQuery}
          onStatusFilter={setStatusFilter}
          onCustomerFilter={setCustomerFilter}
          onDueSoonOnly={setDueSoonOnly}
          customers={customers()}
        />

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

              <InvoiceTable
                rows={filteredInvoices()}
                missing={missingFiles()}
                customerExists={customerExists}
                onSetStatus={(number, status) => void handleSetStatus(number, status)}
                onPreview={previewInvoiceFile}
                onEdit={openInvoiceEdit}
                onDelete={(rec) => requestDelete("invoice", rec.number, rec.number)}
                scrollResetKey={`${statusFilter()}|${customerFilter()}|${dueSoonOnly()}|${query()}`}
              />
            </div>
          </div>
        }>
          <div class="flex-1 flex items-center justify-center">
            {/* v2.5.2：首载 loading 兜底，空态不闪现 */}
            <Show when={!loading()} fallback={<Loading text="发票加载中…" />}>
              <EmptyState icon="🧾" title="暂无发票" desc="点击「新建发票」登记第一张发票">
                <button class="btn-primary" onClick={openInvoiceCreate}>新建发票</button>
              </EmptyState>
            </Show>
          </div>
        </Show>
      </Show>

      {/* ============ 入库单 Tab ============ */}
      <Show when={tab() === "inbound"}>
        <InboundTable
          rows={inboundRecords()}
          suppliers={suppliers()}
          loading={inboundLoading()}
          onCreate={openInboundCreate}
          onPreview={previewInboundFile}
          onEdit={openInboundEdit}
          onDelete={(rec) => requestDelete("inbound", rec.id, rec.id)}
        />
      </Show>

      {/* ============ 发票 新建/编辑 弹窗 ============ */}
      <InvoiceEditorModal
        editor={invoiceEditor()}
        form={invoiceForm()}
        setField={setInvoiceField}
        saving={saving()}
        onClose={closeInvoiceEditor}
        onSave={() => void saveInvoice()}
        onPickFile={pickInvoiceFile}
        onPreviewFile={() => invoiceForm().file_path && previewRelPath(invoiceForm().file_path)}
        missing={missingFiles()}
        customers={customers()}
        tagOptions={tagList()}
      />
      <InboundEditorModal
        editor={inboundEditor()}
        form={inboundForm()}
        setField={setInboundField}
        saving={saving()}
        onClose={closeInboundEditor}
        onSave={() => void saveInbound()}
        onPickFile={pickInboundFile}
        onPreviewFile={() => inboundForm().file_path && previewRelPath(inboundForm().file_path)}
        missing={missingFiles()}
        suppliers={suppliers()}
        productSets={productSets()}
      />
      <DeleteRecordModal
        target={deleteTarget()}
        onToggleWithFile={() => setDeleteTarget((p) => (p ? { ...p, withFile: !p.withFile } : p))}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
