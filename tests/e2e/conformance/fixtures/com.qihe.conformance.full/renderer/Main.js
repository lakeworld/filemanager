/**
 * 一致性套件正路径夹具 · 渲染层页面模块（纯 JS、自包含，无 esbuild / 无第三方依赖）。
 * 宿主经 qihebox://plugin/<id>/renderer/Main.js 动态 import，组件 = 模块默认导出；
 * 返回原生 DOM 节点（Solid 渲染器对 nodeType 值直接 appendChild，见 node_modules/solid-js/web insertExpression），
 * 无需 solid-js 打包依赖——夹具源码即产物，build-conformance-fixtures.mjs 直接 zip。
 */
export default function ConformancePage() {
  const root = document.createElement('div')
  root.setAttribute('data-conformance', 'full')
  root.style.padding = '24px'

  const h = document.createElement('h1')
  h.textContent = '🧪 Conformance 全能力夹具'
  h.style.cssText = 'font-size:20px;font-weight:600;margin-bottom:8px;'

  const p = document.createElement('p')
  p.textContent = '一致性套件正路径夹具页面：验证插件 pages 能力可达（导航 + 内容非空）。'
  p.style.cssText = 'color:#64748b;font-size:13px;line-height:1.6;'

  root.appendChild(h)
  root.appendChild(p)
  return root
}
