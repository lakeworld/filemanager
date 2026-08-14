/**
 * 渲染层插件路由（v2.5，P0）：插件页面动态路由 + 插件管理页路由。
 *
 * 用法（供 index.tsx 在 Router 内嵌，路由随 registry 响应式增减，启停即时生效不重启）：
 *   <Router root={RootApp}>
 *     <Route path="/" component={Dashboard} />
 *     ...
 *     <PluginRoutes />
 *   </Router>
 *
 * @solidjs/router 的 Route 返回 route-def 对象（非 DOM），Router 经 children() 解析注册；
 * PluginRoutes 返回值直接进入 Router children（读 registry 信号，变更时响应式重建分支）。
 * 插件页面组件 = manifest pages[].component 指向模块的默认导出（协议 URL 动态 import，访问才加载）；
 * 加载中 / 加载失败 / 缺默认导出均如实呈现，模块实例随路由卸载释放（不访问不加载，PLAN §4.1）。
 */
import { createComponent, Show, ErrorBoundary, createResource } from 'solid-js'
import type { Component, JSX } from 'solid-js'
import { Route, useLocation } from '@solidjs/router'
import Loading from '~/components/Loading'
import { PLUGIN_MANAGER_PATH, pluginModuleUrl, pluginRoutes } from './registry'
import PluginManagerPage from './PluginManagerPage'

/**
 * 插件页面挂载组件：按路由固定元信息（插件 id + 包内组件路径）动态 import。
 * 协议 URL 由 pluginModuleUrl 生成（含路径包含校验），Vite 不参与该动态 import 的打包解析。
 */
function PluginPageMount(props: { pluginId: string; component: string }): JSX.Element {
  const url = () => pluginModuleUrl(props.pluginId, props.component)
  const [mod] = createResource<Record<string, unknown>, string>(url, async (u) => {
    if (!u) throw new Error('插件页面模块路径非法')
    // 插件页面模块经自定义协议加载（自包含依赖），Vite 静态分析无法（也不应）打包 → @vite-ignore
    return import(/* @vite-ignore */ u)
  })
  /** 动态渲染模块默认导出（经 createComponent 规避 JSX 组件类型检查；缺默认导出时由 when 门控兜底） */
  const Comp = (): JSX.Element => {
    const C = mod()?.default as Component | undefined
    return C ? createComponent(C, {}) : undefined
  }

  return (
    <ErrorBoundary fallback={(err) => <div class="p-8 text-sm text-red-600">插件页面渲染失败：{String(err)}</div>}>
      <Show
        when={url()}
        fallback={<div class="p-8 text-sm text-red-600">插件页面模块路径非法（拒绝绝对路径与 .. 逃逸）</div>}
      >
        <Show when={!mod.loading} fallback={<Loading text="插件页面加载中…" />}>
          <Show when={!mod.error} fallback={<div class="p-8 text-sm text-red-600">插件页面加载失败：{String(mod.error)}</div>}>
            <Show when={mod()?.default} fallback={<div class="p-8 text-sm text-surface-500">插件页面模块缺少默认导出组件</div>}>
              <Comp />
            </Show>
          </Show>
        </Show>
      </Show>
    </ErrorBoundary>
  );
}

/**
 * 插件路由集合：管理页路由（固定）+ 插件页面统一经通配路由运行时分发。
 * 实现说明（2026-08-11 实测）：@solidjs/router 1.0 对 Router mount 后**新增**的 <Route> 元素
 * 不会响应式重注册（PluginRoutes 在 pluginList 变化后不重渲染、新路由不进匹配表，页面 404 空白）。
 * 因此插件页面改为「静态通配 /plugin/*rest + 按当前路径查 pluginRoutes() 分发」：
 * 通配路由挂载即注册，分发组件随 location 与 pluginRoutes() 信号响应式渲染，启停即时生效。
 * 配套协议收紧：manifest pages[].path 必须带 '/plugin/' 前缀（validateManifest 规则④，防与本体路由冲突）。
 */
export function PluginRoutes(): JSX.Element {
  return [
    <Route path={PLUGIN_MANAGER_PATH} component={PluginManagerPage} />,
    <Route path="/plugin/*rest" component={PluginDispatch} />,
  ]
}

/** 插件页面分发：按当前路径在 pluginRoutes() 中查表，命中则挂载对应插件页面模块 */
function PluginDispatch(): JSX.Element {
  const location = useLocation()
  const matched = () => pluginRoutes().find((r) => r.path === location.pathname)
  const route = matched()
  if (!route) return null
  return <PluginPageMount pluginId={route.pluginId} component={route.component} />
}
