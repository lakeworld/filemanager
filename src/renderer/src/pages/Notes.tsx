import { Show, For, createSignal, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { currentWorkspace } from "~/stores/workspace";
import { showToast } from "~/stores/notifyBanner";
import EmptyState from "~/components/EmptyState";
import Loading from "~/components/Loading";
import Modal from "~/components/ui/Modal";
import type { NoteEntryInfo } from "~/types";

/**
 * 笔记工作台（v2.5.7 A2）：侧边栏顶层 tab → /notes。
 * - 聚合三域最近笔记（产品集文档区 / 客户 / 供应商，mtime 倒序；core listRecentNotes 只读）
 * - 每行：归属徽标（域）+ 实体名 + 标题 + mtime + 标签（读 metadata 标签）
 * - 点击行 → 深链 /files/<scope>/<entity>/笔记?note=<文件名> → 文件区直开编辑器
 * - 「新建笔记」→ 归属选择器 + 标题 → 写入对应笔记文件夹 → 开编辑
 *   「不产生游离笔记」——新笔记必须选归属（三域之一）。
 */

const KIND_LABEL: Record<NoteEntryInfo["kind"], string> = {
  product_set: "产品集",
  customer: "客户",
  supplier: "供应商",
};

const KIND_ICON: Record<NoteEntryInfo["kind"], string> = {
  product_set: "📦",
  customer: "🤝",
  supplier: "🏭",
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

export default function Notes() {
  const navigate = useNavigate();
  const [notes, setNotes] = createSignal<NoteEntryInfo[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [showNew, setShowNew] = createSignal(false);
  const [entityKind, setEntityKind] = createSignal<NoteEntryInfo["kind"]>("product_set");
  const [entityName, setEntityName] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [creating, setCreating] = createSignal(false);

  const loadNotes = async () => {
    setLoading(true);
    try {
      const r = await api.notes.listRecent(null, 200);
      if (r.success && r.data) setNotes(r.data);
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    if (currentWorkspace()) loadNotes();
  });

  /** 深链跳文件区并开编辑（query ?note=<文件名>） */
  const openNote = (n: NoteEntryInfo) => {
    const file = n.title + ".md";
    let path = "";
    if (n.kind === "product_set") path = `/files/doc/${encodeURIComponent(n.entity)}/笔记?note=${encodeURIComponent(file)}`;
    else if (n.kind === "customer") path = `/files/customer/${encodeURIComponent(n.entity)}/笔记?note=${encodeURIComponent(file)}`;
    else path = `/files/supplier/${encodeURIComponent(n.entity)}/笔记?note=${encodeURIComponent(file)}`;
    navigate(path);
  };

  /** 归属可选项（与 core listRecentNotes 三域一致） */
  const entityOptions = () => {
    // 从现有笔记推导 + 常见实体（简化：从聚合结果取实体名集合；产品集/客户/供应商列表查询见各 store）
    const set = new Set<string>();
    for (const n of notes()) if (n.kind === entityKind()) set.add(n.entity);
    return [...set].sort();
  };

  const createNote = async () => {
    if (creating()) return;
    const t = title().trim();
    if (!t) return;
    setCreating(true);
    try {
      // 物理路径（core/paths + notes.ts 三域一致）；标题 → <标题>.md
      const fileName = t.endsWith(".md") ? t : `${t}.md`;
      const rel =
        entityKind() === "product_set"
          ? `产品集/${entityName()}/文档/笔记/${fileName}`
          : entityKind() === "customer"
            ? `客户/${entityName()}/笔记/${fileName}`
            : `供应商/${entityName()}/笔记/${fileName}`;
      const r = await api.files.writeText(rel, `# ${t.replace(/\.md$/i, "")}\n\n`);
      if (r.success) {
        setShowNew(false);
        setTitle("");
        await loadNotes();
        // 打开刚建的笔记（编辑态）
        const created = notes().find((n) => n.title + ".md" === fileName && n.entity === entityName());
        if (created) openNote(created);
        else {
          // 未能匹配（列表刷新竞态）——直接深链
          const q =
            entityKind() === "product_set" ? `?note=${encodeURIComponent(fileName)}` : "";
          navigate(
            entityKind() === "product_set"
              ? `/files/doc/${encodeURIComponent(entityName())}/笔记${q}`
              : entityKind() === "customer"
                ? `/files/customer/${encodeURIComponent(entityName())}/笔记`
                : `/files/supplier/${encodeURIComponent(entityName())}/笔记`,
          );
        }
      } else {
        showToast("error", "新建笔记失败", r.error ?? undefined);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div class="p-6">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-surface-900">笔记库</h1>
          <p class="text-surface-500 mt-1">三域最近笔记（产品集 / 客户 / 供应商；编辑即保存为 .md）</p>
        </div>
        <button class="btn-primary" onClick={() => setShowNew(true)}>
          📝 新建笔记
        </button>
      </div>

      <Show when={loading()} fallback={
        <Show when={notes().length > 0} fallback={<EmptyState icon="📝" title="还没有笔记" desc="在产品集 / 客户 / 供应商的「笔记」文件夹新建第一篇笔记" />}>
          <div class="card divide-y divide-surface-100">
            <For each={notes()}>
              {(n) => (
                <button
                  class="w-full flex items-center gap-4 px-5 py-3 text-left hover:bg-surface-50 transition-colors"
                  onClick={() => openNote(n)}
                  data-note-row={n.relPath}
                >
                  <span class="shrink-0 w-10 h-10 rounded-lg bg-surface-100 flex items-center justify-center text-lg">
                    {KIND_ICON[n.kind]}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500">{KIND_LABEL[n.kind]}</span>
                      <span class="text-xs text-surface-400 truncate">{n.entity}</span>
                    </div>
                    <div class="text-sm font-medium text-surface-900 truncate">{n.title}</div>
                    <div class="flex items-center gap-3 mt-1">
                      <span class="text-xs text-surface-400">{formatTime(n.mtime)}</span>
                      {/* 标签：读 metadata 需按 relPath 查——此处用文件列表接口简化为注释位；tags 留待后续 */}
                    </div>
                  </div>
                  <span class="text-surface-300">›</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      }>
        <Loading />
      </Show>

      {/* 新建笔记：归属选择器 + 标题（不产生游离笔记——必须选归属） */}
      <Show when={showNew()}>
        <Modal open title="新建笔记" size="md" onClose={() => setShowNew(false)}>
          <div class="p-6">
            <div class="mb-4">
              <label class="block text-xs text-surface-500 mb-1">归属</label>
              <div class="flex gap-2 mb-2">
                {(["product_set", "customer", "supplier"] as const).map((k) => (
                  <button
                    class={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${entityKind() === k ? "border-primary-500 bg-primary-50 text-primary-700" : "border-surface-200 text-surface-600 hover:bg-surface-50"}`}
                    onClick={() => { setEntityKind(k); setEntityName(""); }}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
              <input
                type="text"
                class="input w-full"
                placeholder={entityKind() === "product_set" ? "产品集名称" : entityKind() === "customer" ? "客户名称" : "供应商名称"}
                list="note-entities"
                value={entityName()}
                onInput={(e) => setEntityName(e.currentTarget.value)}
              />
              <datalist id="note-entities">
                <For each={entityOptions()}>
                  {(e) => <option value={e} />}
                </For>
              </datalist>
            </div>
            <input
              type="text"
              class="input w-full mb-4"
              placeholder="笔记标题（保存为 .md）"
              value={title()}
              disabled={creating()}
              onInput={(e) => setTitle(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void createNote()}
            />
            <div class="flex gap-3 justify-end">
              <button class="btn-secondary" onClick={() => setShowNew(false)}>取消</button>
              <button
                class="btn-primary"
                disabled={creating() || !entityName().trim() || !title().trim()}
                onClick={() => void createNote()}
              >
                创建并编辑
              </button>
            </div>
          </div>
        </Modal>
      </Show>
    </div>
  );
}
