/**
 * 仪表盘单测（v2.4.0）：产品集/文件统计、checkExpiringCerts 30 天窗口边界。
 */
import { describe, expect, it } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-dash-'))
}

/** 最小 1x1 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** n 天后的本地日期 YYYY-MM-DD（checkExpiringCerts 以本地 00:00 解析到期日） */
function dateInDays(n: number): string {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('仪表盘（DashboardService）', () => {
  it('统计：产品集 / 图片 / 证书 计数与最近文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })

    // 系列A 导入 2 张图（图包/主图）
    const img1 = path.join(ws, '..', 'i1.jpg')
    const img2 = path.join(ws, '..', 'i2.jpg')
    await fsp.writeFile(img1, PNG_1PX)
    await fsp.writeFile(img2, PNG_1PX)
    await box.files.importFiles({
      source_paths: [img1, img2],
      target_product_set: '系列A',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    // 系列B 导入 1 份证书（证书/3C 为默认子文件夹）
    const cert1 = path.join(ws, '..', 'c1.jpg')
    await fsp.writeFile(cert1, PNG_1PX)
    await box.files.importFiles({
      source_paths: [cert1],
      target_product_set: '系列B',
      target_folder: '3C',
      target_type: 'cert',
      sub_folder: '3C',
    })

    const stats = await box.dashboard.dashboardStats()
    expect(stats.total_product_sets).toBe(2)
    expect(stats.total_images).toBe(2)
    expect(stats.total_certs).toBe(1)
    expect(stats.recent_files).toHaveLength(3)
  })

  it('checkExpiringCerts：30 天窗口边界（29 天内命中、31 天外不命中、无期限跳过）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 无需真实文件：checkExpiringCerts 只遍历 metadata store
    const in29 = dateInDays(29)
    const out31 = dateInDays(31)
    await box.metadata.update({ product_set: '系列A', file_name: '29天.jpg', expiry_date: in29 })
    await box.metadata.update({ product_set: '系列A', file_name: '31天.jpg', expiry_date: out31 })
    await box.metadata.update({ product_set: '系列A', file_name: '无期限.jpg', expiry_date: '' })
    await box.metadata.update({ product_set: '系列B', file_name: '格式坏.jpg', expiry_date: '2026-13-99' })

    const expiring = await box.dashboard.checkExpiringCerts()
    const names = expiring.map(([, fn]) => fn)
    expect(names).toContain('29天.jpg')
    expect(names).not.toContain('31天.jpg')
    expect(names).not.toContain('无期限.jpg')
    // 解析失败的日期（2026-13-99 → NaN）跳过
    expect(names).not.toContain('格式坏.jpg')
  })
})
