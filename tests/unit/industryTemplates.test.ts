/**
 * 行业文件夹模板（v2.6.1）：8 款内置词表 + 五列全等判定 + placeholder 派生。
 *
 * 这两条是本文件的**钉死项**（不是顺手加的）：
 *  ① 电商款五张清单必须**逐字等于**主进程 `paths.ts defaultWorkspaceConfig()`——老工作区（config 里没有
 *     custom_templates、五列就是默认值）一开设置页，徽标必须判成「内置 · 电商」而不是「自定义」；
 *     差一个字（顺序也算）就会让所有老用户看到「自定义」。
 *  ② `matchTemplate` 是**全等**判定，不是子集/包含——手改任意一张清单就该落回 none（界面显示「自定义」），
 *     子集判定会把"改过一半"的配置误判成命中模板（本批变异自证的靶子就是这条）。
 */
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TEMPLATES,
  FALLBACK_PLACEHOLDER,
  matchTemplate,
  placeholderFor,
} from '../../src/shared/industryTemplates'
import { defaultWorkspaceConfig } from '../../src/main/core/paths'
import type { IndustryTemplate, WorkspaceConfig } from '../../src/shared/types'

/** 五张清单齐备的配置（从默认值拷一份再按需覆盖） */
const cfgOf = (over: Partial<WorkspaceConfig> = {}): WorkspaceConfig => ({ ...defaultWorkspaceConfig(), ...over })

/** 从某模板拷出五张清单（用于构造"自定义模板"样本） */
const fiveOf = (t: IndustryTemplate) => ({
  image_subfolders: [...t.image_subfolders],
  cert_subfolders: [...t.cert_subfolders],
  doc_subfolders: [...t.doc_subfolders],
  customer_subfolders: [...t.customer_subfolders],
  supplier_subfolders: [...t.supplier_subfolders],
})

describe('industryTemplates · 内置词表与派生判定（v2.6.1）', () => {
  it('内置 8 款：五列非空、无空串、无重复项', () => {
    expect(BUILTIN_TEMPLATES.length).toBe(8)
    for (const t of BUILTIN_TEMPLATES) {
      const lists = {
        图包: t.image_subfolders,
        证书: t.cert_subfolders,
        文档: t.doc_subfolders,
        客户: t.customer_subfolders,
        供应商: t.supplier_subfolders,
      }
      for (const [label, list] of Object.entries(lists)) {
        expect(list.length, `${t.name} 的${label}清单不应为空`).toBeGreaterThan(0)
        for (const name of list) expect(name.trim(), `${t.name} 的${label}清单含空串`).not.toBe('')
        expect(new Set(list).size, `${t.name} 的${label}清单有重复项：${list.join('/')}`).toBe(list.length)
      }
      expect(t.name.trim(), '模板展示名不应为空').not.toBe('')
    }
  })

  it('id 唯一（内置之间不撞）', () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('电商款五张清单逐字 === 主进程 defaultWorkspaceConfig()', () => {
    const ec = BUILTIN_TEMPLATES.find((t) => t.id === 'ecommerce')
    expect(ec, '内置词表里应有一款 id=ecommerce').toBeTruthy()
    const def = defaultWorkspaceConfig()
    expect(fiveOf(ec!)).toEqual({
      image_subfolders: def.image_subfolders,
      cert_subfolders: def.cert_subfolders,
      doc_subfolders: def.doc_subfolders,
      customer_subfolders: def.customer_subfolders,
      supplier_subfolders: def.supplier_subfolders,
    })
  })

  it('「同默认」两处（销售 / 医药供应商列）=== 主进程默认供应商清单', () => {
    for (const id of ['sales', 'medical']) {
      const t = BUILTIN_TEMPLATES.find((x) => x.id === id)
      expect(t, `内置词表里应有 id=${id}`).toBeTruthy()
      expect(t!.supplier_subfolders, `${t!.name} 供应商列应等于默认集`).toEqual(defaultWorkspaceConfig().supplier_subfolders)
    }
  })

  it('matchTemplate 三态：全等命中内置 / 差一列落回 none / 自定义全等命中 custom', () => {
    // ① 默认配置 = 电商款全等 → builtin
    const hit = matchTemplate(cfgOf())
    expect(hit.kind).toBe('builtin')
    expect(hit.template?.id).toBe('ecommerce')

    // ② 手改任意一张清单的一张表（差一列）→ none（界面显示「自定义」）
    const edited = cfgOf({ image_subfolders: [...defaultWorkspaceConfig().image_subfolders, '手加的一层'] })
    expect(matchTemplate(edited).kind).toBe('none')
    expect(matchTemplate(edited).template).toBeUndefined()

    // ③ 用户自定义模板全等 → custom（id 由渲染层生成 'custom:<名字>'）
    //    词表刻意自造（不是任何内置款的五列），否则会被"内置优先"先接走——那是下一条用例的靶子
    const custom: IndustryTemplate = {
      id: 'custom:我的套',
      name: '我的套',
      image_subfolders: ['甲图', '乙图'],
      cert_subfolders: ['丙证'],
      doc_subfolders: ['丁档'],
      customer_subfolders: ['戊客'],
      supplier_subfolders: ['己供'],
    }
    const withCustom = cfgOf({ ...fiveOf(custom), custom_templates: [custom] })
    const m = matchTemplate(withCustom)
    expect(m.kind).toBe('custom')
    expect(m.template?.id).toBe('custom:我的套')
  })

  it('matchTemplate：五列任缺一致即不命中（只差供应商列 / 只差客户列都算 none）', () => {
    // 判定必须覆盖**全部五列**——"只比前四列"或"只比图包列"的退化实现会被这两条抓住
    const hw = BUILTIN_TEMPLATES.find((t) => t.id === 'hardware')!
    const ec = BUILTIN_TEMPLATES.find((t) => t.id === 'ecommerce')!
    expect(
      matchTemplate(cfgOf({ ...fiveOf(hw), supplier_subfolders: [...ec.supplier_subfolders] })).kind,
      '只差供应商列（其余四列与「制造·五金」全等）不该判成命中',
    ).toBe('none')
    const food = BUILTIN_TEMPLATES.find((t) => t.id === 'food')!
    expect(
      matchTemplate(cfgOf({ ...fiveOf(food), customer_subfolders: ['报价', '合同', '沟通', '其他'] })).kind,
      '只差客户列（其余四列与「食品」全等）不该判成命中',
    ).toBe('none')
  })

  it('matchTemplate：内置优先于自定义（同五列并存时判内置）；config 为 null 时判 none', () => {
    const ec = BUILTIN_TEMPLATES.find((t) => t.id === 'ecommerce')!
    const shadow: IndustryTemplate = { id: 'custom:影子', name: '影子', ...fiveOf(ec) }
    const m = matchTemplate(cfgOf({ custom_templates: [shadow] }))
    expect(m.kind).toBe('builtin')
    expect(m.template?.id).toBe('ecommerce')
    expect(matchTemplate(null).kind).toBe('none')
  })

  it('matchTemplate：某列表框缺省（旧 config 未合并前）视为空清单，不崩也不误命中', () => {
    const cfg = cfgOf()
    // 刻意构造旧 config 形状：doc/supplier 未合并前缺省（可选键，delete 合法）
    delete cfg.doc_subfolders
    delete cfg.supplier_subfolders
    // 缺省两列与任何内置都不全等 ⇒ none（不是抛异常）
    expect(matchTemplate(cfg).kind).toBe('none')
  })

  it('placeholderFor：命中取该模板例，未命中/自定义态回通用例', () => {
    expect(placeholderFor(cfgOf()), '电商默认应取电商例').toBe('如：夏季T恤系列')
    const med = BUILTIN_TEMPLATES.find((t) => t.id === 'medical')!
    expect(placeholderFor(cfgOf({ ...fiveOf(med) }))).toBe('如：阿莫西林胶囊')
    // 未命中（手改一张）→ 通用例
    expect(placeholderFor(cfgOf({ cert_subfolders: ['手改'] }))).toBe(FALLBACK_PLACEHOLDER)
    expect(placeholderFor(null)).toBe(FALLBACK_PLACEHOLDER)
  })
})