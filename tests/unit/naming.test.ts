import { describe, it, expect } from 'vitest'
import { sanitizeName, composeTargetName, resolveConflictName } from '../../src/main/core/naming'
import { defaultWorkspaceConfig } from '../../src/main/core/paths'
import { batchRenameTargets } from '../../src/renderer/src/utils/batchRename'
import type { FileEntry } from '../../src/main/core/files'
import type { NamingTemplate } from '../../src/shared/types'
import fsp from 'node:fs/promises'
import path from 'node:path'

describe('sanitizeName', () => {
  it('替换非法字符为下划线', () => {
    expect(sanitizeName('白色圆领:测试/产品*名称?')).toBe('白色圆领_测试_产品_名称_')
  })
  it('去除首尾空白', () => {
    expect(sanitizeName('  主图  ')).toBe('主图')
  })
})

describe('composeTargetName', () => {
  // v2.4.9 S5：composeTargetName 收 NamingTemplate（默认模板已含 sequence，ctx 无 sequence → 槽位跳过，断言不变）
  it('默认模板组合 product_set + sub_folder + original_name', () => {
    const cfg = defaultWorkspaceConfig()
    const name = composeTargetName(cfg.naming_template, 'banner', '.jpg', {
      targetProductSet: '夏季T恤系列',
      subFolder: '主图',
    })
    expect(name).toBe('夏季T恤系列_主图_banner.jpg')
  })

  it('空字段自动跳过', () => {
    const cfg = defaultWorkspaceConfig()
    const name = composeTargetName(cfg.naming_template, '证书', '.pdf', {
      targetProductSet: '产品A',
      subFolder: '',
    })
    expect(name).toBe('产品A_证书.pdf')
  })

  it('自定义前后缀与分隔符', () => {
    const cfg = defaultWorkspaceConfig()
    cfg.naming_template.product_set_prefix = 'QH'
    cfg.naming_template.product_set_suffix = 'V1'
    cfg.naming_template.sku_separator = '-'
    const name = composeTargetName(cfg.naming_template, 'banner', '.png', {
      targetProductSet: '系列',
      subFolder: '主图',
    })
    expect(name).toBe('QH-系列-主图-banner-V1.png')
  })
})

describe('composeTargetName sequence 槽位（v2.4.9 S5）', () => {
  it('提供 sequence → 追加编号（默认模板 4 字段）', () => {
    const t = defaultWorkspaceConfig().naming_template
    const name = composeTargetName(t, 'banner', '.jpg', {
      targetProductSet: '夏季T恤系列',
      subFolder: '主图',
      sequence: '1',
    })
    expect(name).toBe('夏季T恤系列_主图_banner_1.jpg')
  })

  it('sequence 缺省/空 → 槽位跳过（发票/报价/交换区归档等旧调用行为不变）', () => {
    const t = defaultWorkspaceConfig().naming_template
    expect(
      composeTargetName(t, 'banner', '.jpg', { targetProductSet: '系列', subFolder: '主图' }),
    ).toBe('系列_主图_banner.jpg')
    expect(
      composeTargetName(t, 'banner', '.jpg', { targetProductSet: '系列', subFolder: '主图', sequence: '' }),
    ).toBe('系列_主图_banner.jpg')
  })

  it('多文件批次：编号随 1..N 递增（无补零）', () => {
    const t = defaultWorkspaceConfig().naming_template
    const names = [1, 2, 3].map((seq) =>
      composeTargetName(t, `img${seq}`, '.png', {
        targetProductSet: '系列',
        subFolder: '详情页',
        sequence: String(seq),
      }),
    )
    expect(names).toEqual(['系列_详情页_img1_1.png', '系列_详情页_img2_2.png', '系列_详情页_img3_3.png'])
  })

  it('两位数批次补零：total=10 → 01…10', () => {
    const t = defaultWorkspaceConfig().naming_template
    const name = composeTargetName(t, 'banner', '.jpg', {
      targetProductSet: '系列',
      subFolder: '主图',
      sequence: '01',
    })
    expect(name).toBe('系列_主图_banner_01.jpg')
  })
})

describe('batchRenameTargets（v2.4.9 S5 模板化签名）', () => {
  /** 构造 FileEntry（name 即磁盘文件名，用于冲突判定） */
  function fe(name: string): FileEntry {
    return { name, path: `/ws/${name}`, size: 1, modified: '', file_type: 'image', thumbnail_path: null }
  }

  /** 默认模板（4 字段，与主进程 defaultNamingTemplate 一致） */
  const TEMPLATE = defaultWorkspaceConfig().naming_template

  it('模板化组合：产品集名_子文件夹_原文件名_序号（序号补零位数按数量自适应）', () => {
    const files = [fe('a.jpg'), fe('b.png'), fe('c.jpg')]
    expect(batchRenameTargets(files, TEMPLATE, { targetProductSet: '系列', subFolder: '主图' }, 1)).toEqual([
      '系列_主图_a_1.jpg',
      '系列_主图_b_2.png',
      '系列_主图_c_3.jpg',
    ])
  })

  it('起始序号跨 10 位：自动升级补零位数', () => {
    const files = [fe('a.jpg'), fe('b.jpg'), fe('c.jpg'), fe('d.jpg'), fe('e.jpg')]
    expect(batchRenameTargets(files, TEMPLATE, { targetProductSet: 'P', subFolder: '' }, 97)).toEqual([
      'P_a_097.jpg',
      'P_b_098.jpg',
      'P_c_099.jpg',
      'P_d_100.jpg',
      'P_e_101.jpg',
    ])
  })

  it('目标名即自身原名：不视为冲突（原文件名独占模板 → 候选名 = 自身原名）', () => {
    // 自身原名永远在 existing 集合里——无 candidate !== files[i].name 守卫则全部会被误判冲突追加 _1
    const t1: NamingTemplate = { ...TEMPLATE, sku_fields: ['original_name'] }
    const files = [fe('a.jpg'), fe('b.png')]
    expect(batchRenameTargets(files, t1, { targetProductSet: '', subFolder: '' }, 1)).toEqual(['a.jpg', 'b.png'])
  })

  it('目标名与磁盘已有文件冲突 → 扩展名前插 _1 递增', () => {
    const files = [fe('a.jpg'), fe('系列_主图_a_1.jpg')]
    // f1 目标 系列_主图_a_1.jpg 与 f2 原名冲突 → 系列_主图_a_1_1.jpg；f2 正常
    expect(batchRenameTargets(files, TEMPLATE, { targetProductSet: '系列', subFolder: '主图' }, 1)).toEqual([
      '系列_主图_a_1_1.jpg',
      '系列_主图_系列_主图_a_1_2.jpg',
    ])
  })

  it('无扩展名文件：目标名不带扩展名，冲突 _k 原样追加（不丢主名）', () => {
    const files = [fe('DSC_0001'), fe('图_DSC_0001_1')]
    // f1 目标 图_DSC_0001_1 与 f2 原名冲突 → 无扩展名原样追加 _1 → 图_DSC_0001_1_1
    expect(batchRenameTargets(files, TEMPLATE, { targetProductSet: '图', subFolder: '' }, 1)).toEqual([
      '图_DSC_0001_1_1',
      '图_图_DSC_0001_1_2',
    ])
  })

  it('自定义分隔符与前后缀：模板配置生效', () => {
    const t = { ...TEMPLATE, sku_separator: '-', product_set_prefix: 'QH', product_set_suffix: 'V1' }
    const files = [fe('a.jpg'), fe('b.png')]
    expect(batchRenameTargets(files, t, { targetProductSet: '系列', subFolder: '主图' }, 1)).toEqual([
      'QH-系列-主图-a-1-V1.jpg',
      'QH-系列-主图-b-2-V1.png',
    ])
  })
})

describe('resolveConflictName', () => {
  it('冲突时追加 _{n} 序号（与原 Go 累积行为一致）', async () => {
    const dir = await fsp.mkdtemp('/tmp/qihebox-naming-')
    await fsp.writeFile(path.join(dir, 'a.jpg'), 'x')
    await fsp.writeFile(path.join(dir, 'a_1.jpg'), 'x')
    const name = await resolveConflictName(dir, 'a.jpg', '_{n}', '.jpg')
    expect(name).toBe('a_1_2.jpg') // 累积：a → a_1（已存在）→ a_1_2
  })

  it('无冲突时返回原名', async () => {
    const dir = await fsp.mkdtemp('/tmp/qihebox-naming-')
    const name = await resolveConflictName(dir, 'a.jpg', '_{n}', '.jpg')
    expect(name).toBe('a.jpg')
  })

  it('v2.4.2（D1）：无扩展名文件冲突 → 原名保留 + 序号后缀（LICENSE → LICENSE_1）', async () => {
    const dir = await fsp.mkdtemp('/tmp/qihebox-naming-')
    await fsp.writeFile(path.join(dir, 'LICENSE'), 'x')
    const name = await resolveConflictName(dir, 'LICENSE', '_{n}', '')
    // 旧实现 slice(0,-0) 会清空整个文件名得到 `_1`，这里必须保留 LICENSE 前缀
    expect(name).toBe('LICENSE_1')
  })
})
