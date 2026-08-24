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
import ConfirmDialog from "~/components/ConfirmDialog"; // v2.5.5（B1-B）：脏守卫「放弃未保存内容？」二次确认（应用内样式化，禁用 window.confirm）
import { loadTagDefs, tagList } from "~/stores/tags";
import { prefillVersion, currentPrefill, advancePrefill, clearPrefill, currentEditPrefill, clearEditPrefill } from "~/stores/createPrefill";
import { normalizePrefill } from "~/stores/createPrefillNormalize";
import type { InvoicePrefill, InboundPrefill } from "~/stores/createPrefillNormalize";
import { callPlugin, pluginGlobalCommands } from "~/plugins/registry";
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

/** v2.5.4（Task 4）：识别流开票日期缺失时，按源文件 mtime 兜底 YYYY-MM-DD（stat 失败返回空串） */
async function dateFromFileMtime(sourcePath: string): Promise<string> {
  try {
    const st = await api.files.statPath(sourcePath);
    if (st.success && st.data && Number.isFinite(st.data.mtime)) return toDateKey(new Date(st.data.mtime));
  } catch {
    /* 忽略：stat 失败由调用方回退提示 */
  }
  return "";
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
  // v2.4.7（评审 P2）：本次弹窗内已选文件但尚未保存的待归档源（B1 P0 归档后移——选文件只暂存，
  // 保存回调里才 archiveFile 落盘；取消/遮罩/Esc 零落盘）。date = 归档年份口径的日期（手动/入库流=表单日期）。
  const [stagedArchive, setStagedArchive] = createSignal<{ sourcePath: string; date: string } | null>(null);
  // v2.5.4（Task 4 修订；B1 P0 归档后移）：识别到的源路径+识别日期（待保存时归档），不再含 archivedRel——
  // 识别成功不落盘，保存回调里才 archiveFile；重复识别只是替换暂存源，不再产生副本
  const [stagedIdentifySource, setStagedIdentifySource] = createSignal<{
    sourcePath: string;
    fileName: string;
    date: string;
  } | null>(null);
  const [identifying, setIdentifying] = createSignal(false);
  const [identifyWarnings, setIdentifyWarnings] = createSignal<string[]>([]);
  // —— v2.5.5（B1 任务 B）：脏守卫初始快照——弹窗打开时的表单初值，判断「相对打开是否有改动」 ——
  const [invoiceFormSnapshot, setInvoiceFormSnapshot] = createSignal<InvoiceFormState | null>(null);
  const [inboundFormSnapshot, setInboundFormSnapshot] = createSignal<InboundFormState | null>(null);
  // 脏守卫确认目标（发票/入库 共用；一次只开一个编辑器弹窗）：null = 无待确认
  const [discardTarget, setDiscardTarget] = createSignal<"invoice" | "inbound" | null>(null);

  // —— v2.5.4 预填消费（PLAN-v2.5.4 §3.4）：版本变化 → 切 tab + seed 表单 + 开新建弹窗；只开不关 ——
  createEffect(() => {
    prefillVersion("invoice");
    const cur = currentPrefill("invoice") as InvoicePrefill | null;
    if (!cur) return;
    setStagedIdentifySource(null); // v2.5.4：新预填/新建前清识别暂存
    setIdentifyWarnings([]);
    const seeded: InvoiceFormState = {
      number: cur.number ?? "", code: cur.code ?? "",
      date: cur.date ?? toDateKey(new Date()),
      amount: cur.amount != null ? String(cur.amount) : "",
      seller: cur.seller ?? "", buyer: cur.buyer ?? "",
      status: "待报销", customer: cur.customer ?? "", due_date: cur.due_date ?? "",
      file_path: cur.file_path ?? "", tags: cur.tags ?? [], notes: cur.notes ?? "",
    };
    setInvoiceForm(seeded);
    setInvoiceFormSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照（预填即基准）
    setTab("invoices");
    setInvoiceEditor({ mode: "create" });
  });
  createEffect(() => {
    prefillVersion("inbound");
    const cur = currentPrefill("inbound") as InboundPrefill | null;
    if (!cur) return;
    const seededInbound: InboundFormState = {
      id: cur.id ?? "", date: cur.date ?? toDateKey(new Date()),
      supplier: cur.supplier ?? "", supplier_id: cur.supplier_id ?? "",
      product_set: cur.product_set ?? "",
      amount: cur.amount != null ? String(cur.amount) : "",
      notes: cur.notes ?? "", file_path: cur.file_path ?? "",
    };
    setInboundForm(seededInbound);
    setInboundFormSnapshot(seededInbound); // v2.5.5（B1-B）：脏守卫初始快照
    setTab("inbound");
    setInboundEditor({ mode: "create" });
  });
  // —— v2.5.4（弹一 C-6）：编辑预填消费（单条制）——key=发票号/入库 id → 建议改动合并到记录后开编辑弹窗 ——
  // loading 门控防竞态；已加载仍未找到 = key 不存在 → 清空忽略。
  createEffect(() => {
    currentEditPrefill("invoice");
    const edit = currentEditPrefill("invoice");
    if (!edit) return;
    if (loading()) return;
    const found = invoices().find((r) => r.number === edit.key);
    if (found) {
      // 走 openInvoiceEdit（含表单 seed，save 读 invoiceForm）
      openInvoiceEdit({ ...found, ...(edit.payload as Partial<InvoiceRecord>) });
      setTab("invoices");
    }
    clearEditPrefill("invoice");
  });
  createEffect(() => {
    currentEditPrefill("inbound");
    const edit = currentEditPrefill("inbound");
    if (!edit) return;
    if (inboundLoading()) return;
    const found = inboundRecords().find((r) => r.id === edit.key);
    if (found) {
      // 走 openInboundEdit（含表单 seed）
      openInboundEdit({ ...found, ...(edit.payload as Partial<InboundRecord>) });
      setTab("inbound");
    }
    clearEditPrefill("inbound");
  });

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
    clearPrefill("invoice"); // v2.5.4：手动新建防御性清队列
    setStagedArchive(null);
    setStagedIdentifySource(null);
    setIdentifyWarnings([]);
    const seeded: InvoiceFormState = {
      number: "", code: "", date: toDateKey(new Date()), amount: "", seller: "", buyer: "",
      status: "待报销", customer: "", due_date: "", file_path: "", tags: [], notes: "",
    };
    setInvoiceForm(seeded);
    setInvoiceFormSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照
    setInvoiceEditor({ mode: "create" });
  };
  const openInvoiceEdit = (rec: InvoiceRecord) => {
    setStagedArchive(null); // 编辑模式手动换绑才暂存
    setStagedIdentifySource(null); // 编辑模式无识别槽
    setIdentifyWarnings([]);
    const seeded: InvoiceFormState = {
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
    };
    setInvoiceForm(seeded);
    setInvoiceFormSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照（编辑基准 = 记录现值）
    setInvoiceEditor({ mode: "edit", record: rec });
  };

  const setInvoiceField = <K extends keyof InvoiceFormState>(key: K, value: InvoiceFormState[K]) =>
    setInvoiceForm((prev) => ({ ...prev, [key]: value }));

  /**
   * v2.5.4（Task 4）：global 命令槽点击——callPlugin 走插件既有 IPC action（ApiResult 信封）。
   * 成功 → 字段经 normalizeInvoice 白名单回填（有值覆盖、空/0 不动）+ 暂存 stagedIdentifySource；
   * 失败 → toast（error.message），表单保持。
   */
  const identifyFromFile = async (cmd: { pluginId: string; commandId: string }) => {
    if (identifying()) return; // 连点守卫
    const already = stagedIdentifySource();
    if (already) {
      // B1 P0 归档后移：重复识别只替换暂存源（保存时才归档一次），不再产生副本、不再静默孤儿
      showToast("info", "本单已识别过，再次识别将替换待归档源", `原源文件：${already.fileName}（未落盘，原地保留）`);
    }
    setIdentifying(true);
    try {
      const r = await callPlugin(cmd.pluginId, cmd.commandId, {});
      if (r.success && r.data) {
        const d = r.data as { fields?: unknown; sourcePath?: unknown; warnings?: unknown };
        // normalizePrefill('invoice') = normalizeInvoice 白名单（P1-11）；有值覆盖、空/0 不动
        const norm = normalizePrefill("invoice", d.fields) as InvoicePrefill;
        setInvoiceForm((prev) => {
          const next = { ...prev };
          if (norm.number) next.number = norm.number;
          if (norm.code) next.code = norm.code;
          if (norm.date) next.date = norm.date;
          if (norm.amount != null && norm.amount !== 0) next.amount = String(norm.amount);
          if (norm.seller) next.seller = norm.seller;
          if (norm.buyer) next.buyer = norm.buyer;
          if (norm.notes) next.notes = norm.notes;
          return next;
        });
        const warnings = Array.isArray(d.warnings)
          ? d.warnings.filter((x): x is string => typeof x === "string")
          : [];
        setIdentifyWarnings(warnings);
        const src = typeof d.sourcePath === "string" ? d.sourcePath.trim() : "";
        if (src) {
          // —— B1 P0 归档后移（用户拍板 2026-08-24）：识别成功只暂存源+识别日期，保存时才 archiveFile ——
          // 归档年份口径保留（B0 §九）：识别日期 → 文件 mtime 兜底 → 今年（保存回调消费）
          let archDate = norm.date;
          if (!archDate) archDate = await dateFromFileMtime(src);
          if (!archDate) archDate = toDateKey(new Date());
          setStagedIdentifySource({ sourcePath: src, fileName: baseNameOf(src), date: archDate });
        } else {
          setStagedIdentifySource(null); // 用户取消选择 → 静默
        }
      } else {
        showToast("error", "识别失败", r.error || "未知错误");
      }
    } catch (err) {
      showToast("error", "识别失败", err instanceof Error ? err.message : String(err));
    } finally {
      setIdentifying(false);
    }
  };

  /** 选本地文件 → 只暂存待归档源（B1 P0 归档后移：保存时才 archiveFile，取消/逃逸零落盘） */
  const pickInvoiceFile = async () => {
    const date = invoiceForm().date;
    if (!date) {
      showToast("info", "请先选择开票日期，再归档文件（归档目录按开票日期年份）");
      return;
    }
    const src = await api.dialog.openFile("选择发票文件", [{ displayName: "所有文件", pattern: "*" }]);
    if (!src) return;
    setStagedArchive({ sourcePath: src, date });
    showToast("info", "已暂存待归档", `${baseNameOf(src)}（确认登记时归档）`);
  };

  /** 关闭新建/编辑弹窗：只清暂存 + 关闭，零落盘（脏守卫在 dirty 时接管二次确认，此处不再 toast） */
  const closeInvoiceEditor = () => {
    setStagedArchive(null);
    setStagedIdentifySource(null); // 识别源只暂存，取消/关闭即弃（源文件原地不动）
    setIdentifyWarnings([]);
    setInvoiceEditor(null);
    clearPrefill("invoice"); // v2.5.4：取消 = 清预填队列（P1-1；保存成功不经过本函数）
  };

  /** v2.5.5（B1-B）：发票弹窗脏判定 = 暂存源（识别/手动）OR 预填 file_path（防孤儿）OR 表单相对打开快照有改动 */
  const invoiceDirty = () => {
    if (stagedArchive() || stagedIdentifySource()) return true;
    const f = invoiceForm();
    if (invoiceEditor()?.mode === "create" && f.file_path !== "") return true; // 预填 file_path 未登记 → 防孤儿（B0 §六）
    const snap = invoiceFormSnapshot();
    if (!snap) return false;
    return JSON.stringify(f) !== JSON.stringify(snap);
  };

  /** 发票弹窗关闭请求：dirty → 弹「放弃未保存内容？」；否则直关 */
  const requestCloseInvoice = () => {
    if (discardTarget()) return; // 确认弹窗打开期间防叠加触发
    if (invoiceDirty()) setDiscardTarget("invoice");
    else closeInvoiceEditor();
  };

  /** 放弃修改（确认后）：真实关闭 */
  const confirmDiscard = () => {
    const t = discardTarget();
    setDiscardTarget(null);
    if (t === "invoice") closeInvoiceEditor();
    else if (t === "inbound") closeInboundEditor();
  };

  /** B1 P0 保存失败回滚：删除本次归档刚产生的副本（只删精确 rel，force+catch，走回收站 file API 不级联台账；
   *  暂存源保留——用户修正后可重试，重试时重新归档） */
  const rollbackArchived = async (rel: string) => {
    const ws = currentWorkspace()?.path;
    if (!ws || !rel) return;
    const r = await api.files.delete([`${ws.replace(/\\/g, "/")}/${rel}`]).catch(() => null);
    if (!r?.success) {
      console.warn("[rollbackArchived] 回滚删除归档副本失败", rel, r?.error);
    }
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

    // —— B1 P0 归档后移：文件来源解析 ——
    // 识别流暂存源（stagedIdentifySource）/ 手动选文件暂存源（stagedArchive）在保存时才 archiveFile；
    // 无暂存源时用表单 file_path（插件预填或编辑既有，直接登记不复制）。归档年份口径保留（B0 §九）。
    const stagedId = stagedIdentifySource();
    const stagedManual = stagedArchive();
    const filePath = f.file_path;
    let date = f.date;
    let archiveSource = "";
    let archiveDate = "";
    if (stagedId) {
      archiveSource = stagedId.sourcePath;
      archiveDate = stagedId.date || date;
      if (!date) date = archiveDate;
    } else if (stagedManual) {
      archiveSource = stagedManual.sourcePath;
      archiveDate = stagedManual.date || date;
      if (!date) date = archiveDate;
    }
    if (archiveSource && !archiveDate) {
      archiveDate = await dateFromFileMtime(archiveSource);
      if (!archiveDate) {
        showToast("info", "请选择开票日期");
        return;
      }
      showToast("info", "开票日期未识别，已按发票文件修改时间归档", archiveDate);
    }
    if (!archiveSource) {
      if (!filePath) {
        showToast("info", "请先选择并归档发票文件");
        return;
      }
      if (!date) {
        showToast("info", "请选择开票日期");
        return;
      }
    }

    const common = {
      code: f.code.trim(),
      date,
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
        // 换绑：先归档暂存源，再 update（失败回滚本次刚归档的副本；未换绑缺省 → core 保持原 file_path）
        let fpForUpdate = filePath;
        if (archiveSource) {
          const arch = await api.invoices.archiveFile(archiveSource, archiveDate);
          if (arch.success && arch.data) {
            fpForUpdate = arch.data;
          } else {
            showToast("error", "文件归档失败", arch.error || "未知错误");
            return;
          }
        }
        const orig = editor.record;
        result = await api.invoices.update({
          number: orig.number,
          newNumber: number !== orig.number ? number : undefined,
          ...common,
          file_path: fpForUpdate !== orig.file_path ? fpForUpdate : undefined,
        });
        if (!result.success && archiveSource) await rollbackArchived(fpForUpdate);
      } else {
        // —— 时序收口（设计 §1.4-D + B1 P0 归档后移）：checkNumber 查重预检 → 归档 → create ——
        //    先查重后归档：查重拒绝不产生孤儿；create 失败回滚本次归档副本
        const dup = await api.invoices.checkNumber(number);
        if (dup.success && dup.data) {
          showToast(
            "error",
            "保存失败",
            `发票号码 ${number} 已存在（状态：${dup.data.status}，日期：${dup.data.date}）`,
          );
          return;
        }
        if (!dup.success) {
          showToast("error", "查重失败", dup.error || "未知错误");
          return;
        }
        let fpForCreate = filePath;
        if (archiveSource) {
          const arch = await api.invoices.archiveFile(archiveSource, archiveDate);
          if (arch.success && arch.data) {
            fpForCreate = arch.data;
          } else {
            showToast("error", "文件归档失败", arch.error || "未知错误");
            return;
          }
        }
        result = await api.invoices.create({ ...common, number, file_path: fpForCreate });
        if (!result.success && archiveSource) await rollbackArchived(fpForCreate);
      }
      if (result.success) {
        setStagedArchive(null); // 已保存为记录，文件不再孤儿
        setStagedIdentifySource(null);
        setIdentifyWarnings([]);
        setInvoiceEditor(null);
        showToast("success", editor?.mode === "edit" ? "发票已更新" : "发票已登记");
        void loadInvoices();
        if (editor?.mode !== "edit") advancePrefill("invoice"); // v2.5.4：批量预填推进（P1-1）
      } else {
        showToast("error", "保存失败", result.error || "未知错误");
      }
    } finally {
      setSaving(false);
    }
  };

  // —— 入库单 新建/编辑 ——
  const openInboundCreate = () => {
    clearPrefill("inbound"); // v2.5.4：手动新建防御性清队列
    setStagedArchive(null);
    const seeded: InboundFormState = {
      id: "", date: toDateKey(new Date()), supplier: "", supplier_id: "", product_set: "",
      amount: "", notes: "", file_path: "",
    };
    setInboundForm(seeded);
    setInboundFormSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照
    setInboundEditor({ mode: "create" });
  };
  const openInboundEdit = (rec: InboundRecord) => {
    setStagedArchive(null);
    const seeded: InboundFormState = {
      id: rec.id,
      date: rec.date,
      supplier: rec.supplier,
      supplier_id: rec.supplier_id ?? "",
      product_set: rec.product_set ?? "",
      amount: rec.amount !== undefined ? String(rec.amount) : "",
      notes: rec.notes ?? "",
      file_path: rec.file_path,
    };
    setInboundForm(seeded);
    setInboundFormSnapshot(seeded); // v2.5.5（B1-B）：脏守卫初始快照（编辑基准 = 记录现值）
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
    setStagedArchive({ sourcePath: src, date }); // B1 P0 归档后移：只暂存，保存时才落盘
    showToast("info", "已暂存待归档", `${baseNameOf(src)}（确认登记时归档）`);
  };

  /** 关闭新建/编辑弹窗：只清暂存 + 关闭，零落盘（脏守卫在 dirty 时接管二次确认） */
  const closeInboundEditor = () => {
    setStagedArchive(null);
    setInboundEditor(null);
    clearPrefill("inbound"); // v2.5.4：取消 = 清预填队列（P1-1；保存成功不经过本函数）
  };

  /** v2.5.5（B1-B）：入库弹窗脏判定 = 暂存源 OR 预填 file_path（防孤儿）OR 表单相对打开快照有改动 */
  const inboundDirty = () => {
    if (stagedArchive()) return true;
    const f = inboundForm();
    if (inboundEditor()?.mode === "create" && f.file_path !== "") return true; // 预填 file_path 未登记 → 防孤儿（B0 §六）
    const snap = inboundFormSnapshot();
    if (!snap) return false;
    return JSON.stringify(f) !== JSON.stringify(snap);
  };

  /** 入库弹窗关闭请求：dirty → 弹「放弃未保存内容？」；否则直关 */
  const requestCloseInbound = () => {
    if (discardTarget()) return; // 确认弹窗打开期间防叠加触发
    if (inboundDirty()) setDiscardTarget("inbound");
    else closeInboundEditor();
  };

  const saveInbound = async () => {
    if (saving()) return; // 连点守卫（P2-10）
    const editor = inboundEditor();
    const f = inboundForm();
    if (!f.id.trim()) {
      showToast("info", "单据编号不能为空");
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
    // B1 P0 归档后移：暂存源在保存时才 archiveFile；无暂存源用表单 file_path（预填/编辑既有）
    const staged = stagedArchive();
    let filePath = f.file_path;
    setSaving(true);
    try {
      if (staged) {
        const arch = await api.inbound.archiveFile(staged.sourcePath, staged.date || f.date);
        if (arch.success && arch.data) {
          filePath = arch.data;
        } else {
          showToast("error", "文件归档失败", arch.error || "未知错误");
          return;
        }
      }
      if (!filePath) {
        showToast("info", "请先选择并归档入库文件");
        return;
      }
      const req: InboundCreateRequest = {
        id: f.id.trim(),
        date: f.date,
        supplier: f.supplier.trim(),
        supplier_id: f.supplier_id.trim() || undefined,
        product_set: f.product_set.trim() || undefined,
        file_path: filePath,
        amount: f.amount.trim() !== "" ? Number(f.amount) : undefined,
        notes: f.notes.trim() || undefined,
      };
      const result = editor?.mode === "edit" ? await api.inbound.update(editor.record.id, req) : await api.inbound.create(req);
      // 保存失败（含 core 查重拒绝）→ 回滚本次刚归档的副本（暂存源保留，可修正重试）
      if (!result.success && staged) await rollbackArchived(filePath);
      if (result.success) {
        setStagedArchive(null); // 已保存为记录，文件不再孤儿
        setInboundEditor(null);
        showToast("success", editor?.mode === "edit" ? "入库单已更新" : "入库单已登记");
        void loadInbound();
        if (editor?.mode !== "edit") advancePrefill("inbound"); // v2.5.4：批量预填推进（P1-1）
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
        // v2.5.5（B1-B）：脏守卫——dirty 时遮罩/Esc/取消走 onCloseRequest（二次确认）
        dirty={invoiceDirty()}
        onCloseRequest={requestCloseInvoice}
        onSave={() => void saveInvoice()}
        onPickFile={pickInvoiceFile}
        onPreviewFile={() => invoiceForm().file_path && previewRelPath(invoiceForm().file_path)}
        missing={missingFiles()}
        customers={customers()}
        tagOptions={tagList()}
        identifyCommands={pluginGlobalCommands()}
        identifying={identifying()}
        identifyWarnings={identifyWarnings()}
        stagedIdentifyName={stagedIdentifySource()?.fileName ?? ""}
        onIdentify={(cmd) => void identifyFromFile(cmd)}
      />
      <InboundEditorModal
        editor={inboundEditor()}
        form={inboundForm()}
        setField={setInboundField}
        saving={saving()}
        onClose={closeInboundEditor}
        // v2.5.5（B1-B）：脏守卫
        dirty={inboundDirty()}
        onCloseRequest={requestCloseInbound}
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
      {/* v2.5.5（B1-B）：脏守卫「放弃未保存内容？」二次确认（发票/入库共用；确认弹窗为独立 Modal 叠层，
          打开期间其遮罩/Esc 不会叠加触发下层编辑器守卫——layerStack 只派栈顶） */}
      <Show when={discardTarget()}>
        <ConfirmDialog
          title="放弃未保存内容？"
          message="该弹窗有未保存的修改或待归档文件，放弃后将不会保存任何内容（已选文件不会归档）。"
          confirmLabel="放弃修改"
          cancelLabel="继续编辑"
          danger
          onConfirm={confirmDiscard}
          onCancel={() => setDiscardTarget(null)}
        />
      </Show>
    </div>
  );
}
