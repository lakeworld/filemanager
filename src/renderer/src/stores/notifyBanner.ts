import { createSignal } from "solid-js"

/**
 * 全局反馈横幅（应用内顶部居中，自动消失）。
 * v2.4.2（C3）：证书到期提醒（红色 15s）——保留原行为不变。
 * v2.4.3（F7）：泛化为通用 toast——showToast(tone, title, body?, durationMs?)，
 * success 绿 / error 红，默认 3s；新 toast 顶掉旧的。
 */
export type ToastTone = "success" | "error" | "info"

interface Toast {
  tone: ToastTone
  title: string
  body?: string
}

const [banner, setBanner] = createSignal<Toast | null>(null)
export { banner }

let toastTimer: ReturnType<typeof setTimeout> | undefined

/** 通用操作反馈 toast：成功/失败提示，默认 3 秒自动消失；新 toast 顶掉旧的 */
export function showToast(tone: ToastTone, title: string, body?: string, durationMs = 3000): void {
  clearTimeout(toastTimer)
  setBanner({ tone, title, body })
  toastTimer = setTimeout(() => setBanner(null), durationMs)
}

/** 证书到期提醒（v2.4.2 C3 原行为：error 红色、15s） */
export function showCertReminder(expiring: [string, string, string][]): void {
  const body = expiring.map(([, f, d]) => `${f} 于 ${d} 到期`).join("；").slice(0, 300)
  showToast("error", `证书到期提醒（${expiring.length} 张）`, body, 15000)
}
