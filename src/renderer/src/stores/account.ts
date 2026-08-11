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
