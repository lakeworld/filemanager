import { Show, createSignal, createEffect, For, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import {
  currentWorkspace,
  workspaces,
  createWorkspace,
  openWorkspace,
  loadWorkspaces,
  switchWorkspace,
} from "~/stores/workspace";

export default function Header() {
  const navigate = useNavigate();
  const [showWorkspaceMenu, setShowWorkspaceMenu] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [appVersion, setAppVersion] = createSignal("");

  onMount(async () => {
    try {
      const v = await api.app.version();
      setAppVersion(v);
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    loadWorkspaces();
  });

  const handleNewWorkspace = async () => {
    const selected = await api.dialog.openDirectory("选择工作区文件夹");
    if (selected) {
      await createWorkspace(selected);
      setShowWorkspaceMenu(false);
    }
  };

  const handleOpenWorkspace = async () => {
    const selected = await api.dialog.openDirectory("打开工作区");
    if (selected) {
      await openWorkspace(selected);
      setShowWorkspaceMenu(false);
    }
  };

  const handleSwitchWorkspace = async (path: string) => {
    await switchWorkspace(path);
    setShowWorkspaceMenu(false);
  };

  const handleSearch = (e: KeyboardEvent) => {
    if (e.key === "Enter" && searchQuery()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery())}`);
    }
  };

  return (
    <header
      class="h-14 flex items-center gap-4 px-6 bg-surface-0 border-b border-surface-200"
      style={{ "--wails-draggable": "drag" }}
    >
      <div class="relative flex-1 max-w-md" style={{ "--wails-draggable": "no-drag" }}>
        <div class="absolute inset-y-0 left-3 flex items-center pointer-events-none">
          <span class="text-surface-400">🔍</span>
        </div>
        <input
          type="text"
          placeholder="全局搜索 (Ctrl+K)"
          class="w-full pl-9 pr-4 py-2 bg-surface-100 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          onKeyDown={handleSearch}
          style={{ "--wails-draggable": "no-drag" }}
        />
      </div>

      <div class="flex-1" />

      <Show when={appVersion()}>
        <span class="text-xs text-surface-400 px-2 py-1 rounded bg-surface-100 pointer-events-none">
          v{appVersion()}
        </span>
      </Show>

      <div class="relative" style={{ "--wails-draggable": "no-drag" }}>
        <button
          class="flex items-center gap-2 px-3 py-2 rounded-lg border border-surface-200 hover:bg-surface-100 transition-colors"
          onClick={() => setShowWorkspaceMenu(!showWorkspaceMenu())}
          style={{ "--wails-draggable": "no-drag" }}
        >
          <span>🏢</span>
          <Show when={currentWorkspace()} fallback={<span class="text-sm text-surface-500">选择工作区</span>}>
            <span class="text-sm font-medium max-w-[200px] truncate">{currentWorkspace()?.name}</span>
          </Show>
          <span class="text-surface-400">▼</span>
        </button>

        <Show when={showWorkspaceMenu()}>
          <div class="absolute right-0 top-full mt-1 w-72 bg-surface-0 rounded-xl border border-surface-200 shadow-lg z-50 py-1" style={{ "--wails-draggable": "no-drag" }}>
            <button class="w-full text-left px-4 py-2.5 text-sm hover:bg-surface-100 transition-colors" onClick={handleNewWorkspace}>
              <span class="mr-2">➕</span> 新建工作区
            </button>
            <button class="w-full text-left px-4 py-2.5 text-sm hover:bg-surface-100 transition-colors" onClick={handleOpenWorkspace}>
              <span class="mr-2">📂</span> 打开工作区
            </button>

            <Show when={workspaces().length > 0}>
              <div class="border-t border-surface-200 my-1" />
              <div class="px-4 py-1.5 text-xs font-medium text-surface-400">最近工作区</div>
              <For each={workspaces()}>
                {(ws) => (
                  <button
                    class={`w-full text-left px-4 py-2 text-sm hover:bg-surface-100 transition-colors ${currentWorkspace()?.path === ws.path ? "text-primary-700 bg-primary-50" : "text-surface-700"}`}
                    onClick={() => handleSwitchWorkspace(ws.path)}
                  >
                    <div class="flex items-center gap-2">
                      <span>📁</span>
                      <span class="truncate flex-1">{ws.name}</span>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </header>
  );
}
