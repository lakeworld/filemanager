import { describe, it, expect } from 'vitest'
import { sanitizeName, composeTargetName, resolveConflictName } from '../../src/main/core/naming'
import { defaultWorkspaceConfig } from '../../src/main/core/paths'
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
  it('默认模板组合 product_set + sub_folder + original_name', () => {
    const cfg = defaultWorkspaceConfig()
    const name = composeTargetName(cfg, 'banner', '.jpg', {
      targetProductSet: '夏季T恤系列',
      subFolder: '主图',
    })
    expect(name).toBe('夏季T恤系列_主图_banner.jpg')
  })

  it('空字段自动跳过', () => {
    const cfg = defaultWorkspaceConfig()
    const name = composeTargetName(cfg, '证书', '.pdf', {
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
    const name = composeTargetName(cfg, 'banner', '.png', {
      targetProductSet: '系列',
      subFolder: '主图',
    })
    expect(name).toBe('QH-系列-主图-banner-V1.png')
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
