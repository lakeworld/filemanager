import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { isMarkdownName } from '../../src/main/core/paths'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-files-docs-'))
}

const TXT = Buffer.from('fake text bytes')

describe('产品集文档目录（v2.5.1 F1：文档/ 与图包/证书并列）', () => {
  it('fileList(scope=doc)：目录不存在时懒补建并返回空（不抛错）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const list = await box.files.fileList({ product_set: '系列A', file_type: 'doc', sub_folder: '说明书' })
    expect(list).toEqual([])
    // 懒补建：目录真实落盘
    await expect(fsp.stat(path.join(ws, '产品集', '系列A', '文档', '说明书'))).resolves.toBeTruthy()
  })

  it('fileList(scope=doc)：列出文档目录内文件（md/txt/pdf 混放，全列出）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const dir = path.join(ws, '产品集', '系列A', '文档', '说明书')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, '使用说明.md'), TXT)
    await fsp.writeFile(path.join(dir, '规格表.xlsx'), TXT)
    await fsp.writeFile(path.join(dir, '检测报告.pdf'), TXT)

    const list = await box.files.fileList({ product_set: '系列A', file_type: 'doc', sub_folder: '说明书' })
    expect(list.map((f) => f.name).sort()).toEqual(['使用说明.md', '检测报告.pdf', '规格表.xlsx'])
    // md 文件类型分类保持 'other'（渲染层按扩展名判断，D21）
    expect(list.find((f) => f.name === '使用说明.md')?.file_type).toBe('other')
  })

  it('createSubfolder(file_type=doc)：建 文档/<名> 并写入 config.doc_subfolders', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    await box.files.createSubfolder({ product_set: '系列A', file_type: 'doc', name: '安装手册' })
    await expect(fsp.stat(path.join(ws, '产品集', '系列A', '文档', '安装手册'))).resolves.toBeTruthy()
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.doc_subfolders).toContain('安装手册')
  })

  it('deleteSubfolder(file_type=doc)：移入回收站并从 config.doc_subfolders 移除', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    await box.files.createSubfolder({ product_set: '系列A', file_type: 'doc', name: '安装手册' })
    await box.files.deleteSubfolder({ product_set: '系列A', file_type: 'doc', name: '安装手册' })
    // 目录已移入回收站（产品集下不再存在）
    await expect(fsp.stat(path.join(ws, '产品集', '系列A', '文档', '安装手册'))).rejects.toBeTruthy()
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.doc_subfolders).not.toContain('安装手册')
  })

  it('importFiles(target_type=doc)：落盘 产品集/<名>/文档/<子文件夹>/', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const src = path.join(ws, '..', 'src-manual.md')
    await fsp.writeFile(src, TXT)

    const result = await box.files.importFiles({
      source_paths: [src],
      target_product_set: '系列A',
      target_folder: '说明书',
      target_type: 'doc',
      sub_folder: '说明书',
    })
    expect(result.imported).toHaveLength(1)
    expect(result.failed).toHaveLength(0)
    const dest = path.join(ws, '产品集', '系列A', '文档', '说明书', result.imported[0].name)
    await expect(fsp.stat(dest)).resolves.toBeTruthy()
  })
})

describe('isMarkdownName（v2.5.1 F1：MD 扩展名判定，渲染层预览分流用）', () => {
  it('识别 .md / .markdown（含大写），拒绝其他扩展名与无扩展名', () => {
    expect(isMarkdownName('说明.md')).toBe(true)
    expect(isMarkdownName('说明.MD')).toBe(true)
    expect(isMarkdownName('readme.markdown')).toBe(true)
    expect(isMarkdownName('README.MARKDOWN')).toBe(true)
    expect(isMarkdownName('规格表.xlsx')).toBe(false)
    expect(isMarkdownName('说明.txt')).toBe(false)
    expect(isMarkdownName('README')).toBe(false)
    expect(isMarkdownName('.md')).toBe(false) // 隐藏文件（点开头）不算文档
  })
})
