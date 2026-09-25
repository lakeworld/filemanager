import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { TRASH_RETENTION_DAYS } from '../../src/main/core/trash'
import {
  TRASH_RETENTION_DAYS as TRASH_RETENTION_DAYS_UI,
  trashDaysLeft,
  trashDaysLeftLabel,
} from '../../src/renderer/src/constants/trash'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-trash-'))
}

/** 最小 1x1 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 导入一张 PNG 到 系列A/图包/主图，返回 FileEntry */
async function importOne(box: ReturnType<typeof buildTestBox>, ws: string, name: string) {
  const src = path.join(ws, '..', name)
  await fsp.writeFile(src, PNG_1PX)
  const result = await box.files.importFiles({
    source_paths: [src],
    target_product_set: '系列A',
    target_folder: '主图',
    target_type: 'image',
    sub_folder: '主图',
  })
  return result.imported[0]
}

describe('回收站（v2.3.1）', () => {
  it('删除文件 → 进回收站：原文件消失、条目可见、元数据保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'a.jpg')
    await box.metadata.update({ file_path: file.path, tags: ['重点'], notes: 'n' })

    await box.files.fileDelete([file.path])

    // 原文件已移走
    await expect(fsp.stat(file.path)).rejects.toThrow()
    // 回收站有 1 条
    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('file')
    expect(entries[0].originalPath).toBe(file.path)
    // 元数据保留（恢复后可还原）
    const meta = await box.metadata.get(file.path)
    expect(meta.tags).toEqual(['重点'])
    expect(meta.notes).toBe('n')
  })

  it('恢复文件 → 回原路径，元数据与标签原样', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'b.jpg')
    await box.metadata.update({ file_path: file.path, tags: ['重点'] })

    await box.files.fileDelete([file.path])
    const entries = await box.trash.list()

    await box.trash.restore(entries[0].id)

    // 文件回原位
    await expect(fsp.stat(file.path)).resolves.toBeTruthy()
    // 回收站清空
    expect(await box.trash.list()).toHaveLength(0)
    // 元数据完好
    const meta = await box.metadata.get(file.path)
    expect(meta.tags).toEqual(['重点'])
  })

  it('恢复冲突 → 自动加「-恢复N」后缀', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'c.jpg')
    await box.files.fileDelete([file.path])
    // 原位置放一个同名文件 → 恢复时冲突
    await fsp.writeFile(file.path, PNG_1PX)

    const entries = await box.trash.list()
    await box.trash.restore(entries[0].id)

    const dir = path.dirname(file.path)
    const files = await fsp.readdir(dir)
    expect(files).toContain(file.name)
    expect(files.some((f) => f.includes('-恢复1'))).toBe(true)
  })

  it('彻底删除文件 → 元数据清理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'd.jpg')
    await box.metadata.update({ file_path: file.path, tags: ['重点'] })
    await box.files.fileDelete([file.path])

    const entries = await box.trash.list()
    await box.trash.purge(entries[0].id)

    expect(await box.trash.list()).toHaveLength(0)
    // 元数据已清理（get 对不存在 key 返回空对象，直接查 store）
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).not.toContain(`系列A/图包/主图/${file.name}`)
  })

  it('删除/恢复子文件夹：**模板表全程不受影响**，恢复后由盘决定可见', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    await box.files.createSubfolder({ product_set: '系列A', file_type: 'image', name: '场景图' })
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.image_subfolders).not.toContain('场景图')  // A9 刀2b：新建只落本集，**不写**全站模板表（要改默认集去「设置 → 子文件夹」）

    // A9 刀2b：新建不再自动进模板 ⇒ 这里**显式**把名字登记进模板表，
    // 才能真的测出"删除/恢复都不动它"（否则前提消失，断言会在空集上自证）
    {
      const cfg0 = await box.workspace.loadConfig(ws)
      cfg0.image_subfolders = [...(cfg0.image_subfolders ?? []), '场景图']
      await box.workspace.saveConfig(ws, cfg0)
    }
    await box.files.deleteSubfolder({ product_set: '系列A', file_type: 'image', name: '场景图' })
    const cfg2 = await box.workspace.loadConfig(ws)
    expect(cfg2.image_subfolders).toContain('场景图') // A9 刀2a：删除只作用于本实体，**不动全站模板表**（旧断言钉的正是用户报的「删一个动全身」）
    // 目录已移走
    const dir = path.join(ws, '产品集', '系列A', '图包', '场景图')
    await expect(fsp.stat(dir)).rejects.toThrow()

    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('subfolder')

    await box.trash.restore(entries[0].id)
    await expect(fsp.stat(dir)).resolves.toBeTruthy()
    const cfg3 = await box.workspace.loadConfig(ws)
    expect(cfg3.image_subfolders).toContain('场景图')
    // A9 刀2a：恢复不写表 ⇒ 这里"仍在表里"是**没被删掉**的结果，不是"被加回来"的结果；
    // 真正的替代保证是盘上回来了就能看见：
    const subs = await box.files.listSubfolders({ product_set: '系列A', file_type: 'image' })
    expect(subs.map((x) => x.name)).toContain('场景图')
  })

  it('删除/恢复产品集：目录移走即消失，恢复后 tags/notes 保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A', tags: ['重点'], notes: '备注' })

    await box.deleteProductSet('系列A')
    let list = await box.workspace.productSetList()
    expect(list.map((p) => p.name)).not.toContain('系列A')

    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('productSet')

    await box.trash.restore(entries[0].id)
    list = await box.workspace.productSetList()
    const restored = list.find((p) => p.name === '系列A')
    expect(restored).toBeTruthy()
    expect(restored?.tags).toEqual(['重点'])
    expect(restored?.notes).toBe('备注')
  })

  it('清空回收站：全部彻底删除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const file = await importOne(box, ws, 'e.jpg')
    await box.files.fileDelete([file.path])
    await box.trash.empty()

    expect(await box.trash.list()).toHaveLength(0)
    // 回收站目录内无条目残留
    const trashRoot = path.join(ws, '.qihefilemanager', 'trash')
    const left = await fsp.readdir(trashRoot).catch(() => [])
    expect(left).toHaveLength(0)
  })

  it('cleanupExpired：超期条目被清理（含元数据），近期条目保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    // 导入两个文件并删除 → 两条回收站条目（先删 im1 后删 im2）
    const im1 = await importOne(box, ws, 'exp1.jpg')
    await box.metadata.update({ file_path: im1.path, tags: ['超期'] })
    await box.files.fileDelete([im1.path])
    const im2 = await importOne(box, ws, 'exp2.jpg')
    await box.files.fileDelete([im2.path])

    const entries = await box.trash.list()
    expect(entries).toHaveLength(2)
    // entries[0] 是最新删除的（im2）；把它的 deletedAt 改到 40 天前 → 超期
    const metaPath = path.join(ws, '.qihefilemanager', 'trash', entries[0].id, 'meta.json')
    const m = JSON.parse(await fsp.readFile(metaPath, 'utf-8'))
    m.deletedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await fsp.writeFile(metaPath, JSON.stringify(m, null, 2))

    // 2.6.1/B16：无参调用 = 生产接线形状（src/main/index.ts 启动任务），默认窗口即用户可见的保留期
    const removed = await box.trash.cleanupExpired()
    expect(removed).toBe(1)

    // 剩余 1 条是近期的
    const left = await box.trash.list()
    expect(left).toHaveLength(1)
    expect(new Date(left[0].deletedAt).getTime()).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000)

    // 被清理条目的元数据同步删除，近期条目元数据保留
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).not.toContain(`系列A/图包/主图/${im2.name}`)
    expect(Object.keys(store.files)).toContain(`系列A/图包/主图/${im1.name}`)
  })
})

/**
 * 2.6.1/B16 · M1 接线钉（数据丢失类）：回收站保留期的用户可见承诺 =「30 天内可恢复」。
 *
 * 旧判据的洞（2026-09-25 变异实测）：`cleanupExpired(30)` 自己显式传 30 去调纯函数 ⇒
 * 把生产默认值改成 3、或把启动接线改成 `cleanupExpired(7)`，全量单测照绿，
 * 用户资料却会静默不可逆地少活 23 天。本组三条把洞堵上：
 *  ① 行为面：无参调用（生产接线形状）时，5 天前条目必须活、40 天前条目才清 ⇒ 默认值受钉；
 *  ② 同源面：core 默认值 = 渲染层镜像常量 = 界面/README 文案 ⇒ 改一边不同步必红；
 *  ③ 接线面：src/main/index.ts 启动任务必须以不带数字字面量的形状调用 ⇒ 改成 cleanupExpired(7) 必红。
 */
describe('回收站保留期接线钉（2.6.1/B16）', () => {
  /** 把回收站条目 meta.json 的 deletedAt 改到 daysAgo 天前 */
  async function backdate(ws: string, id: string, daysAgo: number): Promise<void> {
    const metaPath = path.join(ws, '.qihefilemanager', 'trash', id, 'meta.json')
    const m = JSON.parse(await fsp.readFile(metaPath, 'utf-8'))
    m.deletedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
    await fsp.writeFile(metaPath, JSON.stringify(m, null, 2))
  }

  it('无参 cleanupExpired()（生产接线形状）：5 天前条目必须保留，40 天前条目才清理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const recent = await importOne(box, ws, 'keep5.jpg')
    const old = await importOne(box, ws, 'gone40.jpg')
    await box.files.fileDelete([recent.path])
    await box.files.fileDelete([old.path])

    const entries = await box.trash.list()
    const idOf = (name: string) => entries.find((e) => e.name === name)!.id
    await backdate(ws, idOf(recent.name), 5)
    await backdate(ws, idOf(old.name), 40)

    // ★ 生产接线形状：与 src/main/index.ts 的 `box.trash.cleanupExpired()` 一致，不传覆盖参数
    const removed = await box.trash.cleanupExpired()
    expect(removed, '默认保留期被改小：5 天前条目本不该清（用户资料被提前不可逆删除）').toBe(1)
    expect((await box.trash.list()).map((e) => e.name)).toEqual([recent.name])
  })

  it('同源钉：core 默认值 = 渲染层镜像常量 = 界面上屏与 README 文案（禁双源漂移）', () => {
    expect(TRASH_RETENTION_DAYS).toBe(TRASH_RETENTION_DAYS_UI)

    // 界面：空态与行内剩余天数都从镜像常量取口径，不许硬编码数字
    const trashSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/renderer/src/pages/Trash.tsx'), 'utf-8')
    expect(trashSrc, '空态保留期必须引用常量而不是写死数字').toContain('TRASH_RETENTION_DAYS')
    expect(trashSrc, '行内剩余天数必须走 trashDaysLeftLabel（唯一出口）').toContain('trashDaysLeftLabel')

    // README 三处承诺与同一常量同源
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8')
    expect(readme).toContain(`${TRASH_RETENTION_DAYS} 天内可恢复`)
    expect(readme).toContain('自动清理') // 不能只写「可恢复」而把到期静默清理藏掉
  })

  it('trashDaysLeft：按删除时间 + 保留期算剩余天数，到 0 = core 认定过期（同一把尺子）', () => {
    const now = Date.now()
    const ago = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
    expect(trashDaysLeft(ago(0), now)).toBe(TRASH_RETENTION_DAYS) // 刚删除
    expect(trashDaysLeft(ago(25), now)).toBe(5)
    expect(trashDaysLeft(ago(29.5), now)).toBe(1) // 不足 1 天按 1 天提示（下一次启动才清理）
    expect(trashDaysLeft(ago(30), now)).toBe(0) // 满 30 天 = core 的过期点
    expect(trashDaysLeft(ago(45), now)).toBe(0)
    expect(trashDaysLeft('不是时间', now)).toBe(0) // 解析失败不虚报天数
    expect(trashDaysLeftLabel(ago(25), now)).toBe('剩余 5 天可恢复')
    expect(trashDaysLeftLabel(ago(30), now)).toBe('已到期，重启后自动清理')
  })

  it('启动接线钉：src/main/index.ts 以不带数字字面量的形状调用 cleanupExpired（源包含断言）', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8')
    const calls = [...src.matchAll(/cleanupExpired\(([^)]*)\)/g)]
    expect(calls.length, '启动接线整条消失（回收站过期条目将永不清理）').toBeGreaterThan(0)
    for (const c of calls) {
      // 数字字面量 = 用户可见保留期的第二份真相：改成 cleanupExpired(7) 在这里必红
      expect(c[1].trim(), '接线参数出现数字字面量：保留期必须走 TRASH_RETENTION_DAYS 单一权威').not.toMatch(/\d/)
    }
  })
})
