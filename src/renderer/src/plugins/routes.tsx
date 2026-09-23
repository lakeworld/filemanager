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
 *
 * v2.6 缺陷修复（官方目录 / 预装路线的裸报错）：官方加密包里**没有明文 JS**，取钥被拒时
 * 动态 `import()` 只能给一句 `TypeError: Failed to fetch dynamically imported module`——
 * 没状态码也没原因，用户看到的就是裸 JS 报错；而「需要订阅 / 需要登录」这张脸此前只存在于
 * 明文侧载包自带的 paywall 里（宿主侧从来没有）。判别所需的数据其实一直在渲染层手里
 * （登记条目的 `state` + `lastError` + 结构化 `lastErrorCode`），只是没人查。
 * 现在**进页之前**先过一道闸门（纯函数 `derivePluginPageGate`）：命中即画「原因 + 一个能点的出路按钮」，
 * 连 import 请求都不发；原来那两条裸抛分支降级为「其它技术失败」的通用外壳（原文进控制台，不当主脸）。
 * 文案纪律（宿主本体零订阅）：引导页只讲原因与去处，**不出现任何价格数字或档位**——价格只住云插件的订阅页。
 */
import { createComponent, createMemo, createSignal, Show, ErrorBoundary, createResource } from 'solid-js'
import type { Component, JSX } from 'solid-js'
import { Route, useLocation, useNavigate } from '@solidjs/router'
import Loading from '~/components/Loading'
import type { PluginPageGate } from './registry'
import {
  PLUGIN_MANAGER_PATH,
  derivePluginPageGate,
  pluginModuleUrl,
  pluginRoutes,
  plugins,
  refreshPluginRegistry,
} from './registry'
import PluginManagerPage from './PluginManagerPage'

/** 兜底页共用的居中卡片外壳（引导页与技术失败页同一副版式，避免各写一套） */
function NoticeShell(props: {
  icon: string
  title: string
  reason: string
  sub?: string
  children: JSX.Element
}): JSX.Element {
  return (
    <div class="p-6 max-w-xl mx-auto">
      <div class="card p-8 text-center">
        <div class="text-3xl" aria-hidden="true">
          {props.icon}
        </div>
        <div class="text-lg font-semibold text-surface-900 mt-3">{props.title}</div>
        <Show when={props.sub}>
          <div class="text-xs font-mono text-surface-400 mt-1">{props.sub}</div>
        </Show>
        <p class="text-sm text-surface-500 mt-2 break-words">{props.reason}</p>
        <div class="mt-6 flex items-center justify-center gap-3">{props.children}</div>
      </div>
    </div>
  )
}

/**
 * 取钥被拒引导页：原因用主进程算好的那句原话（宿主不另写措辞，也不自创价格），
 * 出路做成**一个能点的按钮**：订阅→云插件订阅页 / 登录→账号页 / 网络故障→就地重试 / 篡改→去重装 /
 * 版本未登记→联系发布方（副标题报出插件名与版本号，方便用户原样转述）。
 * `retried` = 用户点过「重试」仍失败，此时补一句说明，免得界面看着像什么都没发生。
 */
function PluginGatePage(props: { gate: PluginPageGate; retried: boolean; onRetry: () => void }): JSX.Element {
  const navigate = useNavigate()
  const g = () => props.gate
  return (
    <NoticeShell
      icon={g().route === 'subscribe' || g().route === 'login' ? '👤' : '⚠️'}
      title={g().title}
      sub={`${g().name} v${g().version}`}
      reason={props.retried ? `${g().reason}（重试后仍然不行）` : g().reason}
    >
      <Show
        when={g().route === 'retry'}
        fallback={
          <button
            class="btn-primary px-4 py-2 text-sm"
            onClick={() => navigate(g().actionPath ?? PLUGIN_MANAGER_PATH)}
          >
            {g().actionLabel} →
          </button>
        }
      >
        <button class="btn-primary px-4 py-2 text-sm" onClick={() => props.onRetry()}>
          {g().actionLabel}
        </button>
      </Show>
      {/* 「重新加载」= 放行一次真实加载。订阅/登录后主进程的原因码要等下次激活才清，
          没有这条就地出口，用户办完事回来会被同一张引导页再挡一次（协议层会重跑取钥，办妥即进页） */}
      <Show when={g().route !== 'retry'}>
        <button class="link-btn text-xs text-surface-500 hover:text-primary-600" onClick={() => props.onRetry()}>
          重新加载
        </button>
      </Show>
      {/* 出路的诚实边界（2026-09-23 推前审计第 2 路要求 + 同日哈希缺陷立卡）：
          加密包渲染层取钥的哈希口径缺陷修完之前，重装回来的仍是**同一份合法密文**，
          照样被判不一致 ⇒ 「去重装」不能承诺必然解决。这句话是给用户的第二条出路，
          也是给我们的一条报障线索（名与版本副标题里已亮出，可原样转述）。 */}
      <Show when={g().route === 'reinstall'}>
        <p class="text-xs text-surface-500">若重装后仍然如此，请把上面的插件名与版本一并告诉我们。</p>
      </Show>
    </NoticeShell>
  )
}

/**
 * 「其它技术失败」通用外壳：此前这里是主脸（`插件页面加载失败：${String(mod.error)}` 一句裸抛），
 * 用户既看不懂也没有出路。现在原文只进控制台，页面上给中性话术 + 出路（重试 / 插件管理看原因）。
 */
function PluginTechFailPage(props: { err: unknown; onRetry: () => void }): JSX.Element {
  void console.warn('[plugins] 插件页面模块加载失败', props.err)
  return (
    <NoticeShell
      icon="⚠️"
      title="插件页面没能加载出来"
      reason="插件页面模块加载失败。具体原因见「插件管理」页该插件条目上的「最近一次加载失败」。"
    >
      <button class="btn-primary px-4 py-2 text-sm" onClick={() => props.onRetry()}>
        重试
      </button>
    </NoticeShell>
  )
}

/**
 * 插件页面挂载组件：按路由固定元信息（插件 id + 包内组件路径）动态 import。
 * 协议 URL 由 pluginModuleUrl 生成（含路径包含校验），Vite 不参与该动态 import 的打包解析。
 *
 * 闸门在前（v2.6 缺陷修复）：`derivePluginPageGate` 命中时把 resource 的 source 置 null——
 * Solid 的 createResource 拿到 nullish source 不会调 fetcher ⇒ **连 import 请求都不发**，画引导页。
 * 「重试」放行一次真实加载（加密包的取钥在协议层同样会重跑），网络/云端恢复后不必重启应用即可进页；
 * 清单刷新后主进程若已把失败原因清掉（订阅/登录生效并成功激活），闸门自动放行，无需用户再动手。
 */
function PluginPageMount(props: { pluginId: string; component: string }): JSX.Element {
  const url = () => pluginModuleUrl(props.pluginId, props.component)
  const gate = createMemo(() => derivePluginPageGate(plugins().find((p) => p.id === props.pluginId)))
  /** 用户主动点「重试」的次数（>0 = 闸门放行过一次真请求） */
  const [attempt, setAttempt] = createSignal(0)
  const src = createMemo(() => {
    const u = url()
    if (!u) return null
    if (gate().state === 'key-unavailable' && attempt() === 0) return null // 进页前拦截：不发请求
    return u
  })
  const [mod, { refetch }] = createResource<Record<string, unknown>, string | null>(src, async (u) => {
    if (!u) throw new Error('插件页面模块路径非法')
    // 插件页面模块经自定义协议加载（自包含依赖），Vite 静态分析无法（也不应）打包 → @vite-ignore
    return import(/* @vite-ignore */ u)
  })
  const retry = (): void => {
    const first = attempt() === 0
    setAttempt((n) => n + 1)
    // 首次重试：source 由 null 变 url，createResource 自动发请求；其后再点 source 值未变，需显式 refetch
    if (!first) void refetch()
    void refreshPluginRegistry().catch(() => {}) // 顺带拉新清单：主进程恢复了闸门就放行
  }
  /** 动态渲染模块默认导出（经 createComponent 规避 JSX 组件类型检查；缺默认导出由下方 `<Show when={mod()?.default}>` 兜底） */
  const Comp = (): JSX.Element => {
    const C = mod()?.default as Component | undefined
    return C ? createComponent(C, {}) : undefined
  }
  /**
   * 闸门是否正在拦（真拦 = 命中且用户还没点过重试；重试过仍失败时上面 `src()` 已放行，
   * 拿到 `mod.error` 才回到引导页，中间态如实显示加载中）。
   * 直接读资源信号（不套 `view()` 汇总 memo）：2026-09-23 真机实测——汇总 memo + `<Switch>`
   * 会让 `import()` 被拒后界面永久停在「加载中」，嵌套 `<Show>` 形态才正常翻面。
   */
  const blocked = createMemo(() => gate().state === 'key-unavailable' && (attempt() === 0 || mod.error !== undefined))

  return (
    <ErrorBoundary
      fallback={(err) => (
        <div class="p-8 text-sm text-danger-600">插件页面渲染失败：{String(err)}</div>
      )}
    >
      <Show
        when={url()}
        fallback={<div class="p-8 text-sm text-danger-600">插件页面模块路径非法（拒绝绝对路径与 .. 逃逸）</div>}
      >
        <Show
          when={blocked()}
          fallback={
            <Show when={!mod.loading} fallback={<Loading text="插件页面加载中…" />}>
              <Show
                when={!mod.error}
                fallback={<PluginTechFailPage err={mod.error} onRetry={retry} />}
              >
                <Show when={mod()?.default} fallback={<div class="p-8 text-sm text-surface-500">插件页面模块缺少默认导出组件</div>}>
                  <Comp />
                </Show>
              </Show>
            </Show>
          }
        >
          <PluginGatePage gate={gate()} retried={attempt() > 0} onRetry={retry} />
        </Show>
      </Show>
    </ErrorBoundary>
  )
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

/**
 * 插件页面分发：按当前路径在 pluginRoutes() 中查表，命中则挂载对应插件页面模块。
 * 2026-08-15 修复（LAN 4 页合并前暴露）：此前 `const route = matched()` 存函数体普通变量，
 * Solid 组件函数体只挂载求值一次 → @solidjs/router 对同一通配 Route 复用实例（key 相同不重挂）
 * → 插件页之间切换不重求值，页面停留在首个打开的插件页（URL 已变内容不变）。
 * 改 createMemo + Show keyed（render-prop 形态）：location.pathname / pluginRoutes() 响应式重算，
 * route 对象变化即重渲染 PluginPageMount（createResource 按 url 重新 import，旧页 dispose）。
 */
function PluginDispatch(): JSX.Element {
  const location = useLocation()
  const route = createMemo(() => pluginRoutes().find((r) => r.path === location.pathname))
  return (
    <Show when={route()} fallback={null}>
      {(r) => <PluginPageMount pluginId={r().pluginId} component={r().component} />}
    </Show>
  )
}
