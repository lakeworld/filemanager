import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import { getPreviewKind } from "../../../shared/fileKind";
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

const loadMetadata = async (file: FileEntry) => {
  // v2.4.2：主进程按文件绝对路径推导元数据 key（含子文件夹），不再传 productSet/fileName
  const result = await api.metadata.get(file.path);
  // v2.4.2（批次二）：序号守卫——连开多个文件时，慢返回的旧文件元数据不得覆盖当前预览状态
  if (previewFile()?.path !== file.path) return;
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
  setPreviewFile(file);
  setPreviewContext(ctx);
  setPreviewUrl("");
  setPreviewError("");
  setMetadata({ ...defaultMetadata });

  if (ctx.productSet) {
    loadMetadata(file);
  }

  // v2.4.6：图片预览优先走主进程 2048px 降采样副本（qihebox://thumb/）——
  // 全尺寸原图解码位图 ~96MB 是渲染进程 RSS 膨胀主因，副本压到 ≤16MB；
  // 生成失败/非图片返回空串 → 回退原 workspaceUrl 原图逻辑，功能不受影响
  if (file.file_type === "image") {
    const thumbResult = await api.files.previewUrl(file.path);
    // v2.4.2（批次二）：序号守卫照旧——等待期间用户已打开其他文件 → 丢弃过期结果
    if (previewFile()?.path !== file.path) return;
    if (thumbResult.success && thumbResult.data) {
      setPreviewUrl(thumbResult.data);
      setShowPreview(true);
      return;
    }
  }

  const urlResult = await api.files.workspaceUrl(file.path);
  // v2.4.2（批次二）：等待期间用户已打开其他文件 → 丢弃过期结果，不覆盖
  if (previewFile()?.path !== file.path) return;
  if (urlResult.success && urlResult.data) {
    setPreviewUrl(urlResult.data);
  } else {
    setPreviewError(urlResult.error || "无法加载预览");
  }

  setShowPreview(true);
};

export const closePreview = () => {
  setShowPreview(false);
};

export const saveCurrentMetadata = async (): Promise<{ ok: boolean; error?: string }> => {
  const file = previewFile();
  const productSet = previewContext().productSet;
  if (!file || !productSet) return { ok: false, error: "缺少文件上下文，无法保存" };

  // v2.4.2：元数据 key 由主进程按 file_path 推导（含子文件夹），无需再传 product_set/file_name
  const result = await api.metadata.update({
    file_path: file.path,
    cert_type: metadata().cert_type,
    expiry_date: metadata().expiry_date,
    tags: metadata().tags,
    notes: metadata().notes,
  });

  // v2.4.3（F9）：返回结构化结果，由调用方（FilePreviewModal）弹保存成功/失败提示
  if (result.success) {
    loadMetadata(file);
    return { ok: true };
  }
  return { ok: false, error: result.error || "保存失败，请重试" };
};

export const deleteCurrentFile = async (): Promise<{ ok: boolean; error?: string }> => {
  const file = previewFile();
  if (!file) return { ok: false, error: "缺少文件上下文，无法删除" };

  const result = await api.files.delete([file.path]);
  if (result.success) {
    previewContext().onDelete?.();
    closePreview();
    return { ok: true };
  }
  // v2.4.7：删除失败不再静默——返回错误信息，由调用方（FilePreviewModal）提示
  return { ok: false, error: result.error || "删除失败，请重试" };
};

export const openCurrentWithSystem = async () => {
  const file = previewFile();
  if (!file) return;
  const result = await api.files.openWithDefaultApp(file.path);
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
  metadata,
  setMetadata,
  setPreviewError,
};
