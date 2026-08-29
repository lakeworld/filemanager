import { describe, it, expect, vi } from 'vitest'
import { buildTestBox, FakeThumbs, WorkspaceService } from './helpers'
import { ImportCancelledError, ThumbnailProvider, FilesService } from '../../src/main/core/files'
import { BoxService } from '../../src/main/core'
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

    const result = await box.files.importFiles({
      source_paths: [src],
      target_product_set: '夏季T恤系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    expect(result.imported).toHaveLength(1)
    expect(result.failed).toHaveLength(0)
    // v2.4.9 S5：默认模板含 sequence 槽位——单文件批次 total=1 → 编号 '1'
    expect(result.imported[0].name).toBe('夏季T恤系列_主图_src-banner_1.jpg')
    expect(result.imported[0].file_type).toBe('image')

    // 文件真实落盘
    const dest = path.join(ws, '产品集', '夏季T恤系列', '图包', '主图', result.imported[0].name)
    await expect(fsp.stat(dest)).resolves.toBeTruthy()

    // 元数据记录了 added_at（按路径推导 key）
    const meta = await box.metadata.get(result.imported[0].path)
    expect(meta.added_at).toBeTruthy()

    // FileList 可见
    const list = await box.files.fileList({
      product_set: '夏季T恤系列',
      file_type: 'image',
      sub_folder: '主图',
    })
    expect(list).toHaveLength(1)
  })

  it('media_type 过滤：图包目录下图片/视频视图分离，不过滤则全部列出（v2.4.4 验收修复）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    const dir = path.join(ws, '产品集', '系列A', '图包', '主图')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'a.jpg'), PNG_1PX)
    await fsp.writeFile(path.join(dir, 'b.mp4'), Buffer.from('fake-mp4-bytes'))

    const base = { product_set: '系列A', sub_folder: '主图' }
    // FileBrowser 语义：不传 media_type → 目录内全部列出
    const all = await box.files.fileList({ ...base, file_type: 'image' })
    expect(all.map((f) => f.name).sort()).toEqual(['a.jpg', 'b.mp4'])
    // 图包库「图片」视图：只含图片，不混入视频
    const images = await box.files.fileList({ ...base, file_type: 'image', media_type: 'image' })
    expect(images.map((f) => f.name)).toEqual(['a.jpg'])
    // 图包库「视频」视图：只含视频
    const videos = await box.files.fileList({ ...base, file_type: 'image', media_type: 'video' })
    expect(videos.map((f) => f.name)).toEqual(['b.mp4'])
    // file_type: 'video' 同样映射图包目录（不回落证书目录）
    const videos2 = await box.files.fileList({ ...base, file_type: 'video', media_type: 'video' })
    expect(videos2.map((f) => f.name)).toEqual(['b.mp4'])
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
    const first = (await box.files.importFiles(req)).imported
    const second = (await box.files.importFiles(req)).imported
    const names = [...first, ...second].map((f) => f.name)
    // v2.4.9 S5：批次编号——首次 2 文件 seq 1/2（img_1、img2_2）；二次同候选名冲突 → resolveConflictName 加 _1（img_1_1、img2_2_1）
    expect(names[0]).toMatch(/系列A_主图_img_1\.png$/)
    expect(names[1]).toMatch(/系列A_主图_img2_2\.png$/)
    expect(names[2]).toMatch(/系列A_主图_img_1_1\.png$/)
    expect(names[3]).toMatch(/系列A_主图_img2_2_1\.png$/)
  })

  it('v2.4.2（I1）：单文件失败不中断整批——坏源跳过，其余导入成功', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '容错系列' })

    const good = path.join(ws, '..', 'good.jpg')
    const missing = path.join(ws, '..', 'does-not-exist.jpg')
    await fsp.writeFile(good, PNG_1PX)

    const result = await box.files.importFiles({
      source_paths: [good, missing],
      target_product_set: '容错系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    expect(result.imported).toHaveLength(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].path).toBe(missing)
  })

  it('v2.4.2（D1）：无扩展名文件冲突加 _1 不丢原名（LICENSE → LICENSE_1_1）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '无扩展名' })

    const src = path.join(ws, '..', 'LICENSE')
    await fsp.writeFile(src, 'MIT')
    // v2.4.9 S5：默认模板含 sequence——单文件批次候选名 = 无扩展名_主图_LICENSE_1，
    // 预置同名文件触发冲突（无扩展名文件冲突后缀必须原样追加，不丢主名）
    const destDir = path.join(ws, '产品集', '无扩展名', '图包', '主图')
    await fsp.mkdir(destDir, { recursive: true })
    await fsp.writeFile(path.join(destDir, '无扩展名_主图_LICENSE_1'), 'MIT-OLD')

    const result = await box.files.importFiles({
      source_paths: [src],
      target_product_set: '无扩展名',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })
    // 旧实现 slice(0,-0) 会把文件名清空成 `_1`，这里必须保留原名；冲突再叠加 _1
    expect(result.imported[0].name).toBe('无扩展名_主图_LICENSE_1_1')
  })

  it('file:// 前缀路径兼容', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '兼容' })

    const src = path.join(ws, '..', 'x.pdf')
    await fsp.writeFile(src, '%PDF-1.4 test')

    const imported = (await box.files.importFiles({
      source_paths: [`file://${src}`],
      target_product_set: '兼容',
      target_folder: '3C',
      target_type: 'cert',
      sub_folder: '3C',
    })).imported
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
    // 已导入文件的元数据也已落盘（批量写兜底 finally）
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files).length).toBe(2)
  })
})

describe('文件删除 / 重命名 / 越界防护', () => {
  it('v2.4.2（D5）：越界删除聚合为失败明细，不抛错不误删', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const outside = path.join(os.tmpdir(), `qihebox-outside-${Date.now()}.jpg`)
    await fsp.writeFile(outside, 'x')
    const r = await box.files.fileDelete([outside])
    expect(r.deleted).toBe(0)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error).toContain('只能删除工作区内的文件')
  })

  it('重命名迁移元数据', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'R系列' })

    const src = path.join(ws, '..', 'old.jpg')
    await fsp.writeFile(src, PNG_1PX)
    const imported = (await box.files.importFiles({
      source_paths: [src],
      target_product_set: 'R系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })).imported
    await box.metadata.update({ file_path: imported[0].path, cert_type: '3C', notes: 'n' })

    await box.files.renameFile({ path: imported[0].path, newName: 'newname.jpg' })

    // 元数据迁移到新路径 key
    const newPath = path.join(path.dirname(imported[0].path), 'newname.jpg')
    const meta = await box.metadata.get(newPath)
    expect(meta.cert_type).toBe('3C')
    // 旧 key 删除
    const store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).toContain('R系列/图包/主图/newname.jpg')
    expect(Object.keys(store.files)).not.toContain('R系列/图包/主图/old.jpg')
  })

  it('v2.5.3（P1-3）：rename 元数据迁移挂起期间并发的 metadata.update 不丢（两写都落盘）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '并发R' })

    const src = path.join(ws, '..', 'gate-old.jpg')
    await fsp.writeFile(src, PNG_1PX)
    const imported = (await box.files.importFiles({
      source_paths: [src],
      target_product_set: '并发R',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })).imported
    const oldPath = imported[0].path
    await box.metadata.update({ file_path: oldPath, tags: ['旧'], notes: '迁移前' })
    // 另一路并发 update 的目标文件（与迁移文件不同 key）
    const other = path.join(ws, '产品集', '并发R', '图包', '主图', 'other.jpg')
    await fsp.writeFile(other, PNG_1PX)
    await box.metadata.update({ file_path: other, notes: '并发前' })

    // 门闩：renameFile 的第一次 mutateStore（迁移）挂起在锁外，让另一路 update 先行完成，
    // 再放行迁移——模拟「迁移读旧快照期间并发写」的丢失更新场景。
    let entered!: () => void
    const enteredP = new Promise<void>((r) => (entered = r))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    const origMutateStore = box.metadata.mutateStore.bind(box.metadata)
    const spy = vi.spyOn(box.metadata, 'mutateStore').mockImplementation(async (wsArg, mutate) => {
      calls++
      if (calls === 1) {
        entered()
        await gate
      }
      return origMutateStore(wsArg, mutate)
    })

    try {
      const renameP = box.files.renameFile({ path: oldPath, newName: 'renamed.jpg' })
      await enteredP
      // 迁移挂起期间，另一路 update 不同文件先行完成
      await box.metadata.update({ file_path: other, notes: '并发后' })
      release()
      await renameP

      const store = await box.metadata.loadMetadataStore()
      // 迁移落盘：新 key 有数据、旧 key 已删除
      const newPath = path.join(path.dirname(oldPath), 'renamed.jpg')
      expect(store.files[box.metadata.fileMetadataKey(newPath)]?.notes).toBe('迁移前')
      expect(store.files[box.metadata.fileMetadataKey(oldPath)]).toBeUndefined()
      // 并发 update 的写入未被迁移动作抹掉（整档替换的丢失更新窗口已消除）
      expect(store.files[box.metadata.fileMetadataKey(other)]?.notes).toBe('并发后')
    } finally {
      spy.mockRestore()
    }
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
  async removeThumbnails(files: string[]): Promise<void> {
    this.removed.push(...files)
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
  ): Promise<{ entry: FileEntry; src: string }> {
    const src = path.join(ws, '..', srcName)
    await fsp.writeFile(src, PNG_1PX)
    const imported = (await box.files.importFiles({
      source_paths: [src],
      target_product_set: productSet,
      target_folder: subFolder,
      target_type: 'image',
      sub_folder: subFolder,
    })).imported
    return { entry: imported[0], src }
  }

  it('同产品集不同子文件夹移动：元数据（tags/notes）保持、缩略图重生', async () => {
    const home = await tmp()
    const ws = await tmp()
    const { box, thumbs } = buildMoveBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'M系列' })

    const { entry } = await importInto(box, ws, 'M系列', '主图', 'mv.jpg')
    await box.metadata.update({ file_path: entry.path, tags: ['爆款'], notes: 'n' })

    const targetDir = path.join(ws, '产品集', 'M系列', '图包', '详情页')
    const moved = await box.files.moveFiles({ paths: [entry.path], targetDir })

    expect(moved.moved).toHaveLength(1)
    expect(moved.failed).toHaveLength(0)
    expect(moved.moved[0].path).toBe(path.join(targetDir, entry.name))
    expect(moved.moved[0].file_type).toBe('image')
    // 旧位置不存在、新位置存在
    await expect(fsp.stat(entry.path)).rejects.toThrow()
    await expect(fsp.stat(moved.moved[0].path)).resolves.toBeTruthy()
    // 元数据保持（同产品集 key 不变，按新路径读取）
    const meta = await box.metadata.get(moved.moved[0].path)
    expect(meta.tags).toEqual(['爆款'])
    expect(meta.notes).toBe('n')
    // 缩略图：旧路径清理 + 图片新路径重生
    expect(thumbs.removed).toContain(entry.path)
    expect(thumbs.ensured).toContain(moved.moved[0].path)
    expect(moved.moved[0].thumbnail_path).toBeTruthy()
  })

  it('跨产品集移动：元数据 key 迁移到新产品集名下', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列甲' })
    await box.workspace.productSetCreate({ name: '系列乙' })

    const { entry } = await importInto(box, ws, '系列甲', '主图', 'cross.jpg')
    await box.metadata.update({ file_path: entry.path, tags: ['T'], notes: 'cross' })

    const targetDir = path.join(ws, '产品集', '系列乙', '图包', '主图')
    const moved = await box.files.moveFiles({ paths: [entry.path], targetDir })

    // 新 key 有元数据，旧 key 已删除
    const meta = await box.metadata.get(moved.moved[0].path)
    expect(meta.tags).toEqual(['T'])
    expect(meta.notes).toBe('cross')
    const store = await box.metadata.loadMetadataStore()
    expect(store.files[`系列乙/图包/主图/${entry.name}`]).toBeTruthy()
    expect(store.files[`系列甲/图包/主图/${entry.name}`]).toBeUndefined()
  })

  it('v2.5.3（P1-3）：move 元数据迁移与其他 metadata.update 并发不互丢（两写都落盘）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '并发甲' })
    await box.workspace.productSetCreate({ name: '并发乙' })

    const { entry } = await importInto(box, ws, '并发甲', '主图', 'cm.jpg')
    await box.metadata.update({ file_path: entry.path, notes: '迁移中' })
    // 另一路并发 update 的目标文件（工作区内、与迁移文件不同 key）
    const other = path.join(ws, '产品集', '并发甲', '图包', '主图', 'other.jpg')
    await fsp.writeFile(other, PNG_1PX)
    await box.metadata.update({ file_path: other, notes: '并发前' })

    const targetDir = path.join(ws, '产品集', '并发乙', '图包', '主图')
    await Promise.all([
      box.files.moveFiles({ paths: [entry.path], targetDir }),
      box.metadata.update({ file_path: other, notes: '并发后' }),
    ])

    const store = await box.metadata.loadMetadataStore()
    // 迁移落盘：新 key 有数据、旧 key 已删除
    expect(store.files[`并发乙/图包/主图/${entry.name}`]?.notes).toBe('迁移中')
    expect(store.files[`并发甲/图包/主图/${entry.name}`]).toBeUndefined()
    // 并发 update 的写入未被迁移整档替换抹掉
    expect(store.files['并发甲/图包/主图/other.jpg']?.notes).toBe('并发后')
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
    expect(moved.moved).toHaveLength(1)
    const base = path.basename(entry.name, path.extname(entry.name))
    expect(moved.moved[0].name).toBe(`${base}_1${path.extname(entry.name)}`)
    // 源已移走，目标目录两个文件
    await expect(fsp.stat(entry.path)).rejects.toThrow()
    const files = await fsp.readdir(targetDir)
    expect(files).toContain(moved.moved[0].name)
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
    // 目标在工作区内但源越界 → 聚合为失败明细，不产生任何文件
    const outsideSrc = path.join(os.tmpdir(), `qihebox-move-outside-${Date.now()}.jpg`)
    await fsp.writeFile(outsideSrc, PNG_1PX)
    const r = await box.files.moveFiles({
      paths: [outsideSrc],
      targetDir: path.join(ws, '产品集', '外移系列', '图包', '详情页'),
    })
    expect(r.moved).toHaveLength(0)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error).toContain('只能移动工作区内的文件')
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
      expect(moved.moved).toHaveLength(1)
      // 源被删除、目标存在
      await expect(fsp.stat(entry.path)).rejects.toThrow()
      await expect(fsp.stat(moved.moved[0].path)).resolves.toBeTruthy()
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

    const imported = (await box.files.importFiles({
      source_paths: [srcDir],
      target_product_set: '目录导入',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })).imported
    // 仅 3 个非隐藏文件被导入；隐藏文件 / 隐藏目录内文件 / 空目录全部跳过
    expect(imported).toHaveLength(3)
    // v2.4.9 S5：编号槽位随 readdir 展开顺序 1/2/3（readdir 顺序与文件系统相关 → 断言「基名各一 + 编号集合固定」，不绑定具体顺序）
    const names = imported.map((f) => f.name).sort()
    const pat = /^目录导入_主图_(a|b|c)_([123])\.(jpg|png)$/
    expect(names.every((n) => pat.test(n))).toBe(true)
    expect(new Set(names.map((n) => n.match(pat)![2]))).toEqual(new Set(['1', '2', '3']))
    // 全部平铺到目标子文件夹（不保留子目录结构），文件名同样带编号
    const destDir = path.join(ws, '产品集', '目录导入', '图包', '主图')
    const dest = (await fsp.readdir(destDir)).sort()
    expect(dest).toHaveLength(3)
    expect(dest.every((n) => pat.test(n))).toBe(true)
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
    const imported = (await box.files.importFiles(
      {
        source_paths: [srcDir, file],
        target_product_set: '混排',
        target_folder: '主图',
        target_type: 'image',
        sub_folder: '主图',
      },
      { onProgress: (done, total) => progress.push({ done, total }) },
    )).imported
    expect(imported).toHaveLength(3)
    expect(progress).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ])
  })
})

describe('文件索引（v2.4.x：fileList 命中 / 写操作失效 / 预热）', () => {
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

    // 导入已失效缓存 → 重建后可见新文件（若未失效会命中旧空缓存）；v2.4.9 S5：默认模板含编号 → fresh_1.jpg
    const list = await box.files.fileList(req)
    expect(list).toHaveLength(1)
    expect(list[0].name).toMatch(/fresh_1\.jpg$/)
  })

  it('fileList 二次查询命中索引：listRaw 只执行一次（零 readdir/stat）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '索引系列' })

    const src = path.join(ws, '..', 'idx.jpg')
    await fsp.writeFile(src, PNG_1PX)
    await box.files.importFiles({
      source_paths: [src],
      target_product_set: '索引系列',
      target_folder: '主图',
      target_type: 'image',
      sub_folder: '主图',
    })

    const spy = vi.spyOn(box.files, 'listRaw')
    const first = await box.files.fileList({ product_set: '索引系列', file_type: 'image', sub_folder: '主图' })
    expect(first).toHaveLength(1)
    const second = await box.files.fileList({ product_set: '索引系列', file_type: 'image', sub_folder: '主图' })
    expect(second).toHaveLength(1)
    // 首次查询重建（导入已失效索引），二次查询命中索引 → listRaw 仅一次
    expect(spy.mock.calls.length).toBe(1)
    spy.mockRestore()
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

    // 预热全部子文件夹（默认 config：图包 4 个 + 证书 3 个 + v2.5.1 文档 3 个）
    const warmed = await box.files.warmup()
    expect(warmed).toBe(10)

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

describe('v2.5（P1-B3）：symlink 越界目录 realpath 边界', () => {
  it('工作区内 symlink 指向区外的目录跳过不枚举；正常目录不受影响', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '越界链接' })

    // 外部目录放文件
    const outside = await tmp()
    await fsp.writeFile(path.join(outside, 'external.jpg'), PNG_1PX)

    // 主图 子文件夹 → 替换为指向区外的 symlink
    const linkDir = path.join(ws, '产品集', '越界链接', '图包', '主图')
    await fsp.rmdir(linkDir)
    await fsp.symlink(outside, linkDir, 'dir')

    // 区外目录被跳过，不枚举外部文件
    const list = await box.files.fileList({ product_set: '越界链接', file_type: 'image', sub_folder: '主图' })
    expect(list).toHaveLength(0)

    // 正常目录（详情页 为空目录）仍可正常枚举，不报错
    const ok = await box.files.fileList({ product_set: '越界链接', file_type: 'image', sub_folder: '详情页' })
    expect(ok).toHaveLength(0)
  })
})

describe('v2.5.3（P1-4）：listDirFilesRecursive resolveThumb', () => {
  /** 计数 thumbnailUrl 调用的假缩略图：验证 resolveThumb:false 跳过缩略图解析 */
  class CountingThumbs extends FakeThumbs {
    calls = 0
    async thumbnailUrl(): Promise<string> {
      this.calls++
      return `thumb-${this.calls}`
    }
  }

  it('resolveThumb:false 跳过 thumbnailUrl、thumbnail_path 置空串；默认行为不变', async () => {
    const home = await tmp()
    const ws = await tmp()
    const workspace = new WorkspaceService(home)
    const counting = new CountingThumbs()
    const box = new BoxService(counting, workspace)
    await workspace.create(ws)
    await workspace.productSetCreate({ name: '系列A' })

    const dir = path.join(ws, '产品集', '系列A', '图包', '主图')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'a.jpg'), PNG_1PX)
    await fsp.writeFile(path.join(dir, 'b.jpg'), PNG_1PX)

    // resolveThumb:false：完全不调用 thumbnailUrl，thumbnail_path 为空串（每文件 5 stat → 1 stat）
    let before = counting.calls
    const noThumb = await box.files.listDirFilesRecursive(dir, { resolveThumb: false })
    expect(noThumb).toHaveLength(2)
    expect(noThumb.every((f) => f.thumbnail_path === '')).toBe(true)
    expect(counting.calls - before).toBe(0)

    // 默认（不传 opts）：行为不变，仍逐文件解析缩略图（保既有调用方兼容）
    before = counting.calls
    const withThumb = await box.files.listDirFilesRecursive(dir)
    expect(withThumb).toHaveLength(2)
    expect(withThumb.every((f) => f.thumbnail_path !== '')).toBe(true)
    expect(counting.calls - before).toBe(2)
  })
})

// —— v2.5.7（A2 笔记）：内建「笔记」子文件夹全守卫面 + writeText 原子写 ——

describe('内建「笔记」子文件夹守卫（v2.5.7 A2）', () => {
  it('createSubfolder 内建名：幂等创建且不写 config（并集显示前提）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    // 创建内建「笔记」
    await box.files.createSubfolder({ name: '笔记', product_set: '系列A', file_type: 'doc' })
    const dir = path.join(ws, '产品集', '系列A', '文档', '笔记')
    expect(await fsp.stat(dir).then((s) => s.isDirectory())).toBe(true)
    // 幂等：重复创建不炸
    await box.files.createSubfolder({ name: '笔记', product_set: '系列A', file_type: 'doc' })
    // config 不写内建名（doc_subfolders 不含「笔记」）
    const cfg = JSON.parse(
      await fsp.readFile(path.join(ws, '.qihefilemanager', 'config.json'), 'utf-8'),
    )
    expect(cfg.doc_subfolders ?? []).not.toContain('笔记')
  })

  it('deleteSubfolder 内建名拒绝（不可删）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.files.createSubfolder({ name: '笔记', product_set: '系列A', file_type: 'doc' })
    await expect(
      box.files.deleteSubfolder({ name: '笔记', product_set: '系列A', file_type: 'doc' }),
    ).rejects.toThrow('不可删除')
    // 目录仍在
    expect(
      await fsp.stat(path.join(ws, '产品集', '系列A', '文档', '笔记')).then((s) => s.isDirectory()),
    ).toBe(true)
  })

  it('renameSubfolder 内建名拒绝（不可改）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.files.createSubfolder({ name: '笔记', product_set: '系列A', file_type: 'doc' })
    await expect(
      box.workspace.renameSubfolder('doc', '笔记', '改名笔记'),
    ).rejects.toThrow('不可重命名')
  })

  it('createSubfolder 普通名照常行为 + config 写入不受影响', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.files.createSubfolder({ name: '测试文档', product_set: '系列A', file_type: 'doc' })
    expect(
      await fsp.stat(path.join(ws, '产品集', '系列A', '文档', '测试文档')).then((s) => s.isDirectory()),
    ).toBe(true)
    // 普通名删除照常
    await box.files.deleteSubfolder({ name: '测试文档', product_set: '系列A', file_type: 'doc' })
    expect(
      await fsp.stat(path.join(ws, '产品集', '系列A', '文档', '测试文档')).then(() => true).catch(() => false),
    ).toBe(false)
  })
})

describe('writeText 原子写（v2.5.7 A2：tmp+rename + 2MB 上限）', () => {
  it('原子写入：内容落盘、无 .tmp 残留；目录自动 lazy mkdir', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const target = path.join(ws, '产品集', '系列A', '文档', '笔记', '测试.md')
    await box.workspace.productSetCreate({ name: '系列A' })
    await FilesService.writeTextAtomic(target, '# 你好')
    expect(await fsp.readFile(target, 'utf-8')).toBe('# 你好')
    // 同目录无 .tmp 残留
    const leftovers = (await fsp.readdir(path.dirname(target))).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('2MB 上限拒绝（与读同值）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const target = path.join(ws, 'big.md')
    const big = 'x'.repeat(2 * 1024 * 1024 + 1)
    await expect(FilesService.writeTextAtomic(target, big)).rejects.toThrow('超过大小上限')
    // 不产生文件
    expect(await fsp.stat(target).then(() => true).catch(() => false)).toBe(false)
  })

  it('原子替换：覆盖既有文件，目标 mtime/内容更新', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const target = path.join(ws, 'a.md')
    await FilesService.writeTextAtomic(target, 'v1')
    await FilesService.writeTextAtomic(target, 'v2')
    expect(await fsp.readFile(target, 'utf-8')).toBe('v2')
  })
})
