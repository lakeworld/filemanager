import type { ContextMenuItem } from "~/components/ContextMenu";
import { api } from "~/wails/api";
import type { FileEntry } from "~/types";

/**
 * 统一文件右键菜单 builder（v2.3.x UI 统一批）。
 * 固定顺序：预览 / 编辑信息 / 用默认程序打开 / 复制 / 复制路径 /
 * 在文件夹中显示 / 移动到… / 重命名 / 删除。
 * 未提供对应回调的项自动隐藏，各页面按自身能力裁剪。
 */

export interface FileContextMenuOptions<T extends FileEntry> {
  /** 右键主文件（单文件操作使用）；多选时以 paths 为准 */
  file?: T;
  /** 多选场景的完整路径集合，默认 [file.path] */
  paths?: string[];
  /** 预览（单文件） */
  onPreview?: (file: T) => void;
  /** 编辑信息（单文件，带 editMetadata 打开预览） */
  onEditInfo?: (file: T) => void;
  /** 用默认程序打开（单文件） */
  onOpenDefault?: (file: T) => void;
  /** 复制文件到剪贴板 */
  onCopy?: (paths: string[]) => void;
  /** 在文件夹中显示 */
  onShowInExplorer?: (paths: string[]) => void;
  /** 移动到…（打开目标选择对话框） */
  onMove?: (paths: string[]) => void;
  /** 重命名（单文件） */
  onRename?: (file: T) => void;
  /** 删除 */
  onDelete?: (paths: string[]) => void;
}

export function buildFileContextMenuItems<T extends FileEntry>(
  opts: FileContextMenuOptions<T>,
): ContextMenuItem[] {
  const file = opts.file;
  const paths = opts.paths ?? (file ? [file.path] : []);
  // 单文件操作：仅单选（且能找到文件）时显示
  const single = paths.length === 1 && !!file;
  const { onPreview, onEditInfo, onOpenDefault, onCopy, onShowInExplorer, onMove, onRename, onDelete } = opts;

  const items: ContextMenuItem[] = [];

  // 1. 预览
  if (onPreview) {
    items.push({
      label: "预览",
      icon: "👁️",
      show: single,
      action: () => {
        if (file) onPreview(file);
      },
    });
  }

  // 2. 编辑信息
  if (onEditInfo) {
    items.push({
      label: "编辑信息",
      icon: "✏️",
      show: single,
      action: () => {
        if (file) onEditInfo(file);
      },
    });
  }

  // 3. 用默认程序打开
  if (onOpenDefault) {
    items.push({
      label: "用默认程序打开",
      icon: "🖥️",
      show: single,
      action: () => {
        if (file) onOpenDefault(file);
      },
    });
  }

  // 4. 复制
  if (onCopy) {
    items.push({
      label: "复制",
      icon: "📋",
      action: () => onCopy(paths),
    });
  }

  // 5. 复制路径（各页面均具备该能力，直接走统一 API）
  items.push({
    label: "复制路径",
    icon: "🔗",
    action: () => void api.files.copyPaths(paths),
  });

  // 6. 在文件夹中显示
  if (onShowInExplorer) {
    items.push({
      label: "在文件夹中显示",
      icon: "📂",
      action: () => onShowInExplorer(paths),
    });
  }

  // 7. 移动到…
  if (onMove) {
    items.push({
      label: "移动到…",
      icon: "📦",
      action: () => onMove(paths),
    });
  }

  // 8. 重命名
  if (onRename) {
    items.push({
      label: "重命名",
      icon: "✏️",
      show: single,
      action: () => {
        if (file) onRename(file);
      },
    });
  }

  // 9. 删除
  if (onDelete) {
    items.push({
      label: "删除",
      icon: "🗑️",
      danger: true,
      action: () => onDelete(paths),
    });
  }

  return items;
}

/**
 * 从绝对路径提取产品集名（供搜索页等无结构化信息的场景使用）。
 * 路径形态：<ws>/产品集/<产品集>/图包|证书/<子文件夹>/<文件>
 * 提取失败返回空串（此时编辑信息面板不会显示元数据）。
 */
export function productSetFromFilePath(p: string): string {
  const parts = p.split(/[\\/]/);
  const idx = parts.indexOf("产品集");
  return idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : "";
}
