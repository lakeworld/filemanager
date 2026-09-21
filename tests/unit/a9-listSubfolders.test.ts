/**
 * v2.5.9/A9 刀 1a：`files.listSubfolders` —— 子文件夹名单**以盘为准**（主进程侧）
 *
 * 设计口径（`DESIGN-v2.5.9-A9-子文件夹以盘为准.md` §二 §三 §四）：
 *  - tab 名单 = 该实体该类型目录下**实际存在**的子目录，不再是全局 config 那张表；
 *  - **空目录要显示并淡一档** ⇒ 接口必须带 `has_files`（渲染层自己再 readdir 一次就是双源+双倍 IO）；
 *  - **顺序在主进程排完再出**（§八 实测：readdir 顺序稳定但**不是名称序**，且不保证跨平台一致
 *    ⇒ 顺序只能有一个权威，散到渲染层排第二次就是双源）；
 *  - 客户 / 供应商同一把刀（§四 N2 之甲）。
 *  - 请求形状沿用仓内既有口径（`product_set` 槽位承载实体名 + `scope`），
 *    不另发明一套字段名——同一件事在三个 API 里叫三种名字就是双源。
 *
 * ⚠ 本文件只测主进程判据；渲染层"看不见盘上新建目录"那条 P2 的端到端反证在 `tests/e2e/`（刀 1b）。
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-'))

async function boxWithWs() {
  const home = await tmp()
  const ws = await tmp()
  const box = buildTestBox(home)
  await box.workspace.create(ws)
  return { box, ws }
}

describe('A9 刀1a · listSubfolders 以盘为准', () => {
  it('盘上新建的目录（config 表里没有）必须出现 —— P2 的根治判据', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '系列A' })
    // 绕过应用，直接在硬盘上建一个目录（模拟"手工建 / 坚果云同步进来"）
    await fsp.mkdir(path.join(ws, '产品集', '系列A', '图包', '场景实拍'), { recursive: true })

    const got = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    expect(got.map((s) => s.name)).toContain('场景实拍')
    // 而那张全局表里确实没有它 —— 证明"看得见"不是因为表里有
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.image_subfolders).not.toContain('场景实拍')
  })

  it('空目录 has_files=false、有文件 has_files=true（渲染层据此淡显）', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '系列A' })
    await fsp.mkdir(path.join(ws, '产品集', '系列A', '图包', '空的'), { recursive: true })
    const full = path.join(ws, '产品集', '系列A', '图包', '有货')
    await fsp.mkdir(full, { recursive: true })
    await fsp.writeFile(path.join(full, 'a.png'), 'x')

    const got = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    expect(got.find((s) => s.name === '空的')?.has_files).toBe(false)
    expect(got.find((s) => s.name === '有货')?.has_files).toBe(true)
  })

  it('按名称排序，且不是 readdir 原序 —— 顺序权威只能在主进程', async () => {
    const { box, ws } = await boxWithWs()
    await fsp.mkdir(path.join(ws, '产品集'), { recursive: true })
    await box.workspace.productSetCreate({ name: '系列A' })
    // 故意按"非拼音序"的创建顺序建（§八 实测本机 readdir 出来就是这个乱序形状）
    for (const n of ['主图', '白底图', '素材', '详情页']) {
      await fsp.mkdir(path.join(ws, '产品集', '系列A', '图包', n), { recursive: true })
    }
    const got = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    // 拼音序：白(bái) < 素(sù) < 详(xiáng) < 主(zhǔ)。写死字面量而不是"用同一个比较器再排一遍"，
    // 否则这条判据就成了同义反复（生产代码不排序时它照样绿）。
    expect(got.map((s) => s.name)).toEqual(['白底图', '素材', '详情页', '主图'])
  })

  it('证书 / 文档两域各自看自己的目录（不串台）', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '系列A' })
    await fsp.mkdir(path.join(ws, '产品集', '系列A', '证书', '报关单'), { recursive: true })
    await fsp.mkdir(path.join(ws, '产品集', '系列A', '文档', '安装手册'), { recursive: true })

    const cert = await box.files.listSubfolders({ product_set: '系列A', file_type: 'cert' })
    const doc = await box.files.listSubfolders({ product_set: '系列A', file_type: 'doc' })
    expect(cert.map((s) => s.name)).toContain('报关单')
    expect(cert.map((s) => s.name)).not.toContain('安装手册')
    expect(doc.map((s) => s.name)).toContain('安装手册')
    expect(doc.map((s) => s.name)).not.toContain('报关单')
  })

  it('客户 / 供应商同形状（§四 N2 之甲）', async () => {
    const { box, ws } = await boxWithWs()
    await box.clients.create({ name: '客户甲' })
    await fsp.mkdir(path.join(ws, '客户', '客户甲', '对账明细'), { recursive: true })
    const got = await box.files.listSubfolders({ product_set: '客户甲', scope: 'customer' })
    expect(got.map((s) => s.name)).toContain('对账明细')
  })

  it('隐藏目录与文件不进名单；实体不存在返回空数组而不抛错', async () => {
    const { box, ws } = await boxWithWs()
    await box.workspace.productSetCreate({ name: '系列A' })
    const imgs = path.join(ws, '产品集', '系列A', '图包')
    await fsp.mkdir(path.join(imgs, '.隐藏'), { recursive: true })
    await fsp.writeFile(path.join(imgs, '散落文件.png'), 'x')
    const got = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    expect(got.map((s) => s.name)).not.toContain('.隐藏')

    const none = await box.files.listSubfolders({ product_set: '不存在的集', file_type: 'image' })
    expect(none).toEqual([])
  })

  it('实体名带穿越路径必须被拒（复用既有安全闸，不是新写一套）', async () => {
    const { box } = await boxWithWs()
    await expect(
      box.files.listSubfolders({ product_set: '../../etc', file_type: 'image' }),
    ).rejects.toThrow()
  })
})
