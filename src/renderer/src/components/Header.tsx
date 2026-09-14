import { Show, createSignal, createEffect, For, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { api } from "~/wails/api";
import { registerShortcut } from "~/shortcuts";
import { pushLayer } from "~/components/ui/layerStack";
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
  /** v2.5.8 D19（B8）：工作区菜单容器（点外部关闭的判定根） */
  let workspaceMenuRef: HTMLDivElement | undefined;

  /**
   * v2.5.8 D19（B8）：工作区下拉菜单**点外部收起 + Esc 收起**。
   * 此前全仓只有这一层弹出层没有外部点击关闭（`ContextMenu:64-74`、`TagInput:196-213`、
   * `DatePicker`、`SearchSelect` 都有），开开后只能再点触发钮收起。
   * Esc 走 `ui/layerStack` 的 `pushLayer` 而**不是自己加 keydown 监听**：
   * 全站快捷键派发单点由 `tests/unit/shortcuts.test.ts:124` 钉成常量 14，
   * 且弹层让位次序本来就是层栈的语义（后开先关），自己挂监听等于再造第二套。
   */
  createEffect(() => {
    if (!showWorkspaceMenu()) return;
    const layer = pushLayer({ onEscape: () => setShowWorkspaceMenu(false) });
    const onDown = (e: MouseEvent): void => {
      if (workspaceMenuRef && !workspaceMenuRef.contains(e.target as Node)) setShowWorkspaceMenu(false);
    };
    window.addEventListener("mousedown", onDown);
    onCleanup(() => {
      layer.remove();
      window.removeEventListener("mousedown", onDown);
    });
  });
  const [appVersion, setAppVersion] = createSignal("");

  onMount(async () => {
    try {
      const v = await api.app.version();
      setAppVersion(v);
    } catch {
      // ignore
    }
  });

  // P0-1：全局快捷键 Ctrl/Cmd+K 聚焦搜索框（输入框/文本域内不劫持）
  // v2.5.7（A1 同行修正，审：测-P1-8）：contenteditable（Crepe 编辑器）一并豁免——否则编辑中 Ctrl+K 被抢焦点
  // v2.5.8 D11（W6）：监听与输入态守卫上移到 `shortcuts.ts` 单注册点，本处只留「聚焦」这个动作；
  // 守卫口径原样未动（`isTextTarget` 就是这里那三行 tag + isContentEditable 判断搬过去的）
  onMount(() => {
    const off = registerShortcut("search.focus", () => {
      document.getElementById("global-search-input")?.focus();
      return true;
    }, { pageOnly: true }); // 弹窗开着时不抢焦点：搜索框在弹窗外，聚焦它等于把用户从工作面上踢走
    onCleanup(off);
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
      class="h-14 flex items-center gap-4 px-6 bg-surface-0/80 backdrop-blur border-b border-surface-200 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.55)] relative z-20"
      style={{ "-webkit-app-region": "drag" }}
    >
      <div class="relative flex-1 max-w-md" style={{ "-webkit-app-region": "no-drag" }}>
        <div class="absolute inset-y-0 left-3 flex items-center pointer-events-none">
          <span class="text-surface-400">🔍</span>
        </div>
        <input
          id="global-search-input"
          type="text"
          placeholder="全局搜索 (Ctrl+K)"
          class="w-full pl-9 pr-4 py-2 bg-surface-100 border border-surface-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-colors"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          onKeyDown={handleSearch}
          style={{ "-webkit-app-region": "no-drag" }}
        />
      </div>

      <div class="flex-1" />

      <Show when={appVersion()}>
        <span class="text-xs text-surface-400 px-2 py-1 rounded bg-surface-100 pointer-events-none">
          v{appVersion()}
        </span>
      </Show>

      <div class="relative" ref={workspaceMenuRef} style={{ "-webkit-app-region": "no-drag" }}>
        {/* v2.5.8 D14（样式统一）：下拉触发钮挂 .link-btn 走统一节奏（过渡/禁用态），
            尺寸与描边材质（px-3 py-2 rounded-lg border）按「不改观感」原样留在调用点 */}
        <button
          class="link-btn gap-2 px-3 py-2 rounded-lg border border-surface-200 hover:bg-surface-100"
          onClick={() => setShowWorkspaceMenu(!showWorkspaceMenu())}
          style={{ "-webkit-app-region": "no-drag" }}
        >
          <span>🏢</span>
          <Show when={currentWorkspace()} fallback={<span class="text-sm text-surface-500">选择工作区</span>}>
            <span class="text-sm font-medium max-w-[200px] truncate">{currentWorkspace()?.name}</span>
          </Show>
          <span class="text-surface-400">▼</span>
        </button>

        <Show when={showWorkspaceMenu()}>
          <div class="absolute right-0 top-full mt-1 w-72 bg-surface-0 rounded-xl border border-surface-200 shadow-lg z-50 py-1" style={{ "-webkit-app-region": "no-drag" }}>
            {/* v2.5.8 D14（样式统一）：两个菜单项收进 .row-btn（整行可点档：w-full/text-left/px-4/过渡/按压）；
                `gap-0` 沿用 ContextMenu 口径——图标与文字的间距由子元素 mr-2 提供，不让档的 gap-3 叠加上去 */}
            <button class="row-btn gap-0 text-sm hover:bg-surface-100" onClick={handleNewWorkspace}>
              <span class="mr-2">➕</span> 新建工作区
            </button>
            <button class="row-btn gap-0 text-sm hover:bg-surface-100" onClick={handleOpenWorkspace}>
              <span class="mr-2">📂</span> 打开工作区
            </button>

            <Show when={workspaces().length > 0}>
              <div class="border-t border-surface-200 my-1" />
              <div class="px-4 py-1.5 text-xs font-medium text-surface-400">最近工作区</div>
              <For each={workspaces()}>
                {(ws) => (
                  <button
                    class={`row-btn py-2 text-sm hover:bg-surface-100 ${currentWorkspace()?.path === ws.path ? "text-primary-700 bg-primary-50" : "text-surface-700"}`}
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
