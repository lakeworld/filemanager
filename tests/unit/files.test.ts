import { describe, it, expect, vi } from 'vitest'
import { buildTestBox, WorkspaceService } from './helpers'
import { ImportCancelledError, ThumbnailProvider } from '../../src/main/core/files'
import { BoxService } from '../../src/main/core'
import { batchRenameTargets } from '../../src/renderer/src/utils/batchRename'
import type { FileEntry } from '../../src/main/core/files'
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

/** 记录缩略图调用（验证移动时旧缩略图清理 + 图片新路径重生） */
class SpyThumbs implements ThumbnailProvider {
  ensured: string[] = []
  removed: string[] = []
  async ensureThumbnail(filePath: string): Promise<string> {
    this.ensured.push(filePath)
    return path.join('/thumbs', path.basename(filePath) + '.jpg')
  }
  async thumbnailUrl(): Promise<string> {
    return ''
  }
  async removeThumbnail(filePath: string): Promise<void> {
    this.removed.push(filePath)
  }
  async removeThumbnailsInDir(): Promise<void> {}
}

/** 组装带缩略图调用记录的 BoxService（moveFiles 缩略图断言用） */
function buildMoveBox(home: string): { box: BoxService; thumbs: SpyThumbs } {
  const workspace = new WorkspaceService(home)
  const thumbs = new SpyThumbs()
  return { box: new BoxService(thumbs, workspace), thumbs }
}

describe('文件移动（moveFiles）', () => {
  /** 导入一张 1x1 PNG 到指定产品集/子文件夹，返回 FileEntry */
  async function importInto(
    box: BoxService,
    ws: string,
    productSet: string,
    subFolder: string,
    srcName: string,
  ): Promise<{ entry: Awaited<ReturnType<BoxService['files']['importFiles']>>[number]; src: string }> {
    const src = path.join(ws, '..', srcName)
    await fsp.writeFile(src, PNG_1PX)
    const imported = await box.files.importFiles({
      source_paths: [src],
      target_product_set: productSet,
      target_folder: subFolder,
      target_type: 'image',
      sub_folder: subFolder,
    })
    return { entry: imported[0], src }
  }

  it('同产品集不同子文件夹移动：元数据（tags/notes）保持、缩略图重生', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { box, thumbs } = buildMoveBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'M系列' })

    const { entry } = await importInto(box, ws, 'M系列', '主图', 'mv.jpg')
    await box.metadata.update({ product_set: 'M系列', file_name: entry.name, tags: ['爆款'], notes: 'n' })

    const targetDir = path.join(ws, '产品集', 'M系列', '图包', '详情页')
    const moved = await box.files.moveFiles({ paths: [entry.path], targetDir })

    expect(moved).toHaveLength(1)
    expect(moved[0].path).toBe(path.join(targetDir, entry.name))
    expect(moved[0].file_type).toBe('image')
    // 旧位置不存在、新位置存在
    await expect(fsp.stat(entry.path)).rejects.toThrow()
    await expect(fsp.stat(moved[0].path)).resolves.toBeTruthy()
    // 元数据保持（同产品集 key 不变）
    const meta = await box.metadata.get('M系列', moved[0].name)
    expect(meta.tags).toEqual(['爆款'])
    expect(meta.notes).toBe('n')
    // 缩略图：旧路径清理 + 图片新路径重生
    expect(thumbs.removed).toContain(entry.path)
    expect(thumbs.ensured).toContain(moved[0].path)
    expect(moved[0].thumbnail_path).toBeTruthy()
  })

  it('跨产品集移动：元数据 key 迁移到新产品集名下', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列甲' })
    await box.workspace.productSetCreate({ name: '系列乙' })

    const { entry } = await importInto(box, ws, '系列甲', '主图', 'cross.jpg')
    await box.metadata.update({ product_set: '系列甲', file_name: entry.name, tags: ['T'], notes: 'cross' })

    const targetDir = path.join(ws, '产品集', '系列乙', '图包', '主图')
    await box.files.moveFiles({ paths: [entry.path], targetDir })

    // 新 key 有元数据，旧 key 已删除
    const meta = await box.metadata.get('系列乙', entry.name)
    expect(meta.tags).toEqual(['T'])
    expect(meta.notes).toBe('cross')
    const store = await box.metadata.loadMetadataStore()
    expect(store.files[path.join('系列乙', entry.name)]).toBeTruthy()
    expect(store.files[path.join('系列甲', entry.name)]).toBeUndefined()
  })

  it('目标目录同名冲突：自动加 _1 序号', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '冲突系列' })

    const { entry } = await importInto(box, ws, '冲突系列', '主图', 'c.png')
    // 目标目录预放一个同名文件
    const targetDir = path.join(ws, '产品集', '冲突系列', '图包', '详情页')
    await fsp.writeFile(path.join(targetDir, entry.name), PNG_1PX)

    const moved = await box.files.moveFiles({ paths: [entry.path], targetDir })
    expect(moved).toHaveLength(1)
    const base = path.basename(entry.name, path.extname(entry.name))
    expect(moved[0].name).toBe(`${base}_1${path.extname(entry.name)}`)
    // 源已移走，目标目录两个文件
    await expect(fsp.stat(entry.path)).rejects.toThrow()
    const files = await fsp.readdir(targetDir)
    expect(files).toContain(moved[0].name)
  })

  it('目标目录在工作区外：拒绝（源文件越界同样拒绝）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '外移系列' })

    const { entry } = await importInto(box, ws, '外移系列', '主图', 'out.jpg')
    const outside = await tmp()
    await expect(box.files.moveFiles({ paths: [entry.path], targetDir: outside })).rejects.toThrow(
      '只能移动到工作区内的目录',
    )
    // 目标在工作区内但源越界 → 拒绝且不产生任何文件
    const outsideSrc = path.join(os.tmpdir(), `qihebox-move-outside-${Date.now()}.jpg`)
    await fsp.writeFile(outsideSrc, PNG_1PX)
    await expect(
      box.files.moveFiles({ paths: [outsideSrc], targetDir: path.join(ws, '产品集', '外移系列', '图包', '详情页') }),
    ).rejects.toThrow('只能移动工作区内的文件')
  })

  it('跨设备回退：rename 抛 EXDEV 时走 copyFile + rm', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '跨设备' })

    const { entry } = await importInto(box, ws, '跨设备', '主图', 'dev.jpg')
    const targetDir = path.join(ws, '产品集', '跨设备', '图包', '详情页')

    const renameSpy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }))
    try {
      const moved = await box.files.moveFiles({ paths: [entry.path], targetDir })
      expect(moved).toHaveLength(1)
      // 源被删除、目标存在
      await expect(fsp.stat(entry.path)).rejects.toThrow()
      await expect(fsp.stat(moved[0].path)).resolves.toBeTruthy()
    } finally {
      renameSpy.mockRestore()
    }
  })
})

describe('导入目录（v2.3.3 P2：递归平铺导入）', () => {
  it('嵌套目录 + 隐藏文件 + 空目录 → 平铺导入全部非隐藏文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '目录导入' })

    // 源目录：两级嵌套 + 隐藏文件 + 隐藏目录 + 空目录
    const srcDir = await tmp()
    await fsp.mkdir(path.join(srcDir, 'sub', 'deep'), { recursive: true })
    await fsp.mkdir(path.join(srcDir, 'empty'), { recursive: true })
    await fsp.mkdir(path.join(srcDir, '.hidden-dir'), { recursive: true })
    await fsp.writeFile(path.join(srcDir, 'a.jpg'), PNG_1PX)
    await fsp.writeFile(path.join(srcDir, '.hidden.png'), PNG_1PX)
    await fsp.writeFile(path.join(srcDir, 'sub', 'b.png'), PNG_1PX)
    await fsp.writeFile(path.join(srcDir, 'sub', 'deep', 'c.jpg'), PNG_1PX)
    await fsp.writeFile(path.join(srcDir, 'sub', '.in-sub.png'), PNG_1PX)
    await fsp.writeFile(path.join(srcDir, '.hidden-dir', 'x.png'), PNG_1PX)

    const imported = await box.files.importFiles({
      source_paths: [srcDir],
      target_product_set: '目录导入',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    // 仅 3 个非隐藏文件被导入；隐藏文件 / 隐藏目录内文件 / 空目录全部跳过
    expect(imported).toHaveLength(3)
    const names = imported.map((f) => f.name).sort()
    expect(names).toEqual(['目录导入_主图_a.jpg', '目录导入_主图_b.png', '目录导入_主图_c.jpg'])
    // 全部平铺到目标子文件夹（不保留子目录结构）
    const destDir = path.join(ws, '产品集', '目录导入', '图包', '主图')
    expect((await fsp.readdir(destDir)).sort()).toEqual(
      ['目录导入_主图_a.jpg', '目录导入_主图_b.png', '目录导入_主图_c.jpg'],
    )
  })

  it('目录内仅隐藏文件/空目录 → 没有可导入的文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '空目录' })

    const srcDir = await tmp()
    await fsp.writeFile(path.join(srcDir, '.only-hidden.jpg'), PNG_1PX)
    await fsp.mkdir(path.join(srcDir, 'empty'), { recursive: true })

    await expect(
      box.files.importFiles({
        source_paths: [srcDir],
        target_product_set: '空目录',
        target_folder: '主图',
        target_type: 'image',
        sub_folder: '主图',
      }),
    ).rejects.toThrow('没有可导入的文件')
  })

  it('文件与目录混排：目录平铺后与文件统一导入，进度按展开后的文件数上报', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '混排' })

    const srcDir = await tmp()
    await fsp.writeFile(path.join(srcDir, 'd1.png'), PNG_1PX)
    await fsp.writeFile(path.join(srcDir, 'd2.jpg'), PNG_1PX)
    const file = path.join(ws, '..', 'single.jpg')
    await fsp.writeFile(file, PNG_1PX)

    const progress: Array<{ done: number; total: number }> = []
    const imported = await box.files.importFiles(
      {
        source_paths: [srcDir, file],
        target_product_set: '混排',
        target_folder: '主图',
        target_type: 'image',
        sub_folder: '主图',
      },
      { onProgress: (done, total) => progress.push({ done, total }) },
    )
    expect(imported).toHaveLength(3)
    expect(progress).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ])
  })
})

describe('批量重命名目标名生成（v2.3.3 P2：前端批处理，参照 resolveConflictName 加 _1 语义）', () => {
  /** 构造 FileEntry（name 即磁盘文件名，用于冲突判定） */
  function fe(name: string): FileEntry {
    return { name, path: `/ws/${name}`, size: 1, modified: '', file_type: 'image', thumbnail_path: null }
  }

  it('前缀 + 起始序号：序号补零位数按数量自适应', () => {
    const files = [fe('a.jpg'), fe('b.png'), fe('c.jpg')]
    // 3 个文件 → 最大序号 3，补零 1 位
    expect(batchRenameTargets(files, '夏季', 1)).toEqual(['夏季_1.jpg', '夏季_2.png', '夏季_3.jpg'])
  })

  it('起始序号跨 10 位：自动升级补零位数', () => {
    const files = [fe('a.jpg'), fe('b.jpg'), fe('c.jpg'), fe('d.jpg'), fe('e.jpg')]
    expect(batchRenameTargets(files, 'P', 97)).toEqual([
      'P_097.jpg',
      'P_098.jpg',
      'P_099.jpg',
      'P_100.jpg',
      'P_101.jpg',
    ])
  })

  it('自身原名命中目标名：不视为冲突', () => {
    const files = [fe('夏季_1.jpg'), fe('b.jpg')]
    // f1 目标名即自身原名 → 无需绕行；f2 正常
    expect(batchRenameTargets(files, '夏季', 1)).toEqual(['夏季_1.jpg', '夏季_2.jpg'])
  })

  it('目标名与磁盘已有文件冲突 → 追加 _1 递增', () => {
    const files = [fe('a.jpg'), fe('夏季_1.jpg')]
    // f1 目标 夏季_1.jpg 与 f2 原名冲突 → 夏季_1_1.jpg；f2 正常
    expect(batchRenameTargets(files, '夏季', 1)).toEqual(['夏季_1_1.jpg', '夏季_2.jpg'])
  })

  it('无扩展名文件：目标名不带扩展名', () => {
    const files = [fe('DSC_0001'), fe('x.png')]
    expect(batchRenameTargets(files, '图', 1)).toEqual(['图_1', '图_2.png'])
  })
})

describe('文件列表缓存（v2.4.x：fileList 命中 / 写操作失效 / 预热）', () => {
  it('fileList 二次调用命中缓存：目标目录只 readdir 一次', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '缓存系列' })

    const src = path.join(ws, '..', 'cached.jpg')
    await fsp.writeFile(src, PNG_1PX)
    await box.files.importFiles({
      source_paths: [src],
      target_product_set: '缓存系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })

    const dir = path.join(ws, '产品集', '缓存系列', '图包', '主图')
    const readdirSpy = vi.spyOn(fsp, 'readdir')
    let dirReads = 0
    try {
      const first = await box.files.fileList({ product_set: '缓存系列', file_type: 'image', sub_folder: '主图' })
      expect(first).toHaveLength(1)
      const second = await box.files.fileList({ product_set: '缓存系列', file_type: 'image', sub_folder: '主图' })
      expect(second).toHaveLength(1)
      dirReads = readdirSpy.mock.calls.filter((c) => path.resolve(String(c[0])) === path.resolve(dir)).length
    } finally {
      readdirSpy.mockRestore()
    }
    // 第二次 fileList 命中缓存，目标目录未被重复 readdir
    expect(dirReads).toBe(1)
  })

  it('导入后缓存失效：先 fileList 缓存空列表，导入后 fileList 可见新文件', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '失效系列' })

    // 预填充空目录缓存
    const req = { product_set: '失效系列', file_type: 'image', sub_folder: '主图' }
    expect(await box.files.fileList(req)).toEqual([])

    const src = path.join(ws, '..', 'fresh.jpg')
    await fsp.writeFile(src, PNG_1PX)
    await box.files.importFiles({
      source_paths: [src],
      target_product_set: '失效系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })

    // 导入已失效缓存 → 重建后可见新文件（若未失效会命中旧空缓存）
    const list = await box.files.fileList(req)
    expect(list).toHaveLength(1)
    expect(list[0].name).toMatch(/fresh\.jpg$/)
  })

  it('warmup 预填充缓存：预热后 fileList 命中，不再 readdir', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '预热系列' })

    const src = path.join(ws, '..', 'pre.jpg')
    await fsp.writeFile(src, PNG_1PX)
    await box.files.importFiles({
      source_paths: [src],
      target_product_set: '预热系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })

    // 预热全部子文件夹（默认 config：图包 4 个 + 证书 3 个）
    const warmed = await box.files.warmup()
    expect(warmed).toBe(7)

    const dir = path.join(ws, '产品集', '预热系列', '图包', '主图')
    const readdirSpy = vi.spyOn(fsp, 'readdir')
    let dirReads = 0
    try {
      const list = await box.files.fileList({ product_set: '预热系列', file_type: 'image', sub_folder: '主图' })
      expect(list).toHaveLength(1)
      dirReads = readdirSpy.mock.calls.filter((c) => path.resolve(String(c[0])) === path.resolve(dir)).length
    } finally {
      readdirSpy.mockRestore()
    }
    // 预热已填充缓存 → 本次 fileList 未 readdir
    expect(dirReads).toBe(0)
  })
})
