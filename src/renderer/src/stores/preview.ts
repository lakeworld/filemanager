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
const [tagInput, setTagInput] = createSignal("");

const loadMetadata = async (file: FileEntry, productSet: string) => {
  const result = await api.metadata.get(productSet, file.name);
  if (result.success && result.data) {
    setMetadata(result.data);
  } else {
    setMetadata({ ...defaultMetadata });
  }
};

export const openPreview = async (file: FileEntry, context?: PreviewContext) => {
  // v2.2.1：预览改在独立窗口（独立渲染进程，关闭即释放内存），主窗口不再内嵌大图/PDF
  const result = await api.preview.open(file.path);
  if (!result.success) {
    setPreviewError(result.error || "无法打开预览窗口");
  }
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

export const addTag = (tag: string) => {
  const t = tag.trim();
  if (!t) return;
  setMetadata((prev) => ({ ...prev, tags: [...prev.tags, t] }));
};

export const removeTag = (index: number) => {
  setMetadata((prev) => ({
    ...prev,
    tags: prev.tags.filter((_, i) => i !== index),
  }));
};

export {
  previewFile,
  showPreview,
  previewUrl,
  previewError,
  previewContext,
  metadata,
  tagInput,
  setTagInput,
  setMetadata,
  setPreviewError,
};
