import { Show, For, createSignal, createEffect } from "solid-js";
import {
  currentWorkspace,
  workspaceConfig,
  loadWorkspaceConfig,
  updateWorkspaceConfig,
  defaultWorkspaceConfig,
} from "~/stores/workspace";
import { api } from "~/wails/api";
import { loadTagDefs, refreshTags } from "~/stores/tags";
import type { ApiResult, TagInfo, WorkspaceConfig } from "~/types";

/** 预设色板（标签颜色选择） */
const PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#22c55e",
  "#14b8a6", "#0ea5e9", "#3b82f6", "#8b5cf6", "#ec4899",
  "#64748b",
];

export default function Settings() {
  const [config, setConfig] = createSignal<WorkspaceConfig>(defaultWorkspaceConfig());
  const [newImageFolder, setNewImageFolder] = createSignal("");
  const [newCertFolder, setNewCertFolder] = createSignal("");
  const [saved, setSaved] = createSignal(false);

  createEffect(() => {
    if (currentWorkspace()) {
      loadWorkspaceConfig();
    }
  });

  createEffect(() => {
    const c = workspaceConfig();
    if (c) {
      setConfig(c);
    }
  });

  const handleSave = async () => {
    const success = await updateWorkspaceConfig(config());
    if (success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const addImageFolder = () => {
    const name = newImageFolder().trim();
    if (!name) return;
    setConfig((prev) => ({
      ...prev,
      image_subfolders: [...prev.image_subfolders, name],
    }));
    setNewImageFolder("");
  };

  const removeImageFolder = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      image_subfolders: prev.image_subfolders.filter((_, i) => i !== index),
    }));
  };

  const addCertFolder = () => {
    const name = newCertFolder().trim();
    if (!name) return;
    setConfig((prev) => ({
      ...prev,
      cert_subfolders: [...prev.cert_subfolders, name],
    }));
    setNewCertFolder("");
  };

  const removeCertFolder = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      cert_subfolders: prev.cert_subfolders.filter((_, i) => i !== index),
    }));
  };

  // —— v2.2.1：子文件夹重命名（立即生效并同步迁移所有已有产品集）——
  const [renamingFolder, setRenamingFolder] = createSignal<{ type: "image" | "cert"; oldName: string } | null>(null);
  const [subfolderRenameValue, setSubfolderRenameValue] = createSignal("");
  const [renameError, setRenameError] = createSignal("");

  const startRename = (type: "image" | "cert", oldName: string) => {
    setRenamingFolder({ type, oldName });
    setSubfolderRenameValue(oldName);
    setRenameError("");
  };

  const cancelRename = () => {
    setRenamingFolder(null);
    setSubfolderRenameValue("");
    setRenameError("");
  };

  const confirmRename = async () => {
    const target = renamingFolder();
    if (!target) return;
    const newName = subfolderRenameValue().trim();
    if (!newName) {
      setRenameError("名称不能为空");
      return;
    }
    const r = await api.workspace.renameSubfolder(target.type, target.oldName, newName);
    if (r.success && r.data) {
      setConfig(r.data);
      await loadWorkspaceConfig();
      cancelRename();
    } else {
      setRenameError(r.error || "重命名失败");
    }
  };

  /** 子文件夹 chip（图包/证书通用）：名称 + ✎重命名 + ✕删除；重命名中变输入框 */
  const SubfolderChip = (props: {
    name: string;
    type: "image" | "cert";
    onRemove: (index: number) => void;
    index: number;
  }) => {
    const isRenaming = () => renamingFolder()?.type === props.type && renamingFolder()?.oldName === props.name;
    return (
      <Show
        when={!isRenaming()}
        fallback={
          <span class="inline-flex items-center gap-1 px-3 py-1.5 bg-surface-100 rounded-lg text-sm">
            <input
              class="w-32 px-1.5 py-0.5 border border-primary-300 rounded text-sm focus:outline-none"
              value={subfolderRenameValue()}
              autofocus
              onInput={(e) => setSubfolderRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmRename();
                if (e.key === "Escape") cancelRename();
              }}
            />
            <button class="text-primary-600 hover:text-primary-700 text-xs" onClick={() => void confirmRename()}>✓</button>
            <button class="text-surface-400 hover:text-surface-600 text-xs" onClick={cancelRename}>✕</button>
          </span>
        }
      >
        <span class="inline-flex items-center gap-1 px-3 py-1.5 bg-surface-100 rounded-lg text-sm">
          <span>{props.name}</span>
          <button class="text-surface-400 hover:text-primary-600 ml-0.5" title="重命名（同步所有产品集）" onClick={() => startRename(props.type, props.name)}>
            ✎
          </button>
          <button class="text-surface-400 hover:text-red-500 ml-0.5" onClick={() => props.onRemove(props.index)}>
            ✕
          </button>
        </span>
      </Show>
    );
  };

  const updateNamingField = (field: keyof WorkspaceConfig["naming_template"], value: string) => {
    setConfig((prev) => ({
      ...prev,
      naming_template: {
        ...prev.naming_template,
        [field]: value,
      },
    }));
  };

  // —— 标签管理 ——
  const [tags, setTags] = createSignal<TagInfo[]>([]);
  const [newTagName, setNewTagName] = createSignal("");
  const [newTagColor, setNewTagColor] = createSignal(PALETTE[0]);
  const [newTagParent, setNewTagParent] = createSignal<string | null>(null);
  const [editingColor, setEditingColor] = createSignal<string | null>(null); // 正在改色的标签
  const [renaming, setRenaming] = createSignal<string | null>(null); // 正在重命名的标签
  const [renameValue, setRenameValue] = createSignal("");

  /** 顶层标签（供新建时选父级） */
  const topLevelTags = () => tags().filter((t) => !t.parent);

  const loadTags = async () => {
    const r = await api.tags.list();
    if (r.success && r.data) setTags(r.data);
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadTags();
      loadTagDefs();
    }
  });

  const handleAddTag = async () => {
    const name = newTagName().trim();
    if (!name) return;
    await api.tags.create(name, newTagColor(), newTagParent());
    setNewTagName("");
    setNewTagParent(null);
    await loadTags();
    refreshTags();
  };

  const handleSetColor = async (name: string, color: string) => {
    const r = await api.tags.setColor(name, color);
    if (!r.success && r.error) alert(r.error);
    setEditingColor(null);
    await loadTags();
    refreshTags();
  };

  const handleRename = async (oldName: string) => {
    const newName = renameValue().trim();
    if (!newName || newName === oldName) {
      setRenaming(null);
      return;
    }
    const r = await api.tags.rename(oldName, newName);
    if (r.success) {
      setRenaming(null);
      setRenameValue("");
      await loadTags();
      refreshTags();
    }
  };

  const handleDeleteTag = async (name: string) => {
    if (!confirm(`确定删除标签「${name}」？将同时从所有文件与产品集中移除。`)) return;
    const r = await api.tags.delete(name);
    if (r.success) {
      await loadTags();
      refreshTags();
    }
  };

  const handlePromote = async (name: string) => {
    await api.tags.setParent(name, null);
    await loadTags();
    refreshTags();
  };

  // —— v2.3.0：未定义标签（孤儿）治理 ——
  const orphanTags = () => tags().filter((t) => t.defined === false);
  const [adoptingOrphan, setAdoptingOrphan] = createSignal<string | null>(null);

  const handleAdopt = async (name: string, color: string) => {
    const r = await api.tags.adopt(name, color);
    if (!r.success && r.error) alert(r.error);
    setAdoptingOrphan(null);
    await loadTags();
    refreshTags();
  };

  const handleRemoveOrphan = async (name: string) => {
    if (!confirm(`确定清除标签「${name}」的所有引用吗？将从所有文件与产品集中移除。`)) return;
    const r = await api.tags.delete(name);
    if (r.success) {
      await loadTags();
      refreshTags();
    }
  };

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="mb-8">
        <h1 class="text-2xl font-bold text-surface-900">设置</h1>
        <p class="text-surface-500 mt-1">配置当前工作区的命名规则和文件夹类型</p>
      </div>

      <Show
        when={currentWorkspace()}
        fallback={
          <div class="card p-12 text-center">
            <div class="text-4xl mb-3">⚙️</div>
            <h3 class="text-lg font-medium text-surface-700">未选择工作区</h3>
            <p class="text-sm text-surface-400 mt-1">请先创建或打开一个工作区</p>
          </div>
        }
      >
        <div class="space-y-6">
          {/* 标签管理 */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-2">标签管理</h2>
            <p class="text-sm text-surface-500 mb-4">统一管理标签颜色；重命名/删除会同步所有文件与产品集</p>

            {/* 新建标签 */}
            <div class="flex items-center gap-2 mb-4 flex-wrap">
              <input
                class="px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 w-36"
                placeholder="标签名称"
                value={newTagName()}
                onInput={(e) => setNewTagName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
              />
              <select
                class="px-2 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                value={newTagParent() ?? ""}
                onChange={(e) => setNewTagParent(e.currentTarget.value || null)}
              >
                <option value="">顶层标签</option>
                <For each={topLevelTags()}>
                  {(t) => <option value={t.name}>作为 {t.name} 的子标签</option>}
                </For>
              </select>
              <div class="flex items-center gap-1">
                <For each={PALETTE}>
                  {(c) => (
                    <button
                      class={`w-5 h-5 rounded-full transition-transform ${newTagColor() === c ? "ring-2 ring-offset-1 ring-surface-700 scale-110" : ""}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setNewTagColor(c)}
                    />
                  )}
                </For>
              </div>
              <button class="btn-primary px-3 py-2 text-sm" onClick={handleAddTag}>
                + 添加
              </button>
            </div>

            {/* 标签树（顶层 + 子标签） */}
            <Show
              when={topLevelTags().length > 0}
              fallback={<div class="text-sm text-surface-400 py-4 text-center">暂无标签，先给文件或产品集打上标签吧</div>}
            >
              <div class="space-y-1">
                <For each={topLevelTags()}>
                  {(tag) => (
                    <>
                      <div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface-100 transition-colors">
                        <button
                          class="w-5 h-5 rounded-full shrink-0 cursor-pointer"
                          style={{ backgroundColor: tag.color }}
                          title={tag.builtin ? "固定色标签（颜色不可改）" : "点击改颜色"}
                          onClick={() => !tag.builtin && setEditingColor(editingColor() === tag.name ? null : tag.name)}
                        />
                        <Show when={editingColor() === tag.name && !tag.builtin}>
                          <div class="flex items-center gap-1">
                            <For each={PALETTE}>
                              {(c) => (
                                <button
                                  class={`w-4 h-4 rounded-full ${tag.color === c ? "ring-2 ring-offset-1 ring-surface-700" : ""}`}
                                  style={{ backgroundColor: c }}
                                  onClick={() => handleSetColor(tag.name, c)}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                        <Show
                          when={renaming() === tag.name}
                          fallback={
                            <span class="text-sm font-medium flex-1">
                              {tag.name}
                              {tag.builtin && <span class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-400">固定色</span>}
                            </span>
                          }
                        >
                          <input
                            class="px-2 py-1 border border-surface-200 rounded text-sm flex-1 min-w-0"
                            value={renameValue()}
                            onInput={(e) => setRenameValue(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRename(tag.name);
                              if (e.key === "Escape") setRenaming(null);
                            }}
                          />
                        </Show>
                        <span class="text-xs text-surface-400 shrink-0">{tag.count} 处</span>
                        <button
                          class="text-xs text-surface-500 hover:text-primary-600 shrink-0"
                          onClick={() => {
                            setRenaming(tag.name);
                            setRenameValue(tag.name);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          class="text-xs text-red-500 hover:text-red-600 shrink-0"
                          onClick={() => handleDeleteTag(tag.name)}
                        >
                          删除
                        </button>
                      </div>

                      {/* 子标签（缩进） */}
                      <Show when={tag.children.length > 0}>
                        <div class="ml-8 border-l-2 border-surface-100 pl-3 space-y-1">
                          <For each={tag.children}>
                            {(childName) => {
                              const child = tags().find((t) => t.name === childName);
                              if (!child) return null;
                              return (
                                <div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-surface-100 transition-colors">
                                  <button
                                    class="w-4 h-4 rounded-full shrink-0 cursor-pointer"
                                    style={{ backgroundColor: child.color }}
                                    title={child.builtin ? "固定色标签" : "点击改颜色"}
                                    onClick={() => !child.builtin && setEditingColor(editingColor() === child.name ? null : child.name)}
                                  />
                                  <Show when={editingColor() === child.name && !child.builtin}>
                                    <div class="flex items-center gap-1">
                                      <For each={PALETTE}>
                                        {(c) => (
                                          <button
                                            class={`w-4 h-4 rounded-full ${child.color === c ? "ring-2 ring-offset-1 ring-surface-700" : ""}`}
                                            style={{ backgroundColor: c }}
                                            onClick={() => handleSetColor(child.name, c)}
                                          />
                                        )}
                                      </For>
                                    </div>
                                  </Show>
                                  <Show
                                    when={renaming() === child.name}
                                    fallback={
                                      <span class="text-sm flex-1 min-w-0">
                                        <span class="text-[11px] text-surface-400 mr-1">└ {tag.name}/</span>
                                        <span class="font-medium">{child.name}</span>
                                      </span>
                                    }
                                  >
                                    <input
                                      class="px-2 py-1 border border-surface-200 rounded text-sm flex-1 min-w-0"
                                      value={renameValue()}
                                      onInput={(e) => setRenameValue(e.currentTarget.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") handleRename(child.name);
                                        if (e.key === "Escape") setRenaming(null);
                                      }}
                                    />
                                  </Show>
                                  <span class="text-xs text-surface-400 shrink-0">{child.count} 处</span>
                                  <button
                                    class="text-xs text-surface-500 hover:text-primary-600 shrink-0"
                                    title="提升为顶层标签"
                                    onClick={() => handlePromote(child.name)}
                                  >
                                    ⬆ 顶层
                                  </button>
                                  <button
                                    class="text-xs text-surface-500 hover:text-primary-600 shrink-0"
                                    onClick={() => {
                                      setRenaming(child.name);
                                      setRenameValue(child.name);
                                    }}
                                  >
                                    重命名
                                  </button>
                                  <button
                                    class="text-xs text-red-500 hover:text-red-600 shrink-0"
                                    onClick={() => handleDeleteTag(child.name)}
                                  >
                                    删除
                                  </button>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </>
                  )}
                </For>
              </div>
            </Show>

            {/* v2.3.0：未定义标签（孤儿）治理区块 */}
            <Show when={orphanTags().length > 0}>
              <div class="mt-4 pt-3 border-t border-surface-100">
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-sm font-medium text-surface-600">未定义标签</span>
                  <span class="text-[11px] text-surface-400">
                    存在于文件/产品集但未在此定义（历史自由输入或 AI 打标引入），可转为正式标签或清除引用
                  </span>
                </div>
                <div class="space-y-1">
                  <For each={orphanTags()}>
                    {(tag) => (
                      <div class="flex items-center gap-3 py-2 px-3 rounded-lg bg-amber-50/60 hover:bg-amber-50 transition-colors">
                        <button
                          class="w-5 h-5 rounded-full shrink-0 cursor-default bg-surface-300 border border-dashed border-surface-400"
                          title="未定义标签"
                        />
                        <span class="text-sm font-medium flex-1 text-amber-800">{tag.name}</span>
                        <span class="text-xs text-surface-400 shrink-0">{tag.count} 处</span>
                        <Show when={adoptingOrphan() === tag.name}>
                          <div class="flex items-center gap-1">
                            <For each={PALETTE}>
                              {(c) => (
                                <button
                                  class="w-4 h-4 rounded-full"
                                  style={{ backgroundColor: c }}
                                  onClick={() => handleAdopt(tag.name, c)}
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                        <button
                          class="text-xs text-surface-500 hover:text-primary-600 shrink-0"
                          onClick={() => setAdoptingOrphan(adoptingOrphan() === tag.name ? null : tag.name)}
                        >
                          {adoptingOrphan() === tag.name ? "取消" : "转为正式标签"}
                        </button>
                        <button
                          class="text-xs text-red-500 hover:text-red-600 shrink-0"
                          onClick={() => handleRemoveOrphan(tag.name)}
                        >
                          清除引用
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>

          {/* Naming Template */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">命名模板</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">产品集前缀</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={config().naming_template.product_set_prefix}
                  onInput={(e) => updateNamingField("product_set_prefix", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">产品集后缀</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={config().naming_template.product_set_suffix}
                  onInput={(e) => updateNamingField("product_set_suffix", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">SKU 分隔符</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={config().naming_template.sku_separator}
                  onInput={(e) => updateNamingField("sku_separator", e.currentTarget.value)}
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">冲突后缀模板</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={config().naming_template.conflict_suffix}
                  onInput={(e) => updateNamingField("conflict_suffix", e.currentTarget.value)}
                />
                <p class="text-xs text-surface-400 mt-1">使用 {"{n}"} 表示序号</p>
              </div>
            </div>
          </div>

          {/* Image Subfolders */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">图包子文件夹</h2>
            <div class="flex gap-2 mb-4">
              <input
                type="text"
                class="flex-1 px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="新增子文件夹名称"
                value={newImageFolder()}
                onInput={(e) => setNewImageFolder(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addImageFolder()}
              />
              <button class="btn-primary" onClick={addImageFolder}>
                添加
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              <For each={config().image_subfolders}>
                {(folder, index) => (
                  <SubfolderChip name={folder} type="image" index={index()} onRemove={removeImageFolder} />
                )}
              </For>
            </div>
          </div>

          {/* Cert Subfolders */}
          <div class="card p-6">
            <h2 class="text-lg font-semibold mb-4">证书子文件夹</h2>
            <div class="flex gap-2 mb-4">
              <input
                type="text"
                class="flex-1 px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="新增证书类型名称"
                value={newCertFolder()}
                onInput={(e) => setNewCertFolder(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addCertFolder()}
              />
              <button class="btn-primary" onClick={addCertFolder}>
                添加
              </button>
            </div>
            <div class="flex flex-wrap gap-2">
              <For each={config().cert_subfolders}>
                {(folder, index) => (
                  <SubfolderChip name={folder} type="cert" index={index()} onRemove={removeCertFolder} />
                )}
              </For>
            </div>
            <Show when={renameError()}>
              <div class="mt-2 text-sm text-red-600">{renameError()}</div>
            </Show>
          </div>

          <div class="flex items-center gap-4">
            <button class="btn-primary px-6" onClick={handleSave}>
              {saved() ? "已保存 ✓" : "保存设置"}
            </button>
            <Show when={saved()}>
              <span class="text-sm text-green-600">设置已保存到工作区</span>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
