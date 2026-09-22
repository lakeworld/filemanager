/**
 * 「打开更新页」请求（v2.6 批 4）：系统通知点击 → **落应用内更新 UI**（设计 §五.7②）。
 *
 * 链路：主进程 `index.ts` 发 `qihebox:event:update:open` → `App.tsx` 根订阅（常驻挂载，
 * 页面级订阅会随路由卸载而错过）→ 本 store 记一笔 + 导航 `/profile` → Profile 读到后
 * 把左侧 Section 切到「检查更新」（deb/未打包实例那一页同样给到「提示 + 一键直链」）。
 *
 * 为什么用计数信号而不是路由 query：`active` 是 Profile 的组件内信号，改成 query 要动路由形状；
 * 这里只需要「有过一次请求」这一个语义——Profile 未挂载时挂载即读当前值，已挂载时随信号切换。
 */
import { createSignal } from 'solid-js'

const [requested, setRequested] = createSignal(0)

/** 请求打开「我的 → 检查更新」（计数累计；消费方只关心 > 0） */
export function requestUpdateSection(): void {
  setRequested((n) => n + 1)
}

/** 累计请求次数（0 = 从未请求过） */
export function updateSectionRequested(): number {
  return requested()
}