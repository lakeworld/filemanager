import { createSignal } from "solid-js";
import { api } from "~/wails/api";
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

const loadMetadata = async (file: FileEntry, productSet: string) => {
  const result = await api.metadata.get(productSet, file.name);
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
    loadMetadata(file, ctx.productSet);
  }

  const urlResult = await api.files.workspaceUrl(file.path);
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

export const saveCurrentMetadata = async () => {
  const file = previewFile();
  const productSet = previewContext().productSet;
  if (!file || !productSet) return false;

  const result = await api.metadata.update({
    product_set: productSet,
    file_name: file.name,
    cert_type: metadata().cert_type,
    expiry_date: metadata().expiry_date,
    tags: metadata().tags,
    notes: metadata().notes,
  });

  if (result.success) {
    loadMetadata(file, productSet);
    return true;
  }
  return false;
};

export const deleteCurrentFile = async () => {
  const file = previewFile();
  if (!file) return false;

  const result = await api.files.delete([file.path]);
  if (result.success) {
    previewContext().onDelete?.();
    closePreview();
    return true;
  }
  return false;
};

export const openCurrentWithSystem = async () => {
  const file = previewFile();
  if (!file) return;

  const result = await api.files.openWithDefaultApp(file.path);
  if (!result.success) {
    setPreviewError(result.error || "无法打开文件");
  }
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
