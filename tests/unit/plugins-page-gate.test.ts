/**
 * 插件页闸门单测（v2.6 缺陷修复：官方目录 / 预装路线下免费与未登录用户看到裸 TypeError）。
 *
 * 为什么这些用例必须存在（缺陷卡内部留档、不进公开仓，见其 §四 的机理链条）：
 * 官方加密包里**没有明文 JS**，取钥被拒时渲染层动态 `import()` 只拿得到
 * `TypeError: Failed to fetch dynamically imported module`——没状态码没原因。
 * 分流所需的信息一直在渲染层手里（登记条目的 `state` + `lastError` + 结构化 `lastErrorCode`），
 * 只是此前没人查；而**判别只能发生在进页之前**，靠 parse 那条 TypeError 永远分不出「订阅/登录/重试」。
 *
 * 覆盖：
 * 1. `pluginKeyLoadCode`：云端 code（+ HTTP 状态）→ 五类结构化码（401 归「去登录」、5xx/故障归「重试」…）；
 * 2. `derivePluginPageGate` 五类分流 + 三类不该拦的态（无码 / 非启用 / 条目缺失）；
 * 3. 红线 4（宿主本体零订阅）：引导页拿到的每一段文案都不许出现价格；
 * 4. routes.tsx 接线（源码级门禁，本仓既有做法 = 源码包含性断言，见 plugins-contract.test.ts）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginInfo, PluginLoadErrorCode } from '../../src/shared/types'
import { pluginKeyLoadCode, type PluginKeyFailure } from '../../src/main/plugins/encryption'
import { derivePluginPageGate } from '../../src/renderer/src/plugins/registry'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROUTES_FILE = 'src/renderer/src/plugins/routes.tsx'

/** 登记条目夹具（必需字段齐全，按需覆盖） */
function plugin(over: Partial<PluginInfo> & { id: string }): PluginInfo {
  return {
    name: '局域网协作',
    version: '0.3.1',
    apiVersion: 1,
    kind: ['ipc', 'pages'],
    enabled: true,
    state: 'enabled',
    callCount: 0,
    failCount: 1,
    installedAt: '2026-09-23T00:00:00.000Z',
    ...over,
  }
}

/** 带取钥失败码的条目（缺陷现场那一形状：state 仍是 enabled，原因与原因码同点在案） */
function denied(code: PluginLoadErrorCode, lastError = '加密插件密钥不可用：示例原因——示例出路'): PluginInfo {
  return plugin({ id: 'com.qihe.lan', lastErrorCode: code, lastError })
}

describe('pluginKeyLoadCode：云端 code（含 HTTP 状态）→ 五类结构化码', () => {
  /** 逐条钉「输入码 → 分类码」——分类是渲染层分流的唯一依据，折叠或错位都会把用户带到别的路上 */
  const cases: Array<[PluginKeyFailure, PluginLoadErrorCode]> = [
    [{ code: 'SUBSCRIPTION_REQUIRED', httpStatus: 403 }, 'SUBSCRIPTION_REQUIRED'],
    [{ code: 'NOT_LOGGED_IN' }, 'NOT_LOGGED_IN'],
    // 401 = 鉴权中间件先于取钥 handler 拒绝（token 过期/失效）→ 出路同「未登录」：去登录
    [{ code: 'HTTP_ERROR', httpStatus: 401 }, 'NOT_LOGGED_IN'],
    // 5xx 等非鉴权类 HTTP 失败 → 可重试
    [{ code: 'HTTP_ERROR', httpStatus: 503 }, 'NETWORK'],
    // 无状态码的 HTTP_ERROR（理论不该出现）也归可重试，不让它冒充「需要登录」
    [{ code: 'HTTP_ERROR' }, 'NETWORK'],
    [{ code: 'NETWORK' }, 'NETWORK'],
    [{ code: 'INTERNAL', httpStatus: 500 }, 'NETWORK'],
    [{ code: 'BAD_RESPONSE', httpStatus: 200 }, 'NETWORK'],
    [{ code: 'TAMPERED', httpStatus: 403 }, 'TAMPERED'],
    // 拿到钥却解不开 = 本地这份与云端登记的不是同一份 → 出路同调包：重装
    [{ code: 'DECRYPT_FAILED' }, 'TAMPERED'],
    [{ code: 'PLUGIN_KEY_NOT_FOUND', httpStatus: 404 }, 'NOT_REGISTERED'],
    [{ code: 'PLUGIN_KEY_MISSING', httpStatus: 500 }, 'NOT_REGISTERED'],
    [{ code: 'ENTITLEMENT_UNKNOWN', httpStatus: 400 }, 'NOT_REGISTERED'],
    // 未识别的云端码（服务端将来新增）→ 兜底「联系发布方」，不假装「重试就好」
    [{ code: 'QUOTA_EXCEEDED', httpStatus: 429 }, 'NOT_REGISTERED'],
  ]
  it.each(cases)('%j → %s', (failure, expected) => {
    expect(pluginKeyLoadCode(failure)).toBe(expected)
  })

  it('五类码互不相同（同类码不得同时映射到两类出路）', () => {
    const codes: PluginLoadErrorCode[] = [
      'SUBSCRIPTION_REQUIRED',
      'NOT_LOGGED_IN',
      'NETWORK',
      'TAMPERED',
      'NOT_REGISTERED',
    ]
    expect(new Set(codes.map((c) => pluginKeyLoadCode({ code: c })))).toEqual(new Set(codes))
  })
})

describe('derivePluginPageGate：五类分流（原因 + 一个能点的出路按钮）', () => {
  it('SUBSCRIPTION_REQUIRED → 去订阅，落点是云插件既有订阅页（宿主不自建付费面）', () => {
    const g = derivePluginPageGate(denied('SUBSCRIPTION_REQUIRED'))
    expect(g.state).toBe('key-unavailable')
    expect(g.route).toBe('subscribe')
    expect(g.actionLabel).toBe('去订阅')
    expect(g.actionPath).toBe('/plugin/cloud?tab=vip')
    expect(g.title).toContain('需要订阅')
  })

  it('NOT_LOGGED_IN → 去登录，落账号页', () => {
    const g = derivePluginPageGate(denied('NOT_LOGGED_IN'))
    expect(g.route).toBe('login')
    expect(g.actionLabel).toBe('去登录')
    expect(g.actionPath).toBe('/profile')
    expect(g.title).toContain('登录')
  })

  it('NETWORK → 就地重试（不跳转：actionPath 为 null，点一下重挂一次模块即真取钥）', () => {
    const g = derivePluginPageGate(denied('NETWORK'))
    expect(g.route).toBe('retry')
    expect(g.actionLabel).toBe('重试')
    expect(g.actionPath).toBeNull()
  })

  it('TAMPERED → 去重装，指管理页（那里有卸载/重装入口）', () => {
    const g = derivePluginPageGate(denied('TAMPERED'))
    expect(g.route).toBe('reinstall')
    expect(g.actionLabel).toBe('去重装')
    expect(g.actionPath).toBe('/settings/plugins')
  })

  it('NOT_REGISTERED → 联系发布方，并带出插件名与版本号供用户转述', () => {
    const g = derivePluginPageGate(denied('NOT_REGISTERED'))
    expect(g.route).toBe('publisher')
    expect(g.actionPath).toBe('/settings/plugins')
    expect(g.name).toBe('局域网协作')
    expect(g.version).toBe('0.3.1')
  })

  it('原因正文用主进程算好的那句原话（宿主不另写措辞，避免双源漂移）', () => {
    const g = derivePluginPageGate(denied('NOT_LOGGED_IN', '加密插件密钥不可用：未登录启禾云账号，无法取密钥'))
    expect(g.reason).toBe('加密插件密钥不可用：未登录启禾云账号，无法取密钥')
  })

  it('有码但没原因句时以标题兜底（reason 不得为空——空正文等于又给用户一张没有话的脸）', () => {
    const g = derivePluginPageGate(plugin({ id: 'com.qihe.lan', lastErrorCode: 'NETWORK' }))
    expect(g.state).toBe('key-unavailable')
    expect(g.reason).toBe(g.title)
    expect(g.reason.length).toBeGreaterThan(0)
  })
})

describe('derivePluginPageGate：不该拦的态一律放行（明文侧载包的自带 paywall 一条不许夺）', () => {
  it('无结构化码（明文包 / 非取钥类失败）→ ok', () => {
    expect(derivePluginPageGate(plugin({ id: 'com.qihe.lan' })).state).toBe('ok')
    // 只有一句中文原因、没有码：也不拦——渲染层绝不靠猜文案分流
    expect(derivePluginPageGate(plugin({ id: 'com.qihe.lan', lastError: '该插件需要订阅后才能使用' })).state).toBe('ok')
  })

  it('非启用态（disabled / broken）→ ok（路由与侧栏本就不派生，闸门不越权）', () => {
    for (const state of ['disabled', 'broken'] as const) {
      const g = derivePluginPageGate(
        plugin({ id: 'com.qihe.lan', state, enabled: false, lastErrorCode: 'SUBSCRIPTION_REQUIRED' }),
      )
      expect(g.state, `state=${state}`).toBe('ok')
    }
  })

  it('条目缺失（清单还没拉到的竞态）→ ok：宁可不拦，也不画一张没有依据的脸', () => {
    expect(derivePluginPageGate(undefined).state).toBe('ok')
  })
})

describe('红线 4：宿主本体零订阅——引导页任何文案都不许出现价格', () => {
  const ALL_CODES: PluginLoadErrorCode[] = [
    'SUBSCRIPTION_REQUIRED',
    'NOT_LOGGED_IN',
    'NETWORK',
    'TAMPERED',
    'NOT_REGISTERED',
  ]
  it.each(ALL_CODES)('%s 的标题/按钮/正文零价格', (code) => {
    const g = derivePluginPageGate(denied(code))
    const joined = `${g.title}|${g.actionLabel}|${g.reason}|${g.name}|${g.version}`
    // 人民币符号 / 「数字+元」/「数字+/月|年」/ 档位数字一律禁止（此处刻意不写真实价格当负例，
    // 免得守卫测试自己把商业口径数字送进公开树；要举形就用「<整数> 元」「<整数>/年」）
    expect(joined).not.toMatch(/[¥￥]/)
    expect(joined).not.toMatch(/\d+\s*(元|块|角)/)
    expect(joined).not.toMatch(/\d+\s*\/\s*(月|年|天)/)
  })

  it('闸门模块自身不写死价格（扫源码：出现货币符号或「/月」「/年」计价串即红）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src/plugins/registry.ts'), 'utf-8')
    const gateBlock = src.slice(src.indexOf('插件页闸门'), src.indexOf('export function formatPluginSize'))
    expect(gateBlock).toBeTruthy()
    expect(gateBlock).not.toMatch(/[¥￥]/)
    expect(gateBlock).not.toMatch(/\d+\s*(元|块)/)
    expect(gateBlock).not.toMatch(/\$\d/)
  })
})

describe('routes.tsx 接线（源码级门禁）', () => {
  const src = fs.readFileSync(path.join(ROOT, ROUTES_FILE), 'utf-8')

  it('闸门在动态 import 之前判定，且命中时 source 置 null（不发请求）', () => {
    expect(src).toContain('derivePluginPageGate')
    // 闸门命中 → src 返回 null，Solid 的 createResource 拿到 nullish source 不调 fetcher
    expect(src).toMatch(/key-unavailable[\s\S]{0,40}return null/)
  })

  it('出路按钮在且可点（导航 + 就地重试两条路都在）', () => {
    expect(src).toContain('useNavigate')
    expect(src).toContain('navigate(g().actionPath ?? PLUGIN_MANAGER_PATH)')
    expect(src).toContain('props.onRetry()')
  })

  // 2026-09-23 真机踩坑留钉：把五个分支收进一个 `view()` 汇总 memo + `<Switch>` 之后，
  // `import()` 被拒（协议层 403）时界面**永久停在「加载中」**不再翻面——裸报错变成死转圈，比原样更糟。
  // 改回「闸门独立 memo + 嵌套 `<Show>`、加载链直接读 mod.loading / mod.error」才正常翻面（真机复测读数见本卡取证）。
  it('渲染分支形态钉：闸门独立 memo + 嵌套 Show，不得回到汇总 memo + Switch', () => {
    const solidImport = src.split('\n').find((l) => l.includes("from 'solid-js'")) ?? ''
    expect(solidImport, 'Switch / Match 不得再被引入（汇总分支形态实测会让 import 被拒后死转圈）').not.toMatch(/\b(Switch|Match)\b/)
    expect(src).toMatch(/const blocked = createMemo\(\(\) => gate\(\)\.state === 'key-unavailable'/)
    expect(src).toMatch(/<Show when=\{!mod\.loading\} fallback=\{<Loading text="插件页面加载中…" \/>\}/)
    expect(src).toMatch(/when=\{!mod\.error\}[\s\S]{0,140}<PluginTechFailPage/)
  })

  it('裸抛分支降级：原文不再当主脸（`String(mod.error)` 不得出现在页面正文里）', () => {
    expect(src).not.toMatch(/插件页面加载失败：\{String/)
    // 技术失败外壳只把原文交给控制台
    expect(src).toContain('console.warn')
  })

  it('闸门随 plugins() 信号响应式重算（登录/订阅生效后自动放行，不靠重启）', () => {
    expect(src).toContain('plugins().find')
    expect(src).toContain('refreshPluginRegistry()')
  })
})
