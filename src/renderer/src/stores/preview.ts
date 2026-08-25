import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import { getPreviewKind } from "../../../shared/fileKind";
import { currentWorkspace } from "~/stores/workspace";
import type { FileEntry, FileMetadata } from "~/types";

const defaultMetadata: FileMetadata = {
  cert_type: "",
  expiry_date: "",
  tags: [],
  notes: "",
  added_at: "",
};

export interface PreviewContext {
  /** 产品集名称；提供时才会显示并编辑元数据面板 */
  productSet?: string;
  /** 是否显示元数据编辑面板（需要同时提供 productSet） */
  editMetadata?: boolean;
  /** 删除文件后需要刷新列表的回调 */
  onDelete?: () => void;
}

const [previewFile, setPreviewFile] = createSignal<FileEntry | null>(null);
const [showPreview, setShowPreview] = createSignal(false);
const [previewUrl, setPreviewUrl] = createSignal("");
const [previewError, setPreviewError] = createSignal("");
const [previewContext, setPreviewContext] = createSignal<PreviewContext>({});
const [metadata, setMetadata] = createSignal<FileMetadata>({ ...defaultMetadata });

// v2.5.3（T7）：预览代际计数——每次 openPreview / closePreview 递增。
// 所有异步续体（URL / 元数据 / 删除 / 系统程序打开）在任一 await 前捕获 gen，
// await 返回后与当前代比对，不一致即整体丢弃：
// 「关闭后迟到的请求不得重开弹窗」「切换文件后旧结果不得覆盖新文件」。
let previewGen = 0;
// v2.5.3（T7）D5：预览会话 key（openPreview / closePreview 每次递增）——
// FilePreviewModal 以此复位常驻本地 signal（删除确认/右键菜单/保存中）：
// 「开→开」切换文件与「关→开」同样触发复位（契约语义：复位随会话变化，而非仅随关闭）
const [previewSessionKey, setPreviewSessionKey] = createSignal(0);

/** v2.5.5（T7）O1：当前预览代（openPreview/closePreview 递增）。
 * 调用方在异步 IPC 前后各取一次并比对，判断预览会话是否已变化（防止旧失败文案写进新预览）。 */
export const currentPreviewGen = (): number => previewGen;

/** 路径是否在工作区内（批量识别任意系统文件夹的文件在工作区外，预览走 qihebox://ext/） */
const isInsideWorkspace = (p: string): boolean => {
  const ws = currentWorkspace()?.path;
  if (!ws) return false;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(p).startsWith(norm(ws) + "/");
};

const loadMetadata = async (file: FileEntry, gen: number) => {
  // v2.4.2：主进程按文件绝对路径推导元数据 key（含子文件夹），不再传 productSet/fileName
  const result = await api.metadata.get(file.path);
  // v2.4.2（批次二）：序号守卫——连开多个文件时，慢返回的旧文件元数据不得覆盖当前预览状态
  // v2.5.3（T7）：统一改按代际比对（closePreview 同样递增，关闭后迟到的元数据一并丢弃）
  if (gen !== previewGen) return;
  if (result.success && result.data) {
    setMetadata(result.data);
  } else {
    setMetadata({ ...defaultMetadata });
  }
};

export const openPreview = async (file: FileEntry, context?: PreviewContext) => {
  // v2.2.1 终版：PDF/图片内嵌主窗口预览（用户确认不要独立窗口形态），
  // 渲染用优化后的 PdfPreview（流式/页缓存/渐进），关闭即卸载销毁
  const ctx = context || {};
  const gen = ++previewGen;
  setPreviewSessionKey((k) => k + 1); // 会话切键：modal 常驻信号复位（D5）
  setPreviewFile(file);
  setPreviewContext(ctx);
  setPreviewUrl("");
  setPreviewError("");
  setMetadata({ ...defaultMetadata });

  if (ctx.productSet) {
    loadMetadata(file, gen);
  }

  // v2.4.6：图片预览优先走主进程 2048px 降采样副本（qihebox://thumb/）——
  // 全尺寸原图解码位图 ~96MB 是渲染进程 RSS 膨胀主因，副本压到 ≤16MB；
  // 生成失败/非图片返回空串 → 回退原 workspaceUrl 原图逻辑，功能不受影响
  // v2.5.5（打磨 2）：工作区外文件（批量识别任意文件夹）走 qihebox://ext/，不走降采样/工作区协议
  const insideWs = isInsideWorkspace(file.path);
  if (file.file_type === "image" && insideWs) {
    const thumbResult = await api.files.previewUrl(file.path);
    // v2.5.3（T7）：代际守卫——等待期间已关闭或已打开其他文件 → 丢弃过期结果
    if (gen !== previewGen) return;
    if (thumbResult.success && thumbResult.data) {
      setPreviewUrl(thumbResult.data);
      setShowPreview(true);
      return;
    }
  }

  const urlResult = insideWs
    ? await api.files.workspaceUrl(file.path)
    : await api.files.externalUrl(file.path);
  // v2.5.3（T7）：代际守卫——等待期间已关闭或已打开其他文件 → 丢弃过期结果
  if (gen !== previewGen) return;
  if (urlResult.success && urlResult.data) {
    setPreviewUrl(urlResult.data);
  } else {
    setPreviewError(urlResult.error || "无法加载预览");
  }
  // 仅当前代才打开弹窗——关闭后迟到的 URL 不得把弹窗重新拉起
  if (gen !== previewGen) return;
  setShowPreview(true);
};

export const closePreview = () => {
  // 先递增代际使所有 in-flight 请求即刻失效，再关窗清态——
  // 迟到请求返回时发现代际不符，无法把弹窗重新打开
  previewGen++;
  setPreviewSessionKey((k) => k + 1); // 会话切键：modal 常驻信号复位（D5）
  setShowPreview(false);
  setPreviewFile(null);
  setPreviewUrl("");
  setPreviewError("");
  setPreviewContext({});
  setMetadata({ ...defaultMetadata });
};

export const saveCurrentMetadata = async (): Promise<{ ok: boolean; error?: string }> => {
  const file = previewFile();
  const productSet = previewContext().productSet;
  if (!file || !productSet) return { ok: false, error: "缺少文件上下文，无法保存" };
  const gen = previewGen;

  // v2.4.2：元数据 key 由主进程按 file_path 推导（含子文件夹），无需再传 product_set/file_name
  const result = await api.metadata.update({
    file_path: file.path,
    cert_type: metadata().cert_type,
    expiry_date: metadata().expiry_date,
    tags: metadata().tags,
    notes: metadata().notes,
  });

  // v2.4.3（F9）：返回结构化结果，由调用方（FilePreviewModal）弹保存成功/失败提示
  if (!result.success) return { ok: false, error: result.error || "保存失败，请重试" };
  // v2.5.3（T7）：保存成功但期间已切换/关闭预览 → 不再做保存后的元数据回读（不覆盖新预览）
  if (gen === previewGen) {
    loadMetadata(file, gen);
  }
  return { ok: true };
};

export const deleteCurrentFile = async (): Promise<{ ok: boolean; error?: string; stale?: boolean }> => {
  // v2.5.3（T7）：await 前捕获代际与上下文——删除成功后列表刷新照常执行（不依赖预览是否还开着）；
  // 但只有仍是同一代才 closePreview，避免旧删除把用户新打开的预览一并关掉
  const gen = previewGen;
  const file = previewFile();
  const context = previewContext();
  if (!file) return { ok: false, error: "缺少文件上下文，无法删除" };

  const result = await api.files.delete([file.path]);
  if (result.success) {
    context.onDelete?.();
    if (gen === previewGen) closePreview();
    return { ok: true };
  }
  // v2.5.3（T7）O1：删除失败同样做代际判定——期间已关闭/切换预览时，
  // 失败文案不得写进新预览（调用方按 stale 决定是否提示）
  return { ok: false, error: result.error || "删除失败，请重试", stale: gen !== previewGen };
};

export const openCurrentWithSystem = async () => {
  const gen = previewGen;
  const file = previewFile();
  if (!file) return;
  const result = await api.files.openWithDefaultApp(file.path);
  // v2.5.3（T7）：期间已关闭/切换预览 → 丢弃失败状态，不写进新预览的错误面
  if (gen !== previewGen) return;
  if (!result.success) {
    setPreviewError(result.error || "无法打开文件");
  }
};

/**
 * v2.5.1（F3）：双击/预览统一入口——按类型分流：
 * 可内嵌预览（image/video/pdf/md）→ openPreview；其余（docx/xlsx/zip 等）→ 默认应用打开。
 * 各文件域双击处理点统一改调此函数（行为变更登记 CHANGELOG）。
 */
export const openFileSmart = async (file: FileEntry, context?: PreviewContext): Promise<void> => {
  if (getPreviewKind(file) === "other") {
    await api.files.openWithDefaultApp(file.path);
    return;
  }
  await openPreview(file, context);
};

export {
  previewFile,
  showPreview,
  previewUrl,
  previewError,
  previewContext,
  previewSessionKey,
  metadata,
  setMetadata,
  setPreviewError,
};
