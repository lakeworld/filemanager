/**
 * 插件协议同源定义单测（v2.5，P0）：validateManifest 逐条落地 PLUGIN.md §2.2 的 7 条规则
 * （全局唯一性除外——无宿主上下文，属 registry 登记期校验）+ v2.5 增量规则⑧（syncScope）⑨（permissions.account）
 * + 结构缺字段/类型错误 + 合法 manifest + API_VERSION。
 * 校验函数为纯函数（零依赖、不 import electron），直接以对象字面量构造清单输入。
 */
import { describe, expect, it } from 'vitest'
import { API_VERSION, validateManifest } from '../../src/plugins/types'

/** 最简合法清单（仅必需字段，kind 仅声明 ipc） */
function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'com.qihe.hello',
    name: '示例插件',
    version: '0.1.0',
    apiVersion: 1,
    enabled: true,
    kind: ['ipc'],
    ipcPrefix: 'hello',
    ...overrides,
  }
}

function errorsContain(input: unknown, needle: string): boolean {
  return validateManifest(input).errors.join('\n').includes(needle)
}

describe('API_VERSION 常量', () => {
  it('宿主 API 版本恒为 1（apiCompat 相交校验基准）', () => {
    expect(API_VERSION).toBe(1)
  })
})

describe('合法 manifest', () => {
  it('最简 manifest（仅必需字段）通过', () => {
    const r = validateManifest(baseManifest())
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('完整 manifest（全部可选字段 + 三种能力）通过', () => {
    const r = validateManifest(
      baseManifest({
        kind: ['ipc', 'pages', 'commands'],
        apiCompat: [1, 1],
        minHostVersion: '2.5.0',
        transport: 'inproc',
        // v2.5 增量：syncScope + permissions.account 随完整清单通过
        syncScope: 'global',
        permissions: { network: ['api.qihe.com'], clipboard: true, notification: false, account: true },
        activation: ['onStartupFinished', 'onEvent:hello:workspaceChanged'],
        pages: [{ path: '/plugin/hello', label: { default: '示例', en: 'Example' }, icon: 'plugin', group: '示例', component: 'renderer/pages/Main.js' }],
        commands: [{ id: 'ping', label: '示例命令', scope: 'file', when: { exts: ['.png', '.jpg'] } }],
        description: { default: '示例插件', en: 'Example plugin' },
        author: '启禾',
        license: 'MIT',
        keywords: ['示例'],
        icon: 'icons/logo.png',
        homepage: 'https://qihebook.cloud',
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })
})

describe('规则①：id / ipcPrefix 合法性', () => {
  it('id 非域名倒序 → 报错（单段 / 空段 / 大小写 / 空串 / 非字符串）', () => {
    for (const bad of ['hello', 'com..qihe.hello', '.com.qihe', 'com.qihe.', 'Hello', '', 42, null]) {
      const r = validateManifest(baseManifest({ id: bad }))
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('id')
    }
    expect(validateManifest(baseManifest({ id: 'com.qihe.hello' })).ok).toBe(true)
  })

  it('ipcPrefix 以保留前缀 qihebox: 开头 / 空串 / 非字符串 → 报错', () => {
    for (const bad of ['qihebox:ai', 'qihebox:plugin:ai', '', 42]) {
      const r = validateManifest(baseManifest({ ipcPrefix: bad }))
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('ipcPrefix')
    }
    expect(validateManifest(baseManifest({ ipcPrefix: 'hello' })).ok).toBe(true)
  })
})

describe('规则②：kind 与 pages/commands 存在性一致（双向）', () => {
  it('kind 声明 pages 但无 pages 字段 → 报错；声明 pages 字段但 kind 未声明 → 报错', () => {
    expect(errorsContain(baseManifest({ kind: ['ipc', 'pages'] }), 'pages')).toBe(true)
    const page = { path: '/plugin/x', label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }
    expect(errorsContain(baseManifest({ pages: [page] }), 'pages')).toBe(true)
  })

  it('kind 与 commands 双向一致校验', () => {
    expect(errorsContain(baseManifest({ kind: ['ipc', 'commands'] }), 'commands')).toBe(true)
    expect(errorsContain(baseManifest({ commands: [{ id: 'c', label: 'l', scope: 'file' }] }), 'commands')).toBe(true)
  })

  it('kind 空数组 → 报错（至少声明一项能力）', () => {
    expect(validateManifest(baseManifest({ kind: [] })).ok).toBe(false)
  })

  it('kind 与字段同时声明 → 通过', () => {
    const r = validateManifest(
      baseManifest({
        kind: ['ipc', 'pages', 'commands'],
        pages: [{ path: '/plugin/p', label: 'l', icon: 'i', group: 'g', component: 'renderer/Main.js' }],
        commands: [{ id: 'c', label: 'l', scope: 'global' }],
      }),
    )
    expect(r.ok).toBe(true)
  })
})

describe('规则③：apiCompat 与宿主 API_VERSION=1 相交（缺省即 [1,1]）', () => {
  it('apiCompat 不相交 → 报错', () => {
    for (const compat of [[2, 3], [0, 0], [1.5, 2], [0, 0.5]]) {
      const r = validateManifest(baseManifest({ apiCompat: compat }))
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('apiCompat')
    }
  })

  it('apiCompat 相交（缺省 / [1,1] / [0,2]）→ 通过', () => {
    expect(validateManifest(baseManifest()).ok).toBe(true)
    expect(validateManifest(baseManifest({ apiCompat: [1, 1] })).ok).toBe(true)
    expect(validateManifest(baseManifest({ apiCompat: [0, 2] })).ok).toBe(true)
  })

  it('apiCompat 非 [min, max] 元组（缺项 / min>max / 非数字）→ 报错', () => {
    for (const bad of [[1], [2, 1], [1, '2'], '1.1']) {
      expect(validateManifest(baseManifest({ apiCompat: bad })).ok).toBe(false)
    }
  })

  it('minHostVersion 仅记录不校验：合法字符串通过，非字符串报错', () => {
    expect(validateManifest(baseManifest({ minHostVersion: '2.5.0' })).ok).toBe(true)
    expect(validateManifest(baseManifest({ minHostVersion: 1 })).ok).toBe(false)
  })
})

describe('规则④：pages[].component 包内相对路径 + pages[].path 以 / 开头', () => {
  function withComponent(component: unknown): ReturnType<typeof validateManifest> {
    return validateManifest(
      baseManifest({
        kind: ['ipc', 'pages'],
        pages: [{ path: '/plugin/x', label: 'x', icon: 'i', group: 'g', component }],
      }),
    )
  }

  it('绝对路径 / .. 逃逸 / 反斜杠开头 / 空串 → 报错', () => {
    for (const bad of ['/etc/passwd', 'renderer/../../secrets.js', '../x.js', '\\renderer\\Main.js', '']) {
      const r = withComponent(bad)
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('component')
    }
  })

  it('包内相对路径 → 通过', () => {
    expect(withComponent('renderer/pages/Main.js').ok).toBe(true)
    expect(withComponent('main/index.js').ok).toBe(true)
  })

  it('pages[].path 不以 / 开头 → 报错', () => {
    expect(errorsContain(baseManifest({ pages: [{ path: 'plugin/x', label: 'x', icon: 'i', group: 'g', component: 'renderer/Main.js' }] }), 'path')).toBe(true)
  })
})

describe('规则⑤：transport 缺省或 inproc', () => {
  it("transport: 'process' / 'http' / 非字符串 → 报错", () => {
    for (const bad of ['process', 'http', 1]) {
      const r = validateManifest(baseManifest({ transport: bad }))
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('transport')
    }
  })

  it("transport 缺省 / 'inproc' → 通过", () => {
    expect(validateManifest(baseManifest()).ok).toBe(true)
    expect(validateManifest(baseManifest({ transport: 'inproc' })).ok).toBe(true)
  })
})

describe('规则⑥：permissions.network 域名合法；"*" 须附 reasoning（落地为 description 非空）', () => {
  it('非法域名（URL / 端口 / 空串 / 通配前缀 / 双点）→ 报错', () => {
    for (const bad of [['https://api.qihe.com'], ['api.qihe.com:8080'], [''], ['*.qihe.com'], ['a..b']]) {
      const r = validateManifest(baseManifest({ permissions: { network: bad } }))
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('network')
    }
  })

  it('合法域名白名单（含单标签主机名）→ 通过', () => {
    expect(validateManifest(baseManifest({ permissions: { network: ['api.qihe.com', 'localhost'] } })).ok).toBe(true)
  })

  it("network 含 '*' 但 description 缺失 / 为空 → 报错", () => {
    expect(validateManifest(baseManifest({ permissions: { network: ['*'] } })).ok).toBe(false)
    expect(validateManifest(baseManifest({ permissions: { network: ['*'] }, description: '   ' })).ok).toBe(false)
  })

  it("network 含 '*' 且有非空 description → 通过（reasoning 落地口径）", () => {
    const r = validateManifest(baseManifest({ permissions: { network: ['*'] }, description: '示例插件：访问任意网络域名' }))
    expect(r.ok).toBe(true)
  })

  it('clipboard / notification 非布尔 → 报错', () => {
    const r = validateManifest(baseManifest({ permissions: { network: ['api.qihe.com'], clipboard: 'yes', notification: 1 } }))
    expect(r.ok).toBe(false)
  })
})

describe('规则⑦：activation.onEvent 通道以本插件 ipcPrefix 开头', () => {
  it('onEvent 通道不以 ipcPrefix 开头（含空通道 / 宿主保留通道）→ 报错', () => {
    for (const bad of ['onEvent:workspaceChanged', 'onEvent:', 'onEvent:qihebox:event']) {
      const r = validateManifest(baseManifest({ activation: [bad] }))
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('onEvent')
    }
  })

  it('onEvent 通道以 ipcPrefix 开头 / onStartupFinished → 通过', () => {
    const r = validateManifest(baseManifest({ activation: ['onStartupFinished', 'onEvent:hello:workspaceChanged'] }))
    expect(r.ok).toBe(true)
  })

  it('activation 非法值 / 非数组 → 报错', () => {
    expect(validateManifest(baseManifest({ activation: ['onView'] })).ok).toBe(false)
    expect(validateManifest(baseManifest({ activation: 'onStartupFinished' })).ok).toBe(false)
  })
})

describe('规则⑧：syncScope 合法枚举或缺失（v2.5 增量，PLAN §3.1）', () => {
  it("'global' / 'local' / 缺省（默认 'local'）→ 通过", () => {
    expect(validateManifest(baseManifest({ syncScope: 'global' })).ok).toBe(true)
    expect(validateManifest(baseManifest({ syncScope: 'local' })).ok).toBe(true)
    expect(validateManifest(baseManifest()).ok).toBe(true)
  })

  it("非法值（'cloud' / 大小写 / 空串 / 数字 / null）→ 拒绝", () => {
    for (const bad of ['cloud', 'Global', '', 1, null]) {
      const r = validateManifest(baseManifest({ syncScope: bad }))
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('syncScope')
    }
  })
})

describe('规则⑨：permissions.account 布尔校验（v2.5 增量，PLAN §3.2）', () => {
  it('account 布尔（true / false / 缺省）→ 通过', () => {
    expect(validateManifest(baseManifest({ permissions: { account: true } })).ok).toBe(true)
    expect(validateManifest(baseManifest({ permissions: { account: false } })).ok).toBe(true)
    expect(validateManifest(baseManifest({ permissions: {} })).ok).toBe(true)
    expect(validateManifest(baseManifest()).ok).toBe(true)
  })

  it('account 非布尔（字符串 / 数字）→ 拒绝', () => {
    for (const bad of ['yes', 1]) {
      const r = validateManifest(baseManifest({ permissions: { account: bad } }))
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain('permissions.account')
    }
  })
})

describe('结构校验：必需字段缺失 / 类型错误逐条报', () => {
  it('非对象输入（null / 数字 / 字符串 / 数组 / undefined）→ 报错', () => {
    for (const bad of [null, 42, 'str', [], undefined]) {
      const r = validateManifest(bad)
      expect(r.ok).toBe(false)
      expect(r.errors).toContain('manifest 必须为 JSON 对象')
    }
  })

  it('必需字段逐个缺失 → 各报一条', () => {
    for (const missing of ['id', 'name', 'version', 'apiVersion', 'enabled', 'kind', 'ipcPrefix']) {
      const m = baseManifest()
      delete m[missing]
      const r = validateManifest(m)
      expect(r.ok).toBe(false)
      expect(r.errors.join('\n')).toContain(missing)
    }
  })

  it('name 非 PluginText（数字 / map 缺 default / map 值非字符串 / 数组）→ 报错', () => {
    for (const bad of [42, { zh: 'x' }, { default: 1 }, []]) {
      expect(validateManifest(baseManifest({ name: bad })).ok).toBe(false)
    }
    expect(validateManifest(baseManifest({ name: { default: '示例', en: 'Example' } })).ok).toBe(true)
  })

  it('pages 元素缺字段 / commands scope 非法 → 报错', () => {
    const r = validateManifest(
      baseManifest({
        kind: ['ipc', 'pages', 'commands'],
        pages: [{ path: '/p', label: 'x' }],
        commands: [{ id: 'c', label: 'l', scope: 'window' }],
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain('pages[0]')
    expect(r.errors.join('\n')).toContain('scope')
  })

  it('多个错误一次性汇总返回（不提前终止）', () => {
    const r = validateManifest({
      id: 'bad-id',
      name: 42,
      version: 1,
      apiVersion: 1,
      enabled: true,
      kind: ['pages'],
      ipcPrefix: 'qihebox:x',
    })
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThanOrEqual(4)
  })
})
