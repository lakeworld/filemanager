import { describe, it, expect, vi } from 'vitest'
import { isPathInsideWorkspace, thumbnailPath, productSetFromFilePath, defaultWorkspaceConfig, readJsonFile, recentPath } from '../../src/main/core/paths'
import { buildTestBox } from './helpers'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-path-'))
}

describe('isPathInsideWorkspace', () => {
  it('工作区内路径通过', () => {
    expect(isPathInsideWorkspace('/a/b', '/a/b/c/d.jpg')).toBe(true)
    expect(isPathInsideWorkspace('/a/b', '/a/b')).toBe(true)
  })
  it('越界路径拒绝（含前缀欺骗）', () => {
    expect(isPathInsideWorkspace('/a/b', '/a/bc/x.jpg')).toBe(false)
    expect(isPathInsideWorkspace('/a/b', '/a')).toBe(false)
    expect(isPathInsideWorkspace('/a/b', '/c/d')).toBe(false)
  })
})

describe('thumbnailPath 兼容性', () => {
  it('路径结构 = .qihefilemanager/.thumbnails/<hash前2>/<hash><ext>.thumb.jpg', () => {
    const t = thumbnailPath('/ws', '/ws/产品集/A/主图/图.jpg')
    const rel = path.relative('/ws/.qihefilemanager/.thumbnails', t)
    const parts = rel.split(path.sep)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toHaveLength(2) // hash 前 2 位
    expect(parts[1]).toMatch(/^[0-9a-f]{32}\.jpg\.thumb\.jpg$/)
  })
  it('同路径哈希稳定', () => {
    expect(thumbnailPath('/ws', '/x/y.jpg')).toBe(thumbnailPath('/ws', '/x/y.jpg'))
  })
})

describe('productSetFromFilePath', () => {
  it('提取产品集名', () => {
    expect(productSetFromFilePath('/ws', '/ws/产品集/夏季系列/图包/主图/a.jpg')).toBe('夏季系列')
  })
  it('非产品集路径返回空', () => {
    expect(productSetFromFilePath('/ws', '/ws/导出/a.jpg')).toBe('')
    expect(productSetFromFilePath('/ws', '/other/a.jpg')).toBe('')
  })
})

describe('readJsonFile 损坏只读语义（v2.5 P1-C1/B2；v2.5.3 T2 修订）', () => {
  it('文件存在但 JSON 损坏 → 返回 null；只读不移动/不备份，留证交给写路径守卫', async () => {
    const dir = await tmp()
    const p = path.join(dir, 'data.json')
    await fsp.writeFile(p, '{bad json')
    expect(await readJsonFile(p)).toBeNull()
    const files = await fsp.readdir(dir)
    expect(files.filter((n) => n.startsWith('data.json.corrupt-'))).toHaveLength(0)
    // 原文件原位保留：只读路径不隔离，写路径（readJsonForMutation）首次遇到损坏才隔离并拒绝覆盖
    expect(await fsp.readFile(p, 'utf-8')).toBe('{bad json')
  })

  it('文件缺失 → 返回 null 且不产生备份', async () => {
    const dir = await tmp()
    const p = path.join(dir, 'missing.json')
    expect(await readJsonFile(p)).toBeNull()
    expect(await fsp.readdir(dir)).toEqual([])
  })
})

describe('工作区全链路（对照原 app_test.go）', () => {
  it('建工作区 → 建产品集（8 子目录）→ 配置 → recents', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)

    // 建工作区
    const info = await box.workspace.create(ws)
    expect(info.name).toBe(path.basename(ws))

    // 默认配置
    const cfg = await box.workspace.getConfig()
    expect(cfg.image_subfolders).toEqual(['主图', '详情页', '白底图', '素材'])
    expect(cfg.cert_subfolders).toEqual(['3C', '质检', '专利'])

    // 建产品集 → 默认子目录结构
    const ps = await box.workspace.productSetCreate({ name: '夏季T恤系列' })
    expect(ps.name).toBe('夏季T恤系列')
    const psRoot = path.join(ws, '产品集', '夏季T恤系列')
    for (const sub of cfg.image_subfolders) {
      const d = path.join(psRoot, '图包', sub)
      expect((await fsp.stat(d)).isDirectory()).toBe(true)
    }
    for (const sub of cfg.cert_subfolders) {
      const d = path.join(psRoot, '证书', sub)
      expect((await fsp.stat(d)).isDirectory()).toBe(true)
    }

    // recents 记录
    const recents = await box.workspace.loadRecentWorkspaces()
    expect(recents).toContain(ws)

    // 当前工作区
    const cur = await box.workspace.current()
    expect(cur?.path).toBe(ws)
  })

  it('产品集列表统计数量', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: 'B系列' })
    await box.workspace.productSetCreate({ name: 'A系列', tags: ['重要'], notes: '备注' })

    const list = await box.workspace.productSetList()
    expect(list.map((p) => p.name).sort()).toEqual(['A系列', 'B系列'])
    const a = list.find((p) => p.name === 'A系列')
    expect(a?.tags).toEqual(['重要'])
    expect(a?.notes).toBe('备注')
  })

  it('删除产品集：目录移入回收站，元数据保留；彻底删除后才清理', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '待删' })

    // 写入一条元数据
    await box.metadata.update({ file_path: path.join(ws, '产品集', '待删', '图包', '主图', 'a.jpg'), cert_type: '3C' })

    await box.deleteProductSet('待删')
    const dir = path.join(ws, '产品集', '待删')
    await expect(fsp.stat(dir)).rejects.toThrow()
    // v2.3.1 回收站：删除时元数据保留（恢复可还原）
    const entries = await box.trash.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('productSet')
    let store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).toHaveLength(1)

    // 彻底删除后才清理
    await box.trash.purge(entries[0].id)
    store = await box.metadata.loadMetadataStore()
    expect(Object.keys(store.files)).toHaveLength(0)
  })

  // —— v2.2.1：子文件夹重命名 + 同步迁移已有产品集 ——
  it('子文件夹重命名 acrossEntities=true：迁移所有产品集目录 + 更新配置（默认只改模板，另见 a9 刀3b 判据）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })
    await box.workspace.productSetCreate({ name: '系列B' })

    const cfg = await box.workspace.renameSubfolder('image', '主图', '场景图', { acrossEntities: true })
    expect(cfg.image_subfolders).toContain('场景图')
    expect(cfg.image_subfolders).not.toContain('主图')

    // 两个产品集的图包目录都已迁移
    for (const ps of ['系列A', '系列B']) {
      const oldDir = path.join(ws, '产品集', ps, '图包', '主图')
      await expect(fsp.stat(oldDir)).rejects.toThrow()
      const newDir = path.join(ws, '产品集', ps, '图包', '场景图')
      expect((await fsp.stat(newDir)).isDirectory()).toBe(true)
    }
    // 证书目录不受影响
    const certDir = path.join(ws, '产品集', '系列A', '证书', '3C')
    expect((await fsp.stat(certDir)).isDirectory()).toBe(true)
  })

  it('子文件夹重命名：重名拒绝 + 不存在的旧名拒绝 + 幂等', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    // 重名拒绝
    await expect(box.workspace.renameSubfolder('image', '主图', '详情页')).rejects.toThrow('已存在')
    // 旧名不存在拒绝
    await expect(box.workspace.renameSubfolder('image', '不存在的', '新名')).rejects.toThrow('不存在')
    // 同名（old === new）幂等返回
    const cfg = await box.workspace.renameSubfolder('image', '主图', '主图')
    expect(cfg.image_subfolders).toContain('主图')
    // 未建子目录的产品集不报错（源不存在跳过）
    await box.workspace.productSetCreate({ name: '空集' })
    const cfg2 = await box.workspace.renameSubfolder('cert', '3C', 'CCC')
    expect(cfg2.cert_subfolders).toContain('CCC')
  })

  it('子文件夹重命名 type=supplier：供应商/<名>/ 目录迁移 + config.supplier_subfolders（v2.5.5 对齐客户）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.suppliers.create({ name: '甲' })
    await box.suppliers.create({ name: '乙' })

    const cfg = await box.workspace.renameSubfolder('supplier', '合同', '采购合同', { acrossEntities: true })
    expect(cfg.supplier_subfolders).toContain('采购合同')
    expect(cfg.supplier_subfolders).not.toContain('合同')

    // 两个供应商的 合同 → 采购合同 都已迁移
    for (const name of ['甲', '乙']) {
      const root = path.join(ws, '供应商', name)
      await expect(fsp.stat(path.join(root, '合同'))).rejects.toThrow()
      expect((await fsp.stat(path.join(root, '采购合同'))).isDirectory()).toBe(true)
    }
    // 客户目录不受影响
    const custDir = path.join(ws, '客户')
    expect((await fsp.stat(custDir)).isDirectory()).toBe(true)

    // 重名拒绝
    await expect(box.workspace.renameSubfolder('supplier', '对账单', '采购合同')).rejects.toThrow('已存在')
  })

  it('v2.4.7：工作区根目录保留名拦截（产品集新建/重命名，不区分大小写）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.workspace.productSetCreate({ name: '系列A' })

    // 新建拦截：保留名一律拒绝（中文保留名 + 大小写变体）
    for (const bad of ['客户', '发票', '入库', '交换区', '产品集', '图包', '证书', '导出']) {
      await expect(box.workspace.productSetCreate({ name: bad })).rejects.toThrow('保留')
    }
    await expect(box.workspace.productSetCreate({ name: '客户' })).rejects.toThrow('保留')
    // 重命名拦截：既有产品集不可改名为保留名
    await expect(box.workspace.renameProductSet('系列A', '发票')).rejects.toThrow('保留')
    // 非保留名照常可用
    const ok = await box.workspace.productSetCreate({ name: '正常集' })
    expect(ok.name).toBe('正常集')
  })

  it('v2.5.3（T2）：config.json 损坏 → loadConfig 首次拒绝覆盖并隔离留证，重试后重建默认配置', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const dir = path.join(ws, '.qihefilemanager')
    const p = path.join(dir, 'config.json')
    await fsp.writeFile(p, '{"name": "坏')
    // 写默认配置走严格事务（overwriteJson → readJsonForMutation）：损坏文件先隔离留证，再拒绝覆盖
    await expect(box.workspace.loadConfig(ws)).rejects.toThrow(/损坏|拒绝覆盖/)
    const backups = (await fsp.readdir(dir)).filter((n) => n.startsWith('config.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await fsp.readFile(path.join(dir, backups[0]), 'utf-8')).toBe('{"name": "坏')
    // 原文件已隔离，重试：缺失 → 重建默认配置成功
    const cfg = await box.workspace.loadConfig(ws)
    expect(cfg.name).toBe('Workspace')
  })
})

describe('setCurrentWorkspace 切换通知先于持久化（v2.5.3 T5-S1）', () => {
  /** 轮询等待条件（替代固定 setTimeout 等待，稳定无脆弱窗口） */
  async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  it('onWorkspaceChanged 在 addRecentWorkspace 落盘前同步触发（先失效旧 session 再等待持久化）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    const order: string[] = []
    box.workspace.onWorkspaceChanged(() => {
      order.push('notify')
      // 通知时刻：currentWS 必须已是新工作区（索引 beginRebuild / 交换区 stop 都依赖它）
      expect(box.workspace.currentWorkspacePath()).toBe(path.resolve(ws))
    })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const spy = vi.spyOn(box.workspace, 'loadRecentWorkspaces').mockImplementation(async () => {
      order.push('persist-reading')
      await gate // 挂起最近工作区落盘前的读取：通知必须先于此处完成
      return []
    })

    const switching = box.workspace.setCurrentWorkspace(ws)
    await waitFor(() => order.includes('notify')) // 通知已在持久化挂起期间触发
    expect(order).toEqual(['notify', 'persist-reading']) // 通知先于持久化读取
    release()
    await switching
    // 落盘完成仍不改变顺序：通知发生在持久化之前且仅一次
    expect(order).toEqual(['notify', 'persist-reading'])
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('addRecentWorkspace 失败（磁盘错误）不影响切换生效：通知已先行、currentWS 不回滚', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    let notifyCount = 0
    box.workspace.onWorkspaceChanged(() => {
      notifyCount++
      expect(box.workspace.currentWorkspacePath()).toBe(path.resolve(ws))
    })
    const spy = vi.spyOn(box.workspace, 'loadRecentWorkspaces').mockRejectedValue(new Error('磁盘错误'))

    await expect(box.workspace.setCurrentWorkspace(ws)).rejects.toThrow('磁盘错误')
    expect(notifyCount).toBe(1) // 通知已先行，切换不因落盘失败回滚
    expect(box.workspace.currentWorkspacePath()).toBe(path.resolve(ws)) // currentWS 保持新值
    spy.mockRestore()
  })
})

describe('启动打开哪个工作区（v2.6.1 默认工作区）', () => {
  /** 造一个已存在、可被识别为工作区的目录（ensureWorkspaceDirs 由 create 负责，这里只建空目录即可 stat 到） */
  async function existingDir(): Promise<string> {
    return tmp()
  }

  it('默认指针存在且目录在 → 开默认，而不是最近列表首位', async () => {
    const home = await tmp()
    const recent = await existingDir()
    const def = await existingDir()
    const box = buildTestBox(home)
    await box.workspace.setCurrentWorkspace(recent) // 先让 recent 落到 recents[0]

    const info = await box.workspace.restoreOrCreateDefault(def)
    expect(path.resolve(info.path)).toBe(path.resolve(def))
    expect(box.workspace.currentWorkspacePath()).toBe(path.resolve(def))
    // 默认那个工作区也进 recents（它就是被打开过一次），但打开的是它不是旧首位
    expect((await box.workspace.loadRecentWorkspaces())[0]).toBe(def)
  })

  it('默认指针失效（目录已删）→ 退回 recents[0]，且指针不被这次失败抹掉', async () => {
    const home = await tmp()
    const recent = await existingDir()
    const gone = path.join(await tmp(), '已拔掉的移动盘')
    const box = buildTestBox(home)
    await box.workspace.setCurrentWorkspace(recent)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const info = await box.workspace.restoreOrCreateDefault(gone)
    expect(path.resolve(info.path)).toBe(path.resolve(recent))
    // 不静默（红线）：降级要说一行，否则用户以为默认生效了
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(gone)
    warn.mockRestore()

    // 指针是持久设置、不在 core 里被清；盘重新挂上（目录又在了）下一次启动仍回到它
    await fsp.mkdir(gone, { recursive: true })
    const again = await buildTestBox(home).workspace.restoreOrCreateDefault(gone)
    expect(path.resolve(again.path)).toBe(path.resolve(gone))
  })

  it('无默认指针 = 现行行为（开 recents[0]）；空串与非字符串入参都当"未设置"', async () => {
    const home = await tmp()
    const recent = await existingDir()
    await buildTestBox(home).workspace.setCurrentWorkspace(recent)

    for (const unset of [undefined, null, '']) {
      const box = buildTestBox(home)
      const info = await box.workspace.restoreOrCreateDefault(unset)
      expect(path.resolve(info.path), String(unset)).toBe(path.resolve(recent))
    }
  })

  it('无默认且无 recents → 兜底建在注入的 homeDir 下（不碰真实主目录）', async () => {
    const home = await tmp()
    const box = buildTestBox(home)
    const info = await box.workspace.restoreOrCreateDefault(undefined)
    // 本例若走到 os.homedir() 就会在测试机上真建 ~/启禾文件管理 —— 断言它落在注入的 home 里
    expect(path.resolve(info.path)).toBe(path.join(path.resolve(home), '启禾文件管理'))
    expect(home).not.toBe(os.homedir())
  })

  it('默认指针指向文件而非目录 → 当失效处理，不抛不建在文件里', async () => {
    const home = await tmp()
    const recent = await existingDir()
    const file = path.join(await tmp(), '不是目录.txt')
    await fsp.writeFile(file, 'x')
    await buildTestBox(home).workspace.setCurrentWorkspace(recent)
    const box = buildTestBox(home)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = await box.workspace.restoreOrCreateDefault(file)
    expect(path.resolve(info.path)).toBe(path.resolve(recent))
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('兜底目录已存在（只是不在 recents 里）→ open 它，不拿默认 config 覆盖用户改过的模板', async () => {
    const home = await tmp()
    const defDir = path.join(home, '启禾文件管理')
    const first = buildTestBox(home)
    await first.workspace.create(defDir)
    const cfg = await first.workspace.getConfig()
    cfg.image_subfolders = ['主图-自定义']
    // 用**合法**字段名里的非默认子集（默认是四件全开）：`sku_code` 不是 `NamingField` 的取值，
    // 而 `saveConfig` 不校验 ⇒ 这里曾钉的是应用永远产不出的形状，且只有
    // `tsc -p tsconfig.node.json` 这条（include 含 tests/**）会红，裸 `tsc --noEmit` 看不到。
    cfg.naming_template.sku_fields = ['original_name', 'sub_folder']
    await first.workspace.saveConfig(defDir, cfg)
    // 抹掉 recents：模拟"用户删过最近列表 / 换过机器"，盘上工作区仍在
    await fsp.writeFile(recentPath(home), '[]')

    const second = buildTestBox(home)
    const info = await second.workspace.restoreOrCreateDefault(undefined)
    expect(path.resolve(info.path)).toBe(path.resolve(defDir))
    const after = await second.workspace.getConfig()
    expect(after.image_subfolders).toEqual(['主图-自定义'])
    expect(after.naming_template.sku_fields).toEqual(['original_name', 'sub_folder'])
  })
})
