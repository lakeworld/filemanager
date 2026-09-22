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
  /** v2.5.9 A8→收口：图形码必填——未填码渲染层即拦、不发请求（服务端对 box 客户端仍豁免，客户端是唯一实际闸门） */
  captcha?: { id: string; value: string },
): Promise<{ ok: boolean; error?: string }> {
  const r = await api.account.login(email, password, captcha);
  if (r.success && r.data?.ok) {
    await loadAccountStatus();
    return { ok: true };
  }
  return { ok: false, error: r.data?.error ?? r.error ?? "登录失败" };
}

// —— v2.5.9 A8：图形码与注册链的渲染层门面（把 ApiResult 拆成 `{ok,…}`，与 loginAccount 同形）——

/** 取一张图形码；失败时 error 已是人话（图片位显示"点击重试"用） */
export async function fetchCaptcha(): Promise<{ ok: boolean; captchaId?: string; image?: string; error?: string }> {
  const r = await api.account.captcha();
  if (r.success && r.data?.ok) return { ok: true, captchaId: r.data.captchaId, image: r.data.image };
  return { ok: false, error: r.data?.error ?? r.error ?? '验证码加载失败，点击图片重试' };
}

/** 注册账号（成功后紧接着发码，两步在 UI 上是同一个「提交」动作） */
export async function registerAccount(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await api.account.register(email, password);
  if (r.success && r.data?.ok) return { ok: true };
  return { ok: false, error: r.data?.error ?? r.error ?? '注册失败，请稍后重试' };
}

/** 请服务端发 6 位邮箱验证码（注册后首发 / 「没收到，重发」共用） */
export async function requestEmailCode(email: string): Promise<{ ok: boolean; error?: string }> {
  const r = await api.account.emailRequest(email);
  if (r.success && r.data?.ok) return { ok: true };
  return { ok: false, error: r.data?.error ?? r.error ?? '验证邮件发送失败，请稍后重试' };
}

/** 提交邮箱验证码；通过后由调用方用手里那份密码转登录 */
export async function confirmEmailCode(email: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const r = await api.account.emailConfirm(email, code);
  if (r.success && r.data?.ok) return { ok: true };
  return { ok: false, error: r.data?.error ?? r.error ?? '验证失败，请稍后重试' };
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
