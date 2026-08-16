/**
 * hello 示例插件 · 第二页面模块（2026-08-15 新增，插件页切换回归夹具）：
 * 宿主修复前（PluginDispatch 非响应式），插件页之间切换停留在首个打开的页面——
 * 本页作为「第二页」供 e2e 断言切换生效（/plugin/hello ↔ /plugin/hello/extra）。
 * 构建约定同 Main.ts：无 JSX（h() 构造），组件 = 模块默认导出。
 */
import { createSignal } from 'solid-js'
import type { Component } from 'solid-js'
import h from 'solid-js/h'

const Extra: Component = () => {
  const [n, setN] = createSignal(0)
  return h('div', { style: 'padding:24px;max-width:520px;' }, [
    h('h1', { style: 'font-size:20px;font-weight:600;margin-bottom:8px;' }, 'Hello Extra 页面'),
    h(
      'p',
      { style: 'color:#64748b;font-size:13px;line-height:1.6;margin-bottom:16px;' },
      'hello 示例插件第二页（/plugin/hello/extra）：验证插件页之间切换即时生效且实例独立。',
    ),
    h(
      'button',
      {
        style:
          'background:#64748b;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer;',
        get onClick() {
          return () => setN((v) => v + 1)
        },
      },
      '自增计数',
    ),
    h('div', { style: 'margin-top:12px;font-size:13px;color:#334155;' }, () => '计数：' + n()),
  ])
}

export default Extra
