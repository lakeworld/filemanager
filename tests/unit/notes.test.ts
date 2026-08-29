/**
 * notes 单测（v2.5.7 A2）：listRecentNotes 三域聚合 / mtime 倒序 / limit / 无目录容错 / entity 过滤。
 * 「文档即笔记」——笔记 = 文件区内建「笔记」子文件夹里的 .md；纯 fs 只读聚合。
 */
import { describe, it, expect } from 'vitest'
import { listRecentNotes } from '../../src/main/core/notes'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-notes-'))
}

async function writeNote(ws: string, rel: string, content = '# 标题'): Promise<void> {
  const p = path.join(ws, ...rel.split('/'))
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await fsp.writeFile(p, content)
  // 让 mtime 差异可分辨（不同笔记拉开毫秒差）
  await new Promise((r) => setTimeout(r, 5))
}

describe('notes.listRecentNotes（v2.5.7 A2 笔记聚合）', () => {
  it('三域聚合：产品集文档区/客户/供应商各扫 笔记/ 下的 .md，mtime 倒序', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await writeNote(ws, '产品集/系列A/文档/笔记/旧想法.md')
    await writeNote(ws, '产品集/系列A/文档/笔记/新想法.md')
    await writeNote(ws, '客户/张三/笔记/拜访纪要.md')
    await writeNote(ws, '供应商/李四/笔记/采购备忘.md')

    const notes = await listRecentNotes(ws)
    expect(notes).toHaveLength(4)
    // mtime 倒序（最后写入的是供应商）
    expect(notes[0].entity).toBe('李四')
    expect(notes[0].kind).toBe('supplier')
    expect(notes[0].title).toBe('采购备忘')
    // relPath 是工作区相对路径（/ 分隔）
    expect(notes.some((n) => n.relPath === '产品集/系列A/文档/笔记/旧想法.md')).toBe(true)
    expect(notes.some((n) => n.relPath === '客户/张三/笔记/拜访纪要.md')).toBe(true)
  })

  it('.md 断言（大小写）+ 非 md 排除（.markdown 不是笔记——契约只认 .md）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await writeNote(ws, '产品集/系列A/文档/笔记/正文.markdown')
    await writeNote(ws, '产品集/系列A/文档/笔记/说明.MD')
    await writeNote(ws, '产品集/系列A/文档/笔记/图片.png')
    const notes = await listRecentNotes(ws)
    const titles = notes.map((n) => n.title)
    expect(titles).toContain('说明') // .MD 大写被接受
    expect(titles).not.toContain('正文.markdown')
    expect(titles).not.toContain('图片')
  })

  it('无目录容错：产品集/客户/供应商目录或笔记子目录缺失 → 空列表不炸', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    expect(await listRecentNotes(ws)).toEqual([])
  })

  it('limit 截断（ceiling 不越界）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    for (let i = 0; i < 5; i++) {
      await writeNote(ws, `客户/客${i}/笔记/记录${i}.md`)
    }
    expect(await listRecentNotes(ws, undefined, 2)).toHaveLength(2)
    expect(await listRecentNotes(ws, undefined, 100)).toHaveLength(5)
  })

  it('entity 过滤：单实体（整包勾选检测语义）+ 隐藏文件/系统目录排除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await writeNote(ws, '产品集/系列A/文档/笔记/想法.md')
    await writeNote(ws, '客户/张三/笔记/纪要.md')
    await writeNote(ws, '客户/张三/笔记/.隐藏.md') // 隐藏文件排除
    const ps = await listRecentNotes(ws, { kind: 'product_set', name: '系列A' })
    expect(ps).toHaveLength(1)
    expect(ps[0].relPath).toBe('产品集/系列A/文档/笔记/想法.md')
    const c = await listRecentNotes(ws, { kind: 'customer', name: '张三' })
    expect(c).toHaveLength(1) // .隐藏.md 被排除
    expect(c[0].relPath).toBe('客户/张三/笔记/纪要.md')
    // 不存在的实体 → 空
    expect(await listRecentNotes(ws, { kind: 'customer', name: '无此人' })).toEqual([])
  })
})
