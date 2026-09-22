/**
 * 插件管理页（v2.5，P0/P2）：路由 /settings/plugins（PLAN §5.4 / PLUGIN.md §七）。
 *
 * 已安装清单：图标/名称/id/版本/作者/描述/状态（启用/禁用/broken）/启停开关（即时生效+持久化）/
 * 卸载按钮（明示确认：删除代码与状态）。
 * broken 展示：原因（apiCompat 不兼容 → 「需升级宿主/插件」、不提供开关；其余可重试，
 * 重试 = setEnabled(id, true)，宿主清 failCount 并重新激活）。
 * 加载失败提示（v2.6 批 7，审查轮 2 缺口①）：`p.lastError` = 最近一次激活/加载失败原因
 * （启用态插件展示；如加密插件取钥失败的原因与出路——需要订阅 / 版本未登记 / 密文不符被拒 / 云端故障可重试）。
 * 可观测：激活耗时 / IPC 调用次数 / 失败计数（仿 VS Code Running Extensions 简化版）。
 * permissions 展示：network 域名白名单 / '*' 醒目 + description 作 reasoning / 剪贴板 / 通知。
 * 侧载导入：选择 .qbox → 风险确认 → 安装（主进程 JSON Schema + SHA-256 校验）；安装后权限醒目展示。
 *   —— 说明：PLAN §5.4 的「安装前权限确认对话框」需要安装前清单预览能力，v2.5 IPC 契约
 *      （install({ filePath }) 一步安装）未提供 inspect 入口，落地为「通用风险确认 + 安装后权限展示」，
 *      待 v2.6 提供预检 API 后升级为真实权限预览（见报告偏差说明）。
 * 官方目录区块（v2.6 批 2 实装，PLUGIN.md §5.3 / §七）：进入管理页时拉取一次（**不后台轮询**），
 *   逐项展示 图标/名称/版本/体积/permissions 摘要/来源；已装插件与目录比对 →「可更新」标记；
 *   不兼容条目置灰（宿主按 API/产品版本过滤掉不兼容版本，见 main/plugins/catalog.ts）；
 *   未登录 / 未配置服务器 / 端点未部署 → 如实展示中文原因 + 出路（不谎报空目录）。
 * 更新即重启（v2.6 批 2）：覆盖安装命中已有插件时弹「插件已更新 / 已重新安装」提示，
 *   两按钮「立即重启」（qihebox:app:relaunch）/「稍后」——口径见 docs/INTERNAL/PLUGIN.md §七。
 */
import { Show, For, createSignal, createMemo, onMount } from 'solid-js'
import type { JSX } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import type { ApiResult, PluginCatalogEntry, PluginInfo } from '../../../shared/types'
import ConfirmDialog from '~/components/ConfirmDialog'
import { showToast } from '~/stores/notifyBanner'
import {
  buildRestartNotice,
  catalogErrorGuidance,
  deriveCatalogRows,
  fetchPluginCatalog,
  formatPluginSize,
  initPluginRegistry,
  installPlugin,
  pluginModuleUrl,
  plugins,
  refreshPluginRegistry,
  relaunchApp,
  setPluginEnabled,
  summarizeCatalogPermissions,
  uninstallPlugin,
  getDevMode,
  setDevMode,
  type PluginCatalogRow,
  type PluginRestartNotice,
} from './registry'

// —— 状态标签 ——
const STATUS_META: Record<PluginInfo['state'], { text: string; cls: string }> = {
  enabled: { text: '启用', cls: 'bg-success-50 text-success-600' },
  disabled: { text: '禁用', cls: 'bg-surface-100 text-surface-500' },
  broken: { text: 'broken', cls: 'bg-danger-50 text-danger-600' },
}

/** broken 是否源于 apiCompat 不兼容（需升级宿主/插件，不提供开关） */
function isCompatBroken(p: PluginInfo): boolean {
  return (p.brokenReason ?? '').includes('apiCompat')
}

/** 插件图标：包内路径经协议 URL 加载；缺失/加载失败回退占位 */
function PluginIcon(props: { p: PluginInfo }): JSX.Element {
  const [failed, setFailed] = createSignal(false)
  const url = () => pluginModuleUrl(props.p.id, props.p.icon ?? '')
  return (
    <Show
      when={url() && !failed()}
      fallback={
        <div class="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-surface-100 text-lg">📦</div>
      }
    >
      <img
        src={url()!}
        alt={props.p.name}
        class="w-8 h-8 shrink-0 object-contain"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}

/** 目录项图标（v2.6：未下载，只有服务端给的 URL；缺图/加载失败回退占位） */
function CatalogIcon(props: { entry: PluginCatalogEntry }): JSX.Element {
  const [failed, setFailed] = createSignal(false)
  return (
    <Show
      when={props.entry.icon && !failed()}
      fallback={
        <div class="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-surface-100 text-lg">📦</div>
      }
    >
      <img
        src={props.entry.icon!}
        alt={props.entry.name}
        class="w-8 h-8 shrink-0 object-contain"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}

/** 权限声明块：network 域名 / '*' 醒目 + description reasoning / 剪贴板 / 通知 / 账号（v2.5 增量） */
function PermissionsView(props: { p: PluginInfo }): JSX.Element {
  const perms = props.p.permissions
  const network = perms?.network ?? []
  const declared =
    network.length > 0 || perms?.clipboard || perms?.notification || perms?.account || perms?.customers || perms?.share
  return (
    <div>
      <div class="text-xs font-medium text-surface-400 mb-1.5">权限声明</div>
      <Show
        when={declared}
        fallback={<div class="text-xs text-surface-400">未声明权限</div>}
      >
        <div class="space-y-1">
          <For each={network}>
            {(d) =>
              d === '*' ? (
                <div class="text-xs text-warning-700 bg-warning-50 rounded px-2 py-1">
                  ⚠ 可访问任意网络域名（{props.p.description ?? '未提供说明'}）
                </div>
              ) : (
                <div class="text-xs text-surface-600">🌐 可访问 {d}</div>
              )
            }
          </For>
          <Show when={perms?.clipboard}>
            <div class="text-xs text-surface-600">📋 可读写剪贴板</div>
          </Show>
          <Show when={perms?.notification}>
            <div class="text-xs text-surface-600">🔔 可发送系统通知</div>
          </Show>
          <Show when={perms?.account}>
            <div class="text-xs text-surface-600">👤 可读取账号登录态（token）</div>
          </Show>
          <Show when={perms?.customers}>
            <div class="text-xs text-surface-600">🧾 可读写客户档案（customers 能力域）</div>
          </Show>
          <Show when={perms?.share}>
            <div class="text-xs text-surface-600">📡 可发布工作区只读视图并拉取文件（share 能力域）</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** 可观测信息：激活耗时 / IPC 调用次数 / 失败计数 / 安装时间 */
function MetricsView(props: { p: PluginInfo }): JSX.Element {
  const p = props.p
  return (
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <div>
        <div class="text-xs text-surface-400">激活耗时</div>
        <div class="font-mono text-xs mt-0.5">{p.activationMs != null ? `${p.activationMs} ms` : '—'}</div>
      </div>
      <div>
        <div class="text-xs text-surface-400">IPC 调用</div>
        <div class="font-mono text-xs mt-0.5">{p.callCount}</div>
      </div>
      <div>
        <div class="text-xs text-surface-400">失败计数</div>
        <div class="font-mono text-xs mt-0.5">{p.failCount}</div>
      </div>
      <div>
        <div class="text-xs text-surface-400">安装时间</div>
        <div class="font-mono text-xs mt-0.5">{p.installedAt ? p.installedAt.slice(0, 10) : '—'}</div>
      </div>
    </div>
  );
}

export default function PluginManagerPage(): JSX.Element {
  const navigate = useNavigate()
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [uninstallTarget, setUninstallTarget] = createSignal<PluginInfo | null>(null)
  /** 待确认导入的 .qbox 路径（风险确认对话框） */
  const [importPath, setImportPath] = createSignal<string | null>(null)
  const [installing, setInstalling] = createSignal(false)
  /** v2.5 增量（PLAN §3.5）：开发者模式（侧载入口门控，默认关） */
  const [devMode, setDevModeState] = createSignal(false)
  const [devModeLoaded, setDevModeLoaded] = createSignal(false)
  /** v2.6 批 2：官方目录（进入时拉取一次；错误如实展示） */
  const [catalog, setCatalog] = createSignal<PluginCatalogEntry[]>([])
  const [catalogError, setCatalogError] = createSignal<string | null>(null)
  const [catalogLoading, setCatalogLoading] = createSignal(false)
  const [catalogLoaded, setCatalogLoaded] = createSignal(false)
  /** 目录安装中的条目 id（按钮文案与禁用） */
  const [installingId, setInstallingId] = createSignal<string | null>(null)
  /** v2.6 批 2：覆盖安装后的「重启应用」提示 */
  const [restartNotice, setRestartNotice] = createSignal<PluginRestartNotice | null>(null)

  /** 目录行 = 目录条目 × 已装清单（响应式：安装完 plugins() 刷新即自动标「可更新」） */
  const catalogRows = createMemo(() => deriveCatalogRows(catalog(), plugins()))
  const catalogGuidance = createMemo(() => catalogErrorGuidance(catalogError() ?? ''))

  /** 拉取官方目录（用户触发：进入管理页 / 点「刷新」/ 失败后重试；**不后台轮询**） */
  const loadCatalog = async () => {
    setCatalogLoading(true)
    try {
      const r = await fetchPluginCatalog()
      if (r.success && r.data) {
        setCatalog(r.data)
        setCatalogError(null)
      } else {
        // 未登录 / 未配置服务器 / 端点未部署 → 如实报错；**不谎报空目录**
        setCatalog([])
        setCatalogError(r.error ?? 'CATALOG_UNAVAILABLE：官方插件目录获取失败')
      }
      setCatalogLoaded(true)
    } finally {
      setCatalogLoading(false)
    }
  }

  onMount(() => {
    // 幂等初始化 + 显式刷新兜底（事件路径与操作路径双保险）
    void initPluginRegistry().then(() => refreshPluginRegistry())
    // v2.5：开发者模式状态（侧载收紧；ApiResult 包装，P1-E2）
    void getDevMode().then((r) => {
      setDevModeState(r.success && r.data === true)
      setDevModeLoaded(true)
    })
    // v2.6 批 2：官方目录（进入时拉取一次）
    void loadCatalog()
  })

  /** 切换开发者模式（userData/settings.json 持久化；ApiResult 包装，失败回退 + toast，P1-E2） */
  const toggleDevMode = async () => {
    const next = !devMode()
    const r = await setDevMode(next)
    if (r.success) {
      setDevModeState(r.data === true)
      showToast('success', next ? '开发者模式已开启' : '开发者模式已关闭', next ? '可在下方导入本地插件包' : undefined)
    } else {
      showToast('error', '开发者模式设置失败', r.error ?? '未知错误')
    }
  }

  /** 展示排序：启用 → 禁用 → broken，组内按名称 */
  const sortedPlugins = () =>
    [...plugins()].sort((a, b) => {
      const rank = (s: PluginInfo['state']) => (s === 'enabled' ? 0 : s === 'disabled' ? 1 : 2)
      const d = rank(a.state) - rank(b.state)
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })

  const toggleEnabled = async (p: PluginInfo) => {
    const disabling = p.state === 'enabled'
    const r = await setPluginEnabled(p.id, !disabling)
    if (r.success) {
      showToast('success', disabling ? `已禁用「${p.name}」` : `已启用「${p.name}」`)
    } else {
      showToast('error', '启停操作失败', r.error || '未知错误')
    }
    await refreshPluginRegistry()
  }

  /** 熔断重试：setEnabled(id, true) → 宿主清 failCount 并重新激活 */
  const retryPlugin = async (p: PluginInfo) => {
    const r = await setPluginEnabled(p.id, true)
    if (r.success) {
      showToast('success', `已重试「${p.name}」`, '熔断计数已清零，插件重新激活')
    } else {
      showToast('error', '重试失败', r.error || '未知错误')
    }
    await refreshPluginRegistry()
  }

  const doUninstall = async (p: PluginInfo) => {
    setUninstallTarget(null)
    const r = await uninstallPlugin(p.id)
    if (r.success) {
      showToast('success', `已卸载「${p.name}」`, '插件代码与状态已删除')
    } else {
      showToast('error', '卸载失败', r.error || '未知错误')
    }
    await refreshPluginRegistry()
  }

  /** 选择 .qbox → 进入风险确认（安装由 doInstall 执行） */
  const pickPluginFile = async () => {
    const r = (await window.qihebox.dialog.openFile('选择插件包（.qbox）', [
      { name: '启禾插件包', extensions: ['qbox'] },
    ])) as ApiResult<string>
    if (r.success && r.data) setImportPath(r.data)
  }

  const doInstall = async () => {
    const filePath = importPath()
    setImportPath(null)
    if (!filePath) return
    setInstalling(true)
    // v2.6 批 2：安装前清单快照（更新判定 = 同 id 已存在；同版本重装亦命中）
    const before = plugins()
    try {
      const r = await installPlugin({ filePath })
      if (r.success && r.data) {
        showToast('success', `插件「${r.data.name}」已安装`, `可在下方列表查看其权限声明`)
        setRestartNotice(buildRestartNotice(before, r.data))
      } else {
        showToast('error', '安装失败', r.error || '未知错误')
      }
      await refreshPluginRegistry()
    } finally {
      setInstalling(false)
    }
  }

  /** 官方目录安装/更新（v2.6 批 2）：{ downloadUrl, sha256 } 形态 → 登录态下载 + SHA-256 校验 */
  const installFromCatalog = async (row: PluginCatalogRow) => {
    const selected = row.entry.selected
    if (!selected) return
    const before = plugins()
    setInstallingId(row.entry.id)
    try {
      const r = await installPlugin({ downloadUrl: selected.downloadUrl, sha256: selected.sha256 })
      if (r.success && r.data) {
        showToast('success', `插件「${r.data.name}」已安装`, `v${r.data.version}`)
        setRestartNotice(buildRestartNotice(before, r.data))
      } else {
        showToast('error', '安装失败', r.error || '未知错误')
      }
      await refreshPluginRegistry()
    } finally {
      setInstallingId(null)
    }
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-surface-900">插件</h1>
        <p class="text-surface-500 mt-1">管理已安装的扩展插件：启停、卸载与权限查看</p>
      </div>

      {/* v2.5 增量（PLAN §3.5）：风险横幅（管理页常驻） */}
      <div class="mb-4 rounded-lg bg-warning-50 border border-warning-200 px-4 py-3 text-sm text-warning-800">
        ⚠ 插件未经过官方审查，安装需自行承担风险。官方目录已上线：优先从上方目录安装；侧载仅限自研或可信来源。
      </div>

      {/* 官方目录（v2.6 批 2 实装）：进入时拉取一次；未登录/未部署如实报错 + 出路 */}
      <div class="card p-6 mb-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-lg font-semibold">官方插件目录</h2>
          <button
            class="link-btn text-xs text-surface-500 hover:text-primary-600"
            disabled={catalogLoading()}
            onClick={() => void loadCatalog()}
          >
            {catalogLoading() ? '获取中…' : '刷新'}
          </button>
        </div>

        <Show when={catalogError()}>
          <div class="rounded-lg bg-warning-50 border border-warning-200 px-4 py-3 text-sm text-warning-800">
            <div>{catalogGuidance().text}</div>
            <div class="mt-2 flex items-center gap-3">
              <Show when={catalogGuidance().loginRequired}>
                <button
                  class="link-btn text-xs text-primary-600 hover:text-primary-700"
                  onClick={() => navigate('/profile')}
                >
                  去登录 →
                </button>
              </Show>
              <Show when={catalogGuidance().retryable}>
                <button
                  class="link-btn text-xs text-surface-500 hover:text-primary-600"
                  onClick={() => void loadCatalog()}
                >
                  重试
                </button>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={!catalogError() && !catalogLoaded()}>
          <p class="text-sm text-surface-500">正在获取官方目录…</p>
        </Show>

        <Show when={!catalogError() && catalogLoaded() && catalogRows().length === 0}>
          <p class="text-sm text-surface-500">官方目录暂无插件。</p>
        </Show>

        <Show when={!catalogError() && catalogRows().length > 0}>
          <div class="space-y-3">
            <For each={catalogRows()}>
              {(row) => (
                <div class="border border-surface-100 rounded-lg p-4">
                  <div class="flex items-start gap-3">
                    <CatalogIcon entry={row.entry} />
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-semibold text-surface-900">{row.entry.name}</span>
                        <span class="text-xs font-mono text-surface-400">{row.entry.id}</span>
                        <Show when={row.entry.selected}>
                          <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500">
                            v{row.entry.selected!.version}
                          </span>
                        </Show>
                        <Show when={row.updateAvailable}>
                          <span class="text-[11px] px-1.5 py-0.5 rounded bg-primary-50 text-primary-600">
                            可更新
                          </span>
                        </Show>
                        <Show when={!row.entry.compatible}>
                          <span class="text-[11px] px-1.5 py-0.5 rounded bg-danger-50 text-danger-600">
                            不兼容
                          </span>
                        </Show>
                      </div>
                      <div class="text-xs text-surface-400 mt-0.5">
                        {row.entry.source ?? '启禾官方'}
                        <Show when={row.entry.author}> · {row.entry.author}</Show>
                        <Show when={row.entry.selected}> · {formatPluginSize(row.entry.selected?.size)}</Show>
                        <Show when={row.installedVersion}> · 已装 v{row.installedVersion}</Show>
                      </div>
                      <Show when={row.entry.description}>
                        <div class="text-sm text-surface-500 mt-1 line-clamp-2">{row.entry.description}</div>
                      </Show>
                      <Show when={!row.entry.compatible && row.entry.reason}>
                        <div class="text-xs text-danger-600 mt-1">{row.entry.reason}</div>
                      </Show>
                      <div class="text-xs text-surface-500 mt-1.5">
                        权限：{summarizeCatalogPermissions(row.entry.permissions)}
                      </div>
                    </div>
                    <button
                      class="btn-primary shrink-0"
                      disabled={!row.entry.selected || installingId() === row.entry.id}
                      onClick={() => void installFromCatalog(row)}
                    >
                      {installingId() === row.entry.id
                        ? '安装中…'
                        : row.updateAvailable
                          ? '更新'
                          : row.installedVersion
                            ? '重装'
                            : '安装'}
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* v2.5 增量（PLAN §3.5）：开发者模式（侧载入口门控，默认关；IPC 层强制 + UI 层隐藏双保险） */}
      <div class="card p-6 mb-6">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-semibold">开发者模式</h2>
            <p class="text-sm text-surface-500 mt-1">
              侧载导入第三方插件包的开关（默认关闭）。开启后可在下方导入本地 .qbox 插件包。
            </p>
          </div>
          <Show when={devModeLoaded()}>
            <button
              role="switch"
              aria-checked={devMode()}
              title={devMode() ? '关闭开发者模式' : '开启开发者模式'}
              class={`w-10 h-5 rounded-full relative transition-colors shrink-0 ${
                devMode() ? 'bg-primary-500' : 'bg-surface-300'
              }`}
              onClick={() => void toggleDevMode()}
            >
              <span
                class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-[left,background-color]"
                style={{ left: devMode() ? '22px' : '2px' }}
              />
            </button>
          </Show>
        </div>
      </div>

      {/* 侧载导入（仅开发者模式开启时可见） */}
      <Show when={devMode()}>
        <div class="card p-6 mb-6">
          <h2 class="text-lg font-semibold mb-2">侧载导入</h2>
          <p class="text-sm text-surface-500 mb-4">
            导入本地 .qbox 插件包。侧载插件未经官方审核，进程内插件与宿主具有同等能力，导入前请确认来源可信。
          </p>
          <button class="btn-primary" onClick={pickPluginFile} disabled={installing()}>
            {installing() ? '安装中…' : '导入本地插件包 (.qbox)'}
          </button>
        </div>
      </Show>

      {/* 已安装清单 */}
      <div class="mb-4">
        <h2 class="text-lg font-semibold">
          已安装插件
          <span class="ml-2 text-sm font-normal text-surface-400">{plugins().length}</span>
        </h2>
      </div>
      <Show
        when={sortedPlugins().length > 0}
        fallback={
          <div class="card p-12 text-center text-surface-400 text-sm">
            未安装任何插件。可从上方官方目录下载安装，或开启开发者模式后侧载本地 .qbox。
          </div>
        }
      >
        <div class="space-y-3">
          <For each={sortedPlugins()}>
            {(p) => (
              <div class="card p-5">
                <div class="flex items-start gap-3">
                  <PluginIcon p={p} />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-semibold text-surface-900">{p.name}</span>
                      <span class="text-xs font-mono text-surface-400">{p.id}</span>
                      <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500">
                        v{p.version}
                      </span>
                      <span class={`text-[11px] px-1.5 py-0.5 rounded ${STATUS_META[p.state].cls}`}>
                        {STATUS_META[p.state].text}
                      </span>
                    </div>
                    <Show when={p.author}>
                      <div class="text-xs text-surface-400 mt-0.5">{p.author}</div>
                    </Show>
                    <Show when={p.description}>
                      <div class="text-sm text-surface-500 mt-1 line-clamp-2">{p.description}</div>
                    </Show>
                    <Show when={p.state === 'broken' && p.brokenReason}>
                      <div class="text-xs text-danger-600 mt-1">原因：{p.brokenReason}</div>
                    </Show>
                    {/* v2.6 批 7（审查轮 2 缺口①）：最近一次激活/加载失败原因（加密插件取钥失败：
                        需要订阅 / 版本未登记 / 密文不符被拒 / 云端故障可重试——文案自带出路）。
                        与 broken 原因分开展示：插件仍在「启用」态、后续触发即重试，不占熔断之名 */}
                    <Show when={p.state === 'enabled' && p.lastError}>
                      <div class="text-xs text-warning-700 mt-1">最近一次加载失败：{p.lastError}</div>
                    </Show>
                  </div>

                  <div class="flex items-center gap-2 shrink-0">
                    <Show when={p.state === 'broken' && !isCompatBroken(p)}>
                      <button class="btn-secondary px-3 py-1.5 text-xs" onClick={() => void retryPlugin(p)}>
                        重试
                      </button>
                    </Show>
                    <Show when={p.state !== 'broken'}>
                      <button
                        role="switch"
                        aria-checked={p.state === 'enabled'}
                        title={p.state === 'enabled' ? '禁用（保留代码与状态）' : '启用'}
                        class={`w-10 h-5 rounded-full relative transition-colors ${
                          p.state === 'enabled' ? 'bg-primary-500' : 'bg-surface-300'
                        }`}
                        onClick={() => void toggleEnabled(p)}
                      >
                        <span
                          class="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-[left,background-color]"
                          style={{ left: p.state === 'enabled' ? '22px' : '2px' }}
                        />
                      </button>
                    </Show>
                    <button
                      class="link-btn text-xs text-danger-500 hover:text-danger-600"
                      onClick={() => setUninstallTarget(p)}
                    >
                      卸载
                    </button>
                    <button
                      class="link-btn text-xs text-surface-500 hover:text-primary-600"
                      onClick={() => setExpanded(expanded() === p.id ? null : p.id)}
                    >
                      {expanded() === p.id ? '收起 ▴' : '详情 ▾'}
                    </button>
                  </div>
                </div>

                {/* 详情：broken 提示 / 权限 / 可观测 */}
                <Show when={expanded() === p.id}>
                  <div class="mt-4 pt-4 border-t border-surface-100 space-y-3">
                    <Show when={p.state === 'broken' && isCompatBroken(p)}>
                      <div class="text-xs text-surface-500">
                        该插件与当前宿主 API 不兼容：需升级宿主或升级插件后重试。
                      </div>
                    </Show>
                    {/* v2.5 增量（PLAN §3.1）：syncScope 展示（global 注明状态将随设备同步） */}
                    <Show when={p.syncScope === 'global'}>
                      <div class="text-xs text-surface-600">🔄 状态将随设备同步（syncScope: global）</div>
                    </Show>
                    <PermissionsView p={p} />
                    <MetricsView p={p} />
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* 卸载确认（明示：删除代码与状态） */}
      <Show when={uninstallTarget()}>
        <ConfirmDialog
          title="卸载插件"
          message={`确定卸载「${uninstallTarget()!.name}」吗？将删除插件代码与全部状态数据（${uninstallTarget()!.id}），此操作不可恢复。`}
          confirmLabel="卸载"
          danger
          onConfirm={() => void doUninstall(uninstallTarget()!)}
          onCancel={() => setUninstallTarget(null)}
        />
      </Show>

      {/* 侧载风险确认（v2.5 增量 PLAN §3.5：明确告知同等系统权限 + 未审查 + 信任来源） */}
      <Show when={importPath()}>
        <ConfirmDialog
          title="导入第三方插件包"
          message="此插件将获得与启禾文件管理同等的系统权限：可读取工作区文件、访问网络、执行系统命令。插件未经过官方审查。仅安装你信任来源的插件。确认安装？"
          confirmLabel="确认安装"
          danger
          onConfirm={() => void doInstall()}
          onCancel={() => setImportPath(null)}
        />
      </Show>

      {/* v2.6 批 2：更新即重启提示（覆盖安装命中已有插件时；口径见 docs/INTERNAL/PLUGIN.md §七） */}
      <Show when={restartNotice()}>
        <ConfirmDialog
          title={restartNotice()!.title}
          message={restartNotice()!.message}
          confirmLabel="立即重启"
          cancelLabel="稍后"
          onConfirm={() => {
            setRestartNotice(null)
            // 主进程 app.relaunch() + app.quit()：走正常退出路径（插件 dispose / 热键注销照跑）
            void relaunchApp()
          }}
          onCancel={() => setRestartNotice(null)}
        />
      </Show>
    </div>
  );
}
