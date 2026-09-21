/**
 * 账号 / 图形码接口的**跨端共享纯逻辑**（v2.5.9 A8 登录图形码·客户端先行）。
 *
 * 为什么住 `src/shared`（而不是 main 或 renderer）：
 * - 错误文案主进程要用（`register` 返回给渲染层）、渲染层也要用（图码取不到时的就地提示），
 *   两处各写一份必然漂移——同 `appSettings.ts` 的"三端共读一份真相"口径；
 * - 本文件**不 import electron / 不 import solid**，所以能被 node 直测（`tests/unit/accountApi.test.ts`）。
 *
 * 服务端契约出处（逐字段核过 erp 现网代码，2026-09-21）：
 * - 出图：`GET {base}/captcha` → `{ code, captcha_id, image }`，`image` 已是 `data:image/png;base64,…`
 *   （`qihe-erp/backend/routes/captcha.go:168-173`）；不带 `?for=download` = 登录桶。
 * - 登录带码：头 `X-Captcha-Id` / `X-Captcha-Value`（`auth_login_gate_test.go:78-79`），
 *   与既有 `X-Qihe-Client: box` 并存；**本版不切服务端**，现网对 `box` 头最优先豁免 ⇒ 带不带码都能登录。
 * - 注册：`POST {base}/collections/users/records`，字段 `email / username / password / passwordConfirm`
 *   （照 erp `web/tests/e2e/password.spec.ts:46-49` 的可用形状）；
 *   邮箱认证：`POST {base}/auth/email-verification/request` `{email}` → `…/confirm` `{email, code}`
 *   （`email_verification.go:163/247`，6 位数字码 5 分钟）。
 * - `{base}` 已含 `/api`（登录既有实现就是 `${baseUrl}/collections/users/auth-with-password`）。
 */

/** 出图结果（渲染层直接当 `<img src>` 用，不再二次编码） */
export interface CaptchaChallenge {
  captchaId: string
  /** data URL（服务端已带 `data:image/png;base64,` 前缀） */
  image: string
}

/** 用户提交的图形码答案（主进程转成两个请求头） */
export interface CaptchaAnswer {
  id: string
  value: string
}

/** 邮箱前缀 → PocketBase username：非法字符换 `-`，全空回落 `user` */
export function usernameFromEmail(email: string): string {
  const local = email.trim().split('@')[0] ?? ''
  const cleaned = local.replace(/[^a-zA-Z0-9._@-]/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'user'
}

/** 冲突时的一次随机后缀（只加在 username 上，不动邮箱） */
export function withRandomSuffix(username: string, rand: () => number = Math.random): string {
  const n = Math.floor(rand() * 9000 + 1000)
  return `${username.slice(0, 24)}${n}`
}

/** 服务端报的"用户名已占用"类错误（PocketBase 文案含 username + exists） */
export function isUsernameConflict(message: string): boolean {
  return /username/i.test(message) && /(exist|taken|占用|重复)/i.test(message)
}

/** 邮箱形状粗校验（不当第二道验证器用，只为在本地就挡住明显打错的输入） */
export function looksLikeEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
}

/** 注册密码下限（与官网注册口径一致；服务端规则改了这里要同步） */
export const MIN_PASSWORD_LEN = 8

/** 各调用的失败兜底文案（服务端没给 message 时用；有 message 时透传，同 v2.5.1 登录 D3/D9 口径） */
export type AccountApiCall = 'captcha' | 'register' | 'email-request' | 'email-confirm'

const FALLBACK: Record<AccountApiCall, string> = {
  captcha: '验证码加载失败，点击图片重试',
  register: '注册失败，请稍后重试',
  'email-request': '验证邮件发送失败，请稍后重试',
  'email-confirm': '验证失败，请稍后重试',
}

/**
 * 状态码 + 服务端 message → 一句人话。
 *
 * 为什么把映射做成纯函数：注册链有四次网络调用，文案散在四处写就会四处不一致；
 * 而且**单测能逐条打**（`tests/unit/accountApi.test.ts` 的反向实验）。
 */
export function mapAccountApiError(
  call: AccountApiCall,
  status: number,
  serverMessage: string,
): string {
  const msg = serverMessage.trim()
  if (status === 429) return '操作过于频繁，请稍后再试'
  if (status === 400 && /verification|verify|code/i.test(msg) && /invalid|expired|错|过期/i.test(msg)) {
    return '验证码错误或已过期，请重新获取'
  }
  // 用户名冲突与邮箱重复**必须分文案**：前者我们已经在调用方自动重试一次，
  // 若还失败说成"该邮箱已注册"会把用户引去登录一个根本不存在的账号
  if (isUsernameConflict(msg)) return '用户名已被占用，请稍后再试'
  if (/already exist|已存在|已注册|taken/i.test(msg)) {
    return call === 'register' ? '该邮箱已注册，请直接登录（或找回密码）' : msg.slice(0, 200) || FALLBACK[call]
  }
  if (call === 'register' && status === 409) return '该邮箱已注册，请直接登录（或找回密码）'
  if (msg) return msg.slice(0, 200)
  return FALLBACK[call]
}