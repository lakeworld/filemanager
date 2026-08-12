import { Show, For, createSignal, onCleanup, onMount, createEffect } from "solid-js";
import { api } from "~/wails/api";
import { simpleMarkdownToHtml } from "~/utils/markdown";
import { accountStatus, loginAccount, logoutAccount } from "~/stores/account";
import helpMarkdown from "../../../../HELP.md?raw";
import privacyMarkdown from "../../../../PRIVACY.md?raw";
import type { UpdateInfo } from "~/types";

type SectionKey = "account" | "update" | "help" | "log" | "privacy";

const icons = {
  account: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/></svg>
  ),
  update: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
  ),
  help: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
  ),
  // v2.4.9（S6-2）：日志卡片图标（文档列表）
  log: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg>
  ),
  privacy: (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  ),
};

const menuItems: { key: SectionKey; label: string; desc: string }[] = [
  { key: "account", label: "账号", desc: "登录、账号与统计说明" },
  { key: "update", label: "检查更新", desc: "版本、下载、自动安装" },
  { key: "help", label: "使用帮助", desc: "功能说明与常见问题" },
  { key: "log", label: "日志", desc: "日志文件用于诊断崩溃与异常，本地存储" },
  { key: "privacy", label: "隐私协议", desc: "数据与隐私说明" },
];

export default function Profile() {
  // v2.4.7（评审 P4）：默认激活 Section 改为 account（更新页是低频入口，首屏先看到账号）
  const [active, setActive] = createSignal<SectionKey>("account");
  const [version, setVersion] = createSignal("");
  const [updatePhase, setUpdatePhase] = createSignal<
    "idle" | "checking" | "latest" | "available" | "error"
  >("idle");
  const [latestVersion, setLatestVersion] = createSignal<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = createSignal("");
  // v2.4.9（S6-2）：日志卡片状态（导出中 / 成功提示保存路径 / 失败）
  const [logBusy, setLogBusy] = createSignal(false);
  const [logMsg, setLogMsg] = createSignal("");
  const [logErr, setLogErr] = createSignal("");

  onMount(async () => {
    try {
      const v = await api.app.version();
      setVersion(v);
    } catch {
      setVersion("");
    }

    // v2.4.0：后台定时/启动时发现新版 → 主进程推送 update:available 事件，直接切入可更新态并点亮菜单徽标
    const unsubscribeAvailable = window.qihebox.events.on("update:available", (payload: any) => {
      if (!payload?.version) return;
      setLatestVersion(payload as UpdateInfo);
      setUpdatePhase("available");
    });

    // v2.4.7（评审 P1）：主进程缓存更新可用状态——Profile 懒加载可能错过启动时的 update:available 事件，
    // onMount 主动查一次兜底（缓存有值即切入可更新态）
    try {
      const cached = await api.updater.state();
      if (cached.success && cached.data?.version) {
        setLatestVersion(cached.data);
        setUpdatePhase("available");
      }
    } catch {
      // 查询失败静默（事件订阅与手动检查仍兜底）
    }

    onCleanup(() => {
      if (typeof unsubscribeAvailable === "function") {
        unsubscribeAvailable();
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

  const openDownloadPage = () => {
    // 触发主进程 setWindowOpenHandler → 系统浏览器打开官网文件管理页
    window.open("https://www.qihebook.cloud/file-manager", "_blank");
  };

  // v2.4.9（S6-2）：日志卡片——导出 zip（IPC 薄透传，主进程实现；2026-08-12 用户反馈：不需要打开日志目录，仅保留导出）
  const exportLogs = async () => {
    setLogErr("");
    setLogMsg("");
    setLogBusy(true);
    try {
      const r = await api.log.exportZip();
      if (!r.success) {
        setLogErr(r.error || "导出日志失败");
      } else if (r.data && r.data.path) {
        // 导出成功：提示保存路径（zip 由用户自行发送，应用不调用外部 API）
        setLogMsg(`已导出 ${r.data.count} 个日志文件：${r.data.path}`);
      }
      // path 为空 = 用户取消保存对话框，不提示错误
    } catch (err) {
      setLogErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLogBusy(false);
    }
  };

  const helpHtml = () => simpleMarkdownToHtml(helpMarkdown);
  const privacyHtml = () => simpleMarkdownToHtml(privacyMarkdown);

  // v2.4.7（评审 P4）：应用内下载安装通道未就绪，不再展示下载/安装入口；
  // 版本号获取失败时不编造历史版本号，显示「--」
  const displayVersion = () => version() || "--";

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
                          {/* v2.4.0：有可用更新时点亮红点徽标 */}
                          <Show when={item.key === "update" && updatePhase() === "available"}>
                            <span class="ml-1 align-middle text-xs leading-none text-red-500">●</span>
                          </Show>
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
            <Show when={active() === "account"}>
              <AccountSection />
            </Show>

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
                    disabled={updatePhase() === "checking"}
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
                    {/* v2.4.7（评审 P4）：应用内下载通道未就绪，统一引导前往官网下载全新安装包 */}
                    <button
                      class="mt-3 inline-flex items-center gap-1 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-primary-700"
                      onClick={openDownloadPage}
                    >
                      前往官网下载
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

            {/* v2.4.9（S6-2）：日志卡片——导出 zip（应用级，不随工作区门控） */}
            <Show when={active() === "log"}>
              <div class="rounded-2xl border border-surface-200 bg-white p-6 shadow-card">
                <div class="mb-4 flex items-center gap-2 border-b border-surface-100 pb-4">
                  <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">{icons.log}</span>
                  <h2 class="text-lg font-semibold text-surface-900">日志</h2>
                </div>
                <p class="text-sm text-surface-600">
                  日志文件用于诊断崩溃与异常，本地存储，不上传。需要排查问题时可将日志导出后发给开发者。
                </p>
                <div class="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    class="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:opacity-50"
                    onClick={() => exportLogs()}
                    disabled={logBusy()}
                  >
                    {logBusy() ? "导出中..." : "导出日志"}
                  </button>
                </div>
                <Show when={logMsg()}>
                  <div class="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700 break-all">{logMsg()}</div>
                </Show>
                <Show when={logErr()}>
                  <div class="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{logErr()}</div>
                </Show>
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

// —— 账号区（v2.2.0：可选登录复用 ERP 账号）——

function AccountSection() {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const handleLogin = async () => {
    const e = email().trim();
    if (!e || !password()) {
      setError("请输入邮箱和密码");
      return;
    }
    setBusy(true);
    setError("");
    const r = await loginAccount(e, password());
    if (!r.ok) {
      setError(r.error ?? "登录失败");
    }
    setBusy(false);
  };

  return (
    <div class="rounded-2xl border border-surface-200 bg-white p-6 shadow-card">
      <div class="mb-4 flex items-center gap-2 border-b border-surface-100 pb-4">
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-700">{icons.account}</span>
        <h2 class="text-lg font-semibold text-surface-900">账号</h2>
      </div>

      <Show
        when={accountStatus().loggedIn}
        fallback={
          <>
            {/* 登录价值说明 */}
            <div class="rounded-xl bg-surface-100 px-4 py-3 text-surface-700">
              <div class="font-semibold">登录启禾账号</div>
              <div class="mt-0.5 text-xs text-surface-500">
                登录后自动上报活跃信息（设备标识、版本、使用时间），仅用于统计产品使用情况，可随时登出停止
              </div>
            </div>

            {/* 登录表单 */}
            <form
              class="mt-5 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                handleLogin();
              }}
            >
              <input
                type="email"
                class="w-full rounded-lg border border-surface-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="邮箱"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
              />
              <input
                type="password"
                class="w-full rounded-lg border border-surface-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                placeholder="密码"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
              <Show when={error()}>
                <div class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error()}</div>
              </Show>
              <div class="flex items-center justify-between">
                <button type="submit" class="btn-primary px-5" disabled={busy()}>
                  {busy() ? "登录中..." : "登录"}
                </button>
                <button
                  type="button"
                  class="text-xs text-primary-600 hover:text-primary-700"
                  onClick={() => window.open("https://www.qihebook.cloud/", "_blank")}
                >
                  没有账号？去官网注册 →
                </button>
              </div>
            </form>
          </>
        }
      >
        {/* 已登录态 */}
        <div class="flex items-center gap-4">
          <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-600 text-lg font-bold text-white">
            {(accountStatus().email || "Q").slice(0, 1).toUpperCase()}
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold text-surface-900">{accountStatus().email}</div>
          </div>
          <button
            class="shrink-0 rounded-lg border border-surface-200 px-4 py-2 text-sm text-surface-700 transition hover:bg-surface-50"
            onClick={() => logoutAccount()}
          >
            登出
          </button>
        </div>
        <Show when={accountStatus().sessionExpired}>
          <div class="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
            登录已过期，请重新登录。
          </div>
        </Show>
        <p class="mt-4 text-xs text-surface-400">
          AI 额度与账号绑定，换设备不重置。试用额度用完后本地功能完全不受影响。
        </p>
      </Show>
    </div>
  );
}
