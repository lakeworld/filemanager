import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import type { TagInfo } from "~/types";

/** 标签定义缓存：name → color（v2.0.1 标签颜色体系） */
const [tagDefs, setTagDefs] = createSignal<Record<string, string>>({});

export const DEFAULT_TAG_COLOR = "#94a3b8";

export async function loadTagDefs(): Promise<void> {
  const r = await api.tags.list();
  if (r.success && r.data) {
    const map: Record<string, string> = {};
    for (const t of r.data) map[t.name] = t.color || DEFAULT_TAG_COLOR;
    setTagDefs(map);
  }
}

/** 标签颜色（未定义用默认灰） */
export function tagColor(name: string): string {
  return tagDefs()[name] || DEFAULT_TAG_COLOR;
}

/** 标签 chip 样式（inline background + 文字色，白字） */
export function tagChipStyle(name: string): { backgroundColor: string } {
  return { backgroundColor: tagColor(name) };
}

export function refreshTags(): void {
  void loadTagDefs();
}

export type { TagInfo };
