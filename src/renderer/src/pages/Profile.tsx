import { Show, For, createSignal, onCleanup, onMount } from "solid-js";
import { api } from "~/wails/api";
import { simpleMarkdownToHtml } from "~/utils/markdown";
import helpMarkdown from "../../../../HELP.md?raw";
import privacyMarkdown from "../../../../PRIVACY.md?raw";
import type { UpdateInfo } from "~/types";

type SectionKey = "update" | "help" | "privacy";

const icons = {
  update: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
  ),
  help: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
  ),
  privacy: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  ),
};

const menuItems: { key: SectionKey; label: string; desc: string }[] = [
  { key: "update", label: "检查更新", desc: "版本、下载、自动安装" },
  { key: "help", label: "使用帮助", desc: "功能说明与常见问题" },
  { key: "privacy", label: "隐私协议", desc: "数据与隐私说明" },
];

export default function Profile() {
  const [active, setActive] = createSignal<SectionKey>("update");
  const [version, setVersion] = createSignal("");
  const [updatePhase, setUpdatePhase] = createSignal<
    "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "error"
  >("idle");
  const [latestVersion, setLatestVersion] = createSignal<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = createSignal(0);
  const [installerPath, setInstallerPath] = createSignal("");
  const [updateError, setUpdateError] = createSignal("");

  onMount(async () => {
    try {
      const v = await api.app.version();
      setVersion(v);
    } catch {
      setVersion("");
    }

    const unsubscribe = window.qihebox.events.on("update:progress", (payload: any) => {
      setDownloadProgress(payload?.percent ?? 0);
    });

    onCleanup(() => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    });
  });

  const checkUpdate = async () => {
    setUpdateError("");
    setUpdatePhase("checking");
    try {
      const result = await api.updater.check();
      if (!result.success) {
        throw new Error(result.error || "检查更新失败");
      }
      const info = result.data;
      if (info && info.version) {
        setLatestVersion(info);
        setUpdatePhase("available");
      } else {
        setLatestVersion(null);
        setUpdatePhase("latest");
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdatePhase("error");
    }
  };

  const downloadUpdate = async () => {
    const info = latestVersion();
    if (!info) return;
    setUpdateError("");
    setUpdatePhase("downloading");
    setDownloadProgress(0);
    try {
      const result = await api.updater.download(info);
      if (!result.success || !result.data) {
        throw new Error(result.error || "下载更新失败");
      }
      setInstallerPath(result.data);
      setUpdatePhase("ready");
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdatePhase("available");
    }
  };

  const applyUpdate = async () => {
    const path = installerPath();
    const info = latestVersion();
    if (!path || !info) return;
    if (!confirm("即将关闭应用并安装新版本，请保存好工作区数据。是否继续？")) {
      return;
    }
    setUpdateError("");
    try {
      const result = await api.updater.apply(path, info.checksum);
      if (!result.success) {
        throw new Error(result.error || "启动更新失败");
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdatePhase("ready");
    }
  };

  const openDownloadPage = () => {
    // 触发主进程 setWindowOpenHandler → 系统浏览器打开官网文件管理页
    window.open("https://www.qihebook.cloud/file-manager", "_blank");
  };

  const helpHtml = () => simpleMarkdownToHtml(helpMarkdown);
  const privacyHtml = () => simpleMarkdownToHtml(privacyMarkdown);

  const displayVersion = () => version() || "1.2.4";

  return (
    <div class="h-full overflow-y-auto bg-surface-50 p-6 lg:p-8">
      <div class="mx-auto max-w-6xl">
        {/* Header */}
        <div class="mb-6 rounded-2xl border border-surface-200 bg-gradient-to-r from-primary-600 to-primary-500 p-6 text-white shadow-card">
          <div class="flex items-center justify-between gap-4">
            <div>
              <h1 class="text-2xl font-bold">我的</h1>
              <p class="mt-1 text-sm text-primary-100">更新、帮助与隐私</p>
            </div>
            <div class="hidden rounded-xl bg-white/15 px-4 py-2 text-center backdrop-blur sm:block">
              <div class="text-xs text-primary-100">当前版本</div>
              <div class="text-xl font-bold">v{displayVersion()}</div>
            </div>
          </div>
        </div>

        <div class="grid gap-6 lg:grid-cols-[280px_1fr]">
          {/* Left menu */}
          <div class="space-y-4">
            <div class="rounded-2xl border border-surface-200 bg-white p-2 shadow-card">
              <For each={menuItems}>
                {(item) => {
                  const isActive = () => active() === item.key;
                  return (
                    <button
                      class="group w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all"
                      classList={{
                        "bg-primary-50 shadow-sm": isActive(),
                        "hover:bg-surface-50": !isActive(),
                      }}
                      onClick={() => setActive(item.key)}
                    >
                      <span
                        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors"
                        classList={{
                          "bg-primary-100 text-primary-700": isActive(),
                          "bg-surface-100 text-surface-500 group-hover:bg-surface-200": !isActive(),
                        }}
                      >
                        {icons[item.key]}
                      </span>
                      <div class="min-w-0">
                        <div
                          class="text-sm font-semibold"
                          classList={{
                            "text-primary-800": isActive(),
                            "text-surface-700": !isActive(),
                          }}
                        >
                          {item.label}
                        </div>
                        <div class="truncate text-xs text-surface-400">{item.desc}</div>
                      </div>
                      <Show when={isActive()}>
                        <svg class="ml-auto h-4 w-4 text-primary-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>

            <div class="rounded-2xl border border-surface-200 bg-white p-4 shadow-card sm:hidden">
              <div class="text-xs font-medium uppercase tracking-wider text-surface-400">当前版本</div>
              <div class="mt-1 text-xl font-bold text-surface-900">v{displayVersion()}</div>
            </div>

            <div class="rounded-2xl border border-surface-200 bg-white p-4 shadow-card">
              <div class="text-xs font-medium uppercase tracking-wider text-surface-400">需要帮助？</div>
              <p class="mt-1 text-sm text-surface-600">遇到问题可先查看「使用帮助」，或前往官网下载最新版。</p>
              <button
                class="mt-3 inline-flex items-center gap-1 rounded-lg bg-surface-100 px-3 py-1.5 text-xs font-semibold text-surface-700 transition hover:bg-surface-200"
                onClick={openDownloadPage}
              >
                前往官网
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
              </button>
            </div>
          </div>

          {/* Right content */}
          <div class="min-w-0">
            <Show when={active() === "update"}>
              <div class="rounded-2xl border border-surface-200 bg-white p-6 shadow-card">
                <div class="mb-6 flex items-center justify-between gap-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">{icons.update}</span>
                      <h2 class="text-lg font-semibold text-surface-900">检查更新</h2>
                    </div>
                    <p class="mt-1 text-xs text-surface-400">启禾文件管理 v{displayVersion()}</p>
                  </div>
                  <button
                    class="shrink-0 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:opacity-50"
                    onClick={() => checkUpdate()}
                    disabled={updatePhase() === "checking" || updatePhase() === "downloading"}
                  >
                    {updatePhase() === "checking" ? "检查中..." : "检查更新"}
                  </button>
                </div>

                <Show when={updatePhase() === "latest"}>
                  <div class="rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700">
                    <div class="font-semibold">当前已是最新版本 v{displayVersion()} 🎉</div>
                    <p class="mt-1 text-xs text-green-600">
                      自动更新安装通道尚未开放，需要全新安装包请前往官网下载。
                    </p>
                    <button
                      class="mt-3 inline-flex items-center gap-1 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-primary-700"
                      onClick={openDownloadPage}
                    >
                      📦 前往官网下载
                    </button>
                  </div>
                </Show>

                <Show when={updatePhase() === "available" && latestVersion()}>
                  <div class="rounded-xl bg-primary-50 px-4 py-3 text-sm text-primary-700">
                    <div class="font-semibold">发现新版本：v{latestVersion()?.version}</div>
                    <Show when={latestVersion()?.release_notes}>
                      <div class="mt-1 text-primary-600">{latestVersion()?.release_notes}</div>
                    </Show>
                    <div class="mt-3 flex items-center gap-3">
                      <button
                        class="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-primary-700"
                        onClick={downloadUpdate}
                      >
                        下载更新
                      </button>
                      <button
                        class="rounded-md border border-primary-200 bg-white px-3 py-1.5 text-xs font-semibold text-primary-600 transition hover:bg-primary-50"
                        onClick={openDownloadPage}
                      >
                        前往官网
                      </button>
                    </div>
                  </div>
                </Show>

                <Show when={updatePhase() === "downloading"}>
                  <div class="rounded-xl bg-primary-50 px-4 py-3 text-sm text-primary-700">
                    <div class="mb-2 flex items-center justify-between">
                      <span class="font-semibold">正在下载新版本...</span>
                      <span class="text-xs font-medium">{downloadProgress()}%</span>
                    </div>
                    <div class="h-2 w-full overflow-hidden rounded-full bg-primary-100">
                      <div
                        class="h-full bg-primary-600 transition-all duration-200"
                        style={{ width: `${downloadProgress()}%` }}
                      />
                    </div>
                  </div>
                </Show>

                <Show when={updatePhase() === "ready" && latestVersion()}>
                  <div class="rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700">
                    <div class="font-semibold">v{latestVersion()?.version} 已下载完成</div>
                    <p class="mt-1 text-xs text-green-600">校验通过，点击按钮后将关闭应用并安装新版。</p>
                    <button
                      class="mt-3 rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-700"
                      onClick={applyUpdate}
                    >
                      立即更新并重启
                    </button>
                  </div>
                </Show>

                <Show when={updatePhase() === "error" || updateError()}>
                  <div class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
                    <div>{updateError() || "检查更新失败，请确认网络连接后重试。"}</div>
                    <div class="mt-3 flex items-center gap-3">
                      <button
                        class="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700"
                        onClick={() => checkUpdate()}
                      >
                        重试
                      </button>
                      <button
                        class="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                        onClick={openDownloadPage}
                      >
                        前往官网
                      </button>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={active() === "help"}>
              <div class="rounded-2xl border border-surface-200 bg-white p-6 shadow-card">
                <div class="mb-4 flex items-center gap-2 border-b border-surface-100 pb-4">
                  <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">{icons.help}</span>
                  <h2 class="text-lg font-semibold text-surface-900">使用帮助</h2>
                </div>
                <div class="max-h-[70vh] overflow-y-auto pr-2">
                  <div class="prose prose-sm max-w-none" innerHTML={helpHtml()} />
                </div>
              </div>
            </Show>

            <Show when={active() === "privacy"}>
              <div class="rounded-2xl border border-surface-200 bg-white p-6 shadow-card">
                <div class="mb-4 flex items-center gap-2 border-b border-surface-100 pb-4">
                  <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">{icons.privacy}</span>
                  <h2 class="text-lg font-semibold text-surface-900">隐私协议</h2>
                </div>
                <div class="max-h-[70vh] overflow-y-auto pr-2">
                  <div class="prose prose-sm max-w-none" innerHTML={privacyHtml()} />
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
