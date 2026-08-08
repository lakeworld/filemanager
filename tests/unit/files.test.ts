import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { ImportCancelledError } from '../../src/main/core/files'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-files-'))
}

/** 最小 1x1 PNG（真实字节，导入时当图片处理） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('文件导入与命名（对照原 files.go / app_test.go 链路）', () => {
  it('拖拽导入 → 命名模板 → 元数据记录', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '夏季T恤系列' })

    // 源文件
    const src = path.join(ws, '..', 'src-banner.jpg')
    await fsp.writeFile(src, PNG_1PX)

    const imported = await box.files.importFiles({
      source_paths: [src],
      target_product_set: '夏季T恤系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    expect(imported).toHaveLength(1)
    expect(imported[0].name).toBe('夏季T恤系列_主图_src-banner.jpg')
    expect(imported[0].file_type).toBe('image')

    // 文件真实落盘
    const dest = path.join(ws, '产品集', '夏季T恤系列', '图包', '主图', imported[0].name)
    await expect(fsp.stat(dest)).resolves.toBeTruthy()

    // 元数据记录了 added_at
    const meta = await box.metadata.get('夏季T恤系列', imported[0].name)
    expect(meta.added_at).toBeTruthy()

    // FileList 可见
    const list = await box.files.fileList({
      product_set: '夏季T恤系列',
      file_type: 'image',
      sub_folder: '主图',
    })
    expect(list).toHaveLength(1)
  })

  it('同名文件冲突自动加 _1 序号', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const src1 = path.join(ws, '..', 'img.png')
    const src2 = path.join(ws, '..', 'img2.png')
    await fsp.writeFile(src1, PNG_1PX)
    await fsp.writeFile(src2, PNG_1PX)

    const req = {
      source_paths: [src1, src2],
      target_product_set: '系列A',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    }
    const first = await box.files.importFiles(req)
    const second = await box.files.importFiles(req)
    const names = [...first, ...second].map((f) => f.name)
    // 首次：img.png、img2.png；二次：img_1.png、img2_1.png
    expect(names[0]).toMatch(/系列A_主图_img\.png$/)
    expect(names[1]).toMatch(/系列A_主图_img2\.png$/)
    expect(names[2]).toMatch(/系列A_主图_img_1\.png$/)
    expect(names[3]).toMatch(/系列A_主图_img2_1\.png$/)
  })

  it('file:// 前缀路径兼容', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '兼容' })

    const src = path.join(ws, '..', 'x.pdf')
    await fsp.writeFile(src, '%PDF-1.4 test')

    const imported = await box.files.importFiles({
      source_paths: [`file://${src}`],
      target_product_set: '兼容',
      target_folder: '3C',
      target_type: 'cert',
      sub_folder: '3C',
    })
    expect(imported[0].file_type).toBe('pdf')
  })

  it('v2.3.0：导入进度回调（done/total 逐项递增）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '进度' })

    const srcs: string[] = []
    for (let i = 0; i < 3; i++) {
      const s = path.join(ws, '..', `p-${i}.jpg`)
      await fsp.writeFile(s, PNG_1PX)
      srcs.push(s)
    }

    const progress: Array<{ done: number; total: number }> = []
    await box.files.importFiles(
      {
        source_paths: srcs,
        target_product_set: '进度',
        target_folder: '主图',
        target_type: 'image',
        sub_folder: '主图',
      },
      { onProgress: (done, total) => progress.push({ done, total }) },
    )
    expect(progress).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ])
  })

  it('v2.3.0：导入取消 → 抛 ImportCancelledError 且已导入部分保留', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '取消' })

    const srcs: string[] = []
    for (let i = 0; i < 4; i++) {
      const s = path.join(ws, '..', `c-${i}.jpg`)
      await fsp.writeFile(s, PNG_1PX)
      srcs.push(s)
    }

    let count = 0
    await expect(
      box.files.importFiles(
        {
          source_paths: srcs,
          target_product_set: '取消',
          target_folder: '主图',
          target_type: 'image',
          sub_folder: '主图',
        },
        {
          onProgress: () => {
            count++
          },
          // 第 3 个文件复制完成后置位取消
          isCancelled: () => count >= 2,
        },
      ),
    ).rejects.toBeInstanceOf(ImportCancelledError)

    // 已导入 2 个文件真实落盘
    const destDir = path.join(ws, '产品集', '取消', '图包', '主图')
    const files = await fsp.readdir(destDir)
    expect(files).toHaveLength(2)
  })
})

describe('文件删除 / 重命名 / 越界防护', () => {
  it('越界删除被拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const outside = path.join(os.tmpdir(), `qihebox-outside-${Date.now()}.jpg`)
    await fsp.writeFile(outside, 'x')
    await expect(box.files.fileDelete([outside])).rejects.toThrow('只能删除工作区内的文件')
  })

  it('重命名迁移元数据', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'R系列' })

    const src = path.join(ws, '..', 'old.jpg')
    await fsp.writeFile(src, PNG_1PX)
    const imported = await box.files.importFiles({
      source_paths: [src],
      target_product_set: 'R系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    await box.metadata.update({ product_set: 'R系列', file_name: imported[0].name, cert_type: '3C', notes: 'n' })

    await box.files.renameFile({ path: imported[0].path, newName: 'newname.jpg' })

    // 元数据迁移到新名
    const meta = await box.metadata.get('R系列', 'newname.jpg')
    expect(meta.cert_type).toBe('3C')
    // 旧 key 删除
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).toContain(path.join('R系列', 'newname.jpg'))
  })
})
