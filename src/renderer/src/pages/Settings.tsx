import { Show, For, createSignal, createEffect } from "solid-js";
import {
  currentWorkspace,
  workspaceConfig,
  loadWorkspaceConfig,
  updateWorkspaceConfig,
  defaultWorkspaceConfig,
} from "~/stores/workspace";
import type { ApiResult, WorkspaceConfig } from "~/types";

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

  const updateNamingField = (field: keyof WorkspaceConfig["naming_template"], value: string) => {
    setConfig((prev) => ({
      ...prev,
      naming_template: {
        ...prev.naming_template,
        [field]: value,
      },
    }));
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
                  <div class="flex items-center gap-1 px-3 py-1.5 bg-surface-100 rounded-lg text-sm">
                    <span>{folder}</span>
                    <button
                      class="text-surface-400 hover:text-red-500 ml-1"
                      onClick={() => removeImageFolder(index())}
                    >
                      ✕
                    </button>
                  </div>
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
                  <div class="flex items-center gap-1 px-3 py-1.5 bg-surface-100 rounded-lg text-sm">
                    <span>{folder}</span>
                    <button
                      class="text-surface-400 hover:text-red-500 ml-1"
                      onClick={() => removeCertFolder(index())}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </div>
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
