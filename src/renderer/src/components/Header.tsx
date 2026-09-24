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
import { appSettings, appSettingsReady, reloadAppSettings, setAppSetting } from "~/stores/appSettings";
import { showToast } from "~/stores/notifyBanner";

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

  /** v2.6.1：默认工作区指针（userData/settings.json 的 defaultWorkspace，空串 = 未设） */
  const defaultWsPath = () => appSettings().defaultWorkspace;
  const isDefaultWs = (p: string) => defaultWsPath() === p;

  /**
   * 设为默认 / 再点取消默认。写失败必须 await 重拉再报——菜单里这行「默认」标记是受控的，
   * 不重拉就会留下「看着设上了、其实没落盘」的假象（同 Settings.tsx savePref 的口径）。
   * 不关菜单：用户可能要接着看哪一个是默认。
   */
  const handleToggleDefaultWorkspace = async (p: string) => {
    const ok = await setAppSetting({ defaultWorkspace: isDefaultWs(p) ? "" : p });
    if (!ok) {
      await reloadAppSettings();
      showToast("error", "设置失败", "默认工作区没能保存，已恢复为磁盘上的当前值");
    }
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
      {/*
        v2.5.9 A6-2：全局「← 后退」。此前详情页（`/product-sets/:name` 等）只能靠侧栏重新点进列表，
        「搜到 → 打开 → 退回搜索结果」这条最常用的动线断在最后一步。走 `navigate(-1)` 吃浏览器历史，
        不自己记栈（记栈等于再造一套导航状态，和路由器必然漂移）。
        形状走统一清单的 `.icon-btn`（§一.8 两条合法路之一），不手搓长串。
      */}
      <button
        type="button"
        class="icon-btn"
        aria-label="后退"
        title="后退（返回上一页）"
        onClick={() => navigate(-1)}
        style={{ "-webkit-app-region": "no-drag" }}
      >
        ←
      </button>
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
                  <div class="flex items-center">
                    <button
                      class={`row-btn min-w-0 flex-1 py-2 text-sm hover:bg-surface-100 ${currentWorkspace()?.path === ws.path ? "text-primary-700 bg-primary-50" : "text-surface-700"}`}
                      onClick={() => handleSwitchWorkspace(ws.path)}
                    >
                      <div class="flex min-w-0 flex-1 items-center gap-2">
                        <span>📁</span>
                        <span class="truncate flex-1">{ws.name}</span>
                        <Show when={isDefaultWs(ws.path)}>
                          <span class="shrink-0 text-xs text-primary-600">默认</span>
                        </Show>
                      </div>
                    </button>
                    {/* v2.6.1：默认工作区开关就地放在挑工作区这一动线上（不进设置页另开一份）。
                        镜像未拉回前置灰：否则用户在「还没读到磁盘值」的窗口里点了它，会把标记写成假的。 */}
                    <button
                      type="button"
                      class="row-btn shrink-0 px-3 py-2 text-xs text-surface-400 hover:bg-surface-100 hover:text-primary-700"
                      disabled={!appSettingsReady()}
                      aria-label={isDefaultWs(ws.path) ? "取消默认工作区" : "设为默认工作区"}
                      title={isDefaultWs(ws.path) ? "取消默认（启动回到「开最近用过的那个」）" : "设为默认：以后每次启动都打开这个工作区"}
                      onClick={() => void handleToggleDefaultWorkspace(ws.path)}
                    >
                      {isDefaultWs(ws.path) ? "取消默认" : "设为默认"}
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </header>
  );
}
