/**
 * 账号 store（v2.2.0）：登录态 + AI 剩余试用额度。
 * 登录为可选（复用 ERP 账号），登录后解锁 AI 智能整理；统计是心跳副产品。
 */
import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import type { AccountStatus } from "~/types";

export const [accountStatus, setAccountStatus] = createSignal<AccountStatus>({
  loggedIn: false,
  email: "",
  sessionExpired: false,
  remaining: null,
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
  setAccountStatus({ loggedIn: false, email: "", sessionExpired: false, remaining: null });
}

/** AI 入口守卫：未登录提示并返回 false */
export function requireLogin(): boolean {
  if (accountStatus().loggedIn) return true;
  alert("请先登录后使用 AI 功能（「我的」→ 账号，新用户 50 次免费试用）");
  return false;
}
