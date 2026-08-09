import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import type { TagInfo } from "~/types";

/** 标签定义缓存：name → { color, parent }（v2.0.2 含层级） */
const [tagMeta, setTagMeta] = createSignal<Record<string, { color: string; parent: string | null }>>({});
/** 完整标签列表（含 children，供打标选择器分组） */
export const [tagList, setTagList] = createSignal<TagInfo[]>([]);

export const DEFAULT_TAG_COLOR = "#94a3b8";

export async function loadTagDefs(): Promise<void> {
  const r = await api.tags.list();
  if (r.success && r.data) {
    setTagList(r.data);
    const map: Record<string, { color: string; parent: string | null }> = {};
    for (const t of r.data) map[t.name] = { color: t.color || DEFAULT_TAG_COLOR, parent: t.parent };
    setTagMeta(map);
  }
}

/** 标签颜色（未定义用默认灰） */
export function tagColor(name: string): string {
  return tagMeta()[name]?.color || DEFAULT_TAG_COLOR;
}

/** 标签层级显示文本：子标签 → 父/子 */
export function tagLabel(name: string): string {
  const meta = tagMeta()[name];
  return meta?.parent ? `${meta.parent}/${name}` : name;
}

/** 标签 chip 样式（inline background + 按背景亮度自适应的文字色） */
export function tagChipStyle(name: string): { "background-color": string; color: string } {
  const bg = tagColor(name);
  const hex = bg.replace(/^#/, "");
  // 非 #rrggbb 形态（如短色值）按亮度 0 处理 → 白字
  const n = hex.length === 6 ? parseInt(hex, 16) : 0;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { "background-color": bg, color: brightness > 0.6 ? "#1e293b" : "#ffffff" };
}

/** 顶层标签（打标选择器分组用） */
export function topLevelTags(): TagInfo[] {
  return tagList().filter((t) => !t.parent);
}

export function refreshTags(): void {
  void loadTagDefs();
}
