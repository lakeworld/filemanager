import { createSignal } from "solid-js"

/**
 * v2.4.2（C3）：证书到期提醒的应用内降级横幅。
 * 系统通知不可用时（主进程发送 cert:expiring 事件，payload 为 [productSet, fileName, expiry][]），
 * 渲染层以固定顶部横幅展示，15 秒后自动消失。
 */
const [banner, setBanner] = createSignal<{ title: string; body: string } | null>(null)
export { banner }
export function showCertReminder(expiring: [string, string, string][]): void {
  const body = expiring.map(([, f, d]) => `${f} 于 ${d} 到期`).join("；").slice(0, 300)
  setBanner({ title: `证书到期提醒（${expiring.length} 张）`, body })
  setTimeout(() => setBanner(null), 15000)
}
