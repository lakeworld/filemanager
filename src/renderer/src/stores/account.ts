/**
 * 账号 store（v2.2.0）：登录态（复用 ERP 账号）。
 * 登录为可选；统计是心跳副产品。
 */
import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import type { AccountStatus } from "~/types";

export const [accountStatus, setAccountStatus] = createSignal<AccountStatus>({
  loggedIn: false,
  email: "",
  sessionExpired: false,
});

export async function loadAccountStatus(): Promise<void> {
  const r = await api.account.status();
  if (r.success && r.data) {
    setAccountStatus(r.data);
  }
}

export async function loginAccount(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await api.account.login(email, password);
  if (r.success && r.data?.ok) {
    await loadAccountStatus();
    return { ok: true };
  }
  return { ok: false, error: r.data?.error ?? r.error ?? "登录失败" };
}

export async function logoutAccount(): Promise<void> {
  await api.account.logout();
  setAccountStatus({ loggedIn: false, email: "", sessionExpired: false });
}

/**
 * 订阅主进程账号事件（v2.5.3 P1-6）：心跳 401 会话过期广播 → 即时刷新过期态。
 * 此前过期态只在启动/登录时 loadAccountStatus() 拉取一次，心跳 401 不传导 UI，
 * Profile 过期横幅须等重启才出现。返回退订函数（App 根组件 onMount 订阅一次，卸载退订）。
 */
export function subscribeAccountEvents(): () => void {
  return window.qihebox.events.on("account:session-expired", (data) => {
    const status = data as Partial<AccountStatus>;
    if (status && typeof status.sessionExpired === "boolean") {
      setAccountStatus({
        loggedIn: status.loggedIn ?? true,
        email: status.email ?? "",
        sessionExpired: status.sessionExpired,
      });
    }
  });
}
