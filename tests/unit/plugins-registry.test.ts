/**
 * 渲染层插件注册表单测（v2.5，P0）：纯逻辑抽测（PLAN §八「渲染层 registry」）。
 * 覆盖：list() 输出 → Sidebar 插件分组 / 动态路由表 / 右键命令集的派生规则
 * （启用/禁用/broken 过滤、scope 过滤、when.exts 透传），以及协议 URL 生成与路径包含校验。
 * 派生函数为纯函数（不触碰 window / IPC），可直接以 PluginInfo 字面量构造输入。
 */
import { describe, expect, it } from 'vitest'
import type { PluginInfo } from '../../src/shared/types'
import {
  deriveFileCommands,
  deriveGlobalCommands,
  deriveRoutes,
  deriveSidebarGroups,
  pluginModuleUrl,
} from '../../src/renderer/src/plugins/registry'

/** 测试用 PluginInfo 构造器（必需字段齐全，可按需覆盖） */
function plugin(overrides: Partial<PluginInfo> & { id: string }): PluginInfo {
  return {
    name: '示例插件',
    version: '0.1.0',
    apiVersion: 1,
    kind: ['ipc'],
    enabled: true,
    state: 'enabled',
    callCount: 0,
    failCount: 0,
    installedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  }
}

/** 带 pages / commands 能力的插件（kind 齐全） */
function fullPlugin(overrides: Partial<PluginInfo> & { id: string }): PluginInfo {
  return plugin({
    kind: ['ipc', 'pages', 'commands'],
    pages: [
      { path: '/plugin/hello', label: '示例页', icon: 'plugin', group: '示例', component: 'renderer/pages/Main.js' },
      { path: '/plugin/hello/about', label: '关于', icon: 'info', group: '示例', component: 'renderer/pages/About.js' },
    ],
    commands: [
      { id: 'ping', label: '示例命令', scope: 'file', when: { exts: ['.png', '.jpg'] } },
      { id: 'globalCmd', label: '全局命令', scope: 'global' },
      { id: 'noExts', label: '无过滤命令', scope: 'file' },
    ],
    ...overrides,
  })
}

describe('deriveSidebarGroups：列表 → Sidebar 插件分组（PLAN §5.5）', () => {
  it('无插件 / 无启用页面 → 空数组（Sidebar 零变化）', () => {
    expect(deriveSidebarGroups([])).toEqual([])
    expect(deriveSidebarGroups([plugin({ id: 'com.qihe.a', kind: ['ipc'] })])).toEqual([])
    expect(deriveSidebarGroups([plugin({ id: 'com.qihe.a', state: 'disabled', kind: ['pages'], pages: [{ path: '/p', label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }] })])).toEqual([])
  })

  it('启用插件 pages → 单组「插件」，按清单顺序保留页面', () => {
    const groups = deriveSidebarGroups([fullPlugin({ id: 'com.qihe.hello' })])
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe('插件')
    expect(groups[0].items).toEqual([
      { icon: 'plugin', label: '示例页', path: '/plugin/hello' },
      { icon: 'info', label: '关于', path: '/plugin/hello/about' },
    ])
  })

  it('多插件页面合并进同一组；broken / 禁用 / 无 pages 的插件被排除', () => {
    const groups = deriveSidebarGroups([
      fullPlugin({ id: 'com.qihe.a' }),
      fullPlugin({ id: 'com.qihe.b', state: 'disabled' }),
      fullPlugin({ id: 'com.qihe.c', state: 'broken', brokenReason: '缺入口' }),
      plugin({ id: 'com.qihe.d', kind: ['ipc'] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].items).toEqual([
      { icon: 'plugin', label: '示例页', path: '/plugin/hello' },
      { icon: 'info', label: '关于', path: '/plugin/hello/about' },
    ])
  })
})

describe('deriveRoutes：列表 → 动态路由表（PLAN §5.2）', () => {
  it('启用插件 pages → 路由表（path / pluginId / component / label）', () => {
    expect(deriveRoutes([fullPlugin({ id: 'com.qihe.hello' })])).toEqual([
      { path: '/plugin/hello', pluginId: 'com.qihe.hello', component: 'renderer/pages/Main.js', label: '示例页' },
      { path: '/plugin/hello/about', pluginId: 'com.qihe.hello', component: 'renderer/pages/About.js', label: '关于' },
    ])
  })

  it('禁用 / broken / 无 pages → 不产生路由', () => {
    expect(
      deriveRoutes([
        fullPlugin({ id: 'com.qihe.a', state: 'disabled' }),
        fullPlugin({ id: 'com.qihe.b', state: 'broken', brokenReason: 'apiCompat 不兼容' }),
        plugin({ id: 'com.qihe.c', kind: ['ipc'] }),
      ]),
    ).toEqual([])
  })
})

describe('deriveFileCommands：列表 → 右键命令注入槽（PLAN §5.3）', () => {
  it('启用插件 scope=file 命令 → 注入条目（when.exts 透传）', () => {
    expect(deriveFileCommands([fullPlugin({ id: 'com.qihe.hello' })])).toEqual([
      { pluginId: 'com.qihe.hello', commandId: 'ping', label: '示例命令', exts: ['.png', '.jpg'] },
      { pluginId: 'com.qihe.hello', commandId: 'noExts', label: '无过滤命令' },
    ])
  })

  it('scope=global / 禁用插件命令 → 排除', () => {
    expect(
      deriveFileCommands([
        fullPlugin({ id: 'com.qihe.a', state: 'disabled' }),
        fullPlugin({ id: 'com.qihe.b', state: 'broken', brokenReason: '熔断' }),
      ]),
    ).toEqual([])
  })

  it('无 when.exts 的命令不带 exts 字段（菜单对该命令全类型可见）', () => {
    const cmds = deriveFileCommands([fullPlugin({ id: 'com.qihe.hello' })])
    expect('exts' in cmds[1]).toBe(false)
  })
})

describe('deriveGlobalCommands：列表 → 表单上下文命令槽（v2.5.4 Task 4 发票识别）', () => {
  it('启用插件 scope=global 命令 → 注入条目（无 when 过滤）', () => {
    expect(deriveGlobalCommands([fullPlugin({ id: 'com.qihe.hello' })])).toEqual([
      { pluginId: 'com.qihe.hello', commandId: 'globalCmd', label: '全局命令' },
    ])
  })

  it('scope=file 命令 / 禁用 / broken / 无 commands → 排除', () => {
    expect(
      deriveGlobalCommands([
        fullPlugin({ id: 'com.qihe.a', state: 'disabled' }),
        fullPlugin({ id: 'com.qihe.b', state: 'broken', brokenReason: '熔断' }),
        plugin({ id: 'com.qihe.c', kind: ['ipc'] }),
        plugin({ id: 'com.qihe.d', kind: ['commands'], commands: [{ id: 'f', label: 'x', scope: 'file' }] }),
      ]),
    ).toEqual([])
  })
})

describe('pluginModuleUrl：协议 URL 生成与路径包含校验（PLAN §4.3）', () => {
  it('合法包内相对路径 → qihebox://plugin/<id>/<relpath>', () => {
    expect(pluginModuleUrl('com.qihe.hello', 'renderer/pages/Main.js')).toBe(
      'qihebox://plugin/com.qihe.hello/renderer/pages/Main.js',
    )
    expect(pluginModuleUrl('com.qihe.hello', 'icons/logo.png')).toBe(
      'qihebox://plugin/com.qihe.hello/icons/logo.png',
    )
  })

  it('路径含空格 / 中文 → 段级 encodeURIComponent（URL 合法）', () => {
    expect(pluginModuleUrl('com.qihe.hello', 'renderer/我的 页面.js')).toBe(
      'qihebox://plugin/com.qihe.hello/renderer/%E6%88%91%E7%9A%84%20%E9%A1%B5%E9%9D%A2.js',
    )
  })

  it('绝对路径 / .. 逃逸 / 空路径 / 空 id → null（拒绝）', () => {
    for (const bad of ['/etc/passwd', 'renderer/../../secrets.js', '../x.js', '\\renderer\\Main.js', '', 'a//b']) {
      expect(pluginModuleUrl('com.qihe.hello', bad)).toBeNull()
    }
    expect(pluginModuleUrl('', 'renderer/Main.js')).toBeNull()
    expect(pluginModuleUrl('com.qihe.hello', 'renderer/Main.js')).not.toBeNull()
  })
})
