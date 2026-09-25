/**
 * 计算台账服务单测（v2.5.9/A7；权威 = 内部计算设计文档（不进公开仓）§三 对象模型与存储）
 * 覆盖：落账默认值（saved=false / created=updated / 可选字段缺省）/ 入参校验（含类型面）/
 * 列表顺序（先记的在先）/ update 补丁语义（title·note·saved 互不打扰、'' 清空、undefined 不动）/
 * 取消标记（saved true→false）/ 未知 id 与原型链假 id（`__proto__` / `toString`）拒绝 / remove / 持久化（重开工作区仍在）/
 * 工作区隔离（各自 calcs.json）/ 损坏文件拒绝覆盖（jsonStore 守卫）/
 * Logger 注入（add/update/remove 各调一次 info）。
 *
 * v2.6.1（B15 容器化）追加：容器 CRUD（新建/重命名/删除连记录一起删）/ 记录归属与跨容器隔离 /
 * add 的容器校验 / 老数据迁移（无 container_id 统一归入自动创建的「默认」容器）**幂等、只写一次**。
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { CalcsService } from '../../src/main/core/calcs'
import { MemoryLogger } from '../../src/main/core/logger'
import type { BoxService } from '../../src/main/core'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { CalcRecord, CalcCreateRequest, CalcContainer } from '../../src/shared/types'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-calcs-'))
}

function calcsFilePath(ws: string): string {
  return path.join(ws, '.qihefilemanager', 'calcs.json')
}

/** 容器台账落盘位置（`<ws>/.qihefilemanager/calc-containers.json`，见 src/main/core/paths.ts） */
function containersFilePath(ws: string): string {
  return path.join(ws, '.qihefilemanager', 'calc-containers.json')
}

async function readCalcsFile(ws: string): Promise<Record<string, CalcRecord>> {
  return JSON.parse(await fsp.readFile(calcsFilePath(ws), 'utf-8'))
}

async function readContainersFile(ws: string): Promise<Record<string, CalcContainer>> {
  return JSON.parse(await fsp.readFile(containersFilePath(ws), 'utf-8'))
}

const REQ = { expression: '(3200 + 380) × 1.15', result: '4,117.00', resultKind: 'number' as const }

/** 容器化后 add 必带存在的 container_id：测试统一走这个助手（缺省用工作区默认容器） */
async function addReq(box: BoxService, extra: Partial<CalcCreateRequest> = {}): Promise<CalcRecord> {
  const container_id = extra.container_id ?? (await box.calcs.listContainers())[0].id
  return box.calcs.add({ ...REQ, container_id, ...extra } as CalcCreateRequest)
}

describe('计算台账服务（v2.5.9/A7）', () => {
  it('落账与默认值：saved=false、created=updated、title/note 缺省、id 非空', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const rec = await addReq(box)
    expect(rec.id).toBeTruthy()
    expect(rec.container_id).toBeTruthy()
    expect(rec.saved).toBe(false)
    expect(rec.created).toBe(rec.updated)
    expect(rec.created).not.toBe('')
    expect(rec.title).toBeUndefined()
    expect(rec.note).toBeUndefined()
    expect(rec.expression).toBe(REQ.expression)
    expect(rec.result).toBe(REQ.result)
    expect(rec.resultKind).toBe('number')

    // 落盘形态：Record<id, CalcRecord>（key = id）
    const file = await readCalcsFile(ws)
    expect(Object.keys(file)).toEqual([rec.id])
    expect(file[rec.id].expression).toBe(REQ.expression)

    const list = await box.calcs.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(rec.id)
  })

  it('入参校验：算式/结果为空拒绝；resultKind 非法拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await expect(addReq(box, { expression: '   ' })).rejects.toThrow('算式')
    await expect(addReq(box, { result: ' ' })).rejects.toThrow('结果')
    await expect(
      addReq(box, { resultKind: 'nope' as unknown as 'number' }),
    ).rejects.toThrow('resultKind')
    // 校验失败不落账（文件不产生）
    await expect(fsp.stat(calcsFilePath(ws))).rejects.toThrow()
  })

  it('列表顺序：先记的在先（时间流按录入顺序）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const a = await addReq(box, { expression: '1 + 1', result: '2.00' })
    const b = await addReq(box, { expression: '2 × 3', result: '6.00' })
    const c = await addReq(box, { expression: '2026-09-16 + 60', result: '2026-11-15', resultKind: 'date' })
    const list = await box.calcs.list()
    expect(list.map((r) => r.id)).toEqual([a.id, b.id, c.id])
  })

  it('update 补丁语义：title/note/saved 各自独立；空串清空；undefined 不动；created 不变', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const rec = await addReq(box)
    const u1 = await box.calcs.update({ id: rec.id, title: '  报价毛利  ' })
    expect(u1.title).toBe('报价毛利')
    expect(u1.note).toBeUndefined()

    const u2 = await box.calcs.update({ id: rec.id, note: '新款装箱毛重，每箱 20 件、单件 0.3kg' })
    expect(u2.title).toBe('报价毛利')
    expect(u2.note).toBe('新款装箱毛重，每箱 20 件、单件 0.3kg')

    const u3 = await box.calcs.update({ id: rec.id, note: '' })
    expect(u3.note).toBeUndefined()
    expect(u3.title).toBe('报价毛利')

    const u4 = await box.calcs.update({ id: rec.id, saved: true })
    expect(u4.saved).toBe(true)
    expect(u4.title).toBe('报价毛利')
    const u5 = await box.calcs.update({ id: rec.id, saved: false })
    expect(u5.saved).toBe(false)
    expect(u5.created).toBe(rec.created)
    expect(u5.updated >= rec.updated).toBe(true)

    // 落盘同步（不是只改内存）
    const file = await readCalcsFile(ws)
    expect(file[rec.id].title).toBe('报价毛利')
  })

  it('未知 id：update/remove 拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await expect(box.calcs.update({ id: 'nope', title: 'x' })).rejects.toThrow('不存在')
    await expect(box.calcs.remove('nope')).rejects.toThrow('不存在')
  })

  it('原型链上的假 id 一律按「不存在」拒绝：不污 Object.prototype、不返回 function', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 旧口径 `store[id]` 是原型链查找：`__proto__` 取到 Object.prototype（被当记录写脏 = 污主进程全局），
    // `toString` 取到函数（过 IPC 报 could not be cloned，渲染层按钮静默无效）；`delete store['toString']`
    // 还会假成功（什么都没删却报成功）。一律先按自有键判存在。
    await expect(box.calcs.update({ id: '__proto__', title: 'PWN' })).rejects.toThrow('不存在')
    await expect(box.calcs.update({ id: 'toString', saved: true })).rejects.toThrow('不存在')
    await expect(box.calcs.remove('__proto__')).rejects.toThrow('不存在')
    await expect(box.calcs.remove('toString')).rejects.toThrow('不存在')
    expect(({} as Record<string, unknown>).title, 'Object.prototype 被写脏了').toBeUndefined()
    expect(({} as Record<string, unknown>).saved).toBeUndefined()
    expect(await box.calcs.list()).toHaveLength(0)
    await expect(fsp.stat(calcsFilePath(ws)), '被拒绝的调用不该落盘').rejects.toThrow()
  })

  it('入参类型校验：saved 只认布尔、title/note 只认文本、id 只认非空字符串', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const rec = await addReq(box)

    // 旧口径 `req.saved === true` 把字符串 'true' 判成 false ⇒ 悄悄取消标记（还报成功）
    await expect(box.calcs.update({ id: rec.id, saved: 'true' as unknown as boolean })).rejects.toThrow('布尔')
    await expect(box.calcs.update({ id: rec.id, title: 123 as unknown as string })).rejects.toThrow('标题')
    await expect(box.calcs.update({ id: rec.id, note: {} as unknown as string })).rejects.toThrow('备注')
    await expect(box.calcs.update({ id: 5 as unknown as string, title: 'x' })).rejects.toThrow('缺少记录 id')
    await expect(box.calcs.remove('')).rejects.toThrow('缺少记录 id')
    await expect(box.calcs.remove(undefined as unknown as string)).rejects.toThrow('缺少记录 id')

    // 被拒的调用不改盘也不改内存：saved 仍 false、title 仍未写
    const after = (await box.calcs.list())[0]
    expect(after.id).toBe(rec.id)
    expect(after.saved).toBe(false)
    expect(after.title).toBeUndefined()
  })

  it('remove：删记录不留空壳；重复删拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const rec = await addReq(box)
    await box.calcs.remove(rec.id)
    expect(await box.calcs.list()).toHaveLength(0)
    expect(await readCalcsFile(ws)).toEqual({})
    await expect(box.calcs.remove(rec.id)).rejects.toThrow('不存在')
  })

  it('持久化：重开工作区历史仍在（暂存也落盘，扛得住重启）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    const rec = await addReq(box)

    // 模拟重启：新的 BoxService + 重新 open 同一工作区
    const box2 = buildTestBox(home)
    await box2.workspace.open(ws)
    const list = await box2.calcs.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(rec.id)
    expect(list[0].result).toBe('4,117.00')
  })

  it('工作区隔离：各自 calcs.json，互不可见', async () => {
    const home = await tmp()
    const ws1 = await tmp()
    const ws2 = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws1)
    await addReq(box)

    await box.workspace.create(ws2)
    expect(await box.calcs.list()).toHaveLength(0)
    await expect(fsp.stat(calcsFilePath(ws2))).rejects.toThrow()
    expect(Object.keys(await readCalcsFile(ws1))).toHaveLength(1)
  })

  it('损坏文件拒绝覆盖（jsonStore 守卫）：add 抛错且损坏件被隔离留证', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await fsp.writeFile(calcsFilePath(ws), '{ 这不是 JSON', 'utf-8')
    await expect(addReq(box)).rejects.toThrow()
    const files = await fsp.readdir(path.join(ws, '.qihefilemanager'))
    const corrupt = files.find((f) => f.startsWith('calcs.json.corrupt-'))
    expect(corrupt).toBeTruthy()
    // jsonStore 语义：损坏件优先 **rename 移动**留证（跨卷失败才 copy）——原位不再有半坏文件，
    // 且调用被拒绝后没有把它覆盖成新库；损坏原文在隔离件里逐字节保留
    expect(await fsp.readFile(path.join(ws, '.qihefilemanager', corrupt as string), 'utf-8')).toBe('{ 这不是 JSON')
    await expect(fsp.stat(calcsFilePath(ws))).rejects.toThrow()
  })

  it('Logger 注入：add/update/remove 各调一次 info', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const logger = new MemoryLogger()
    const svc = new CalcsService(box.workspace, logger)
    const container_id = (await svc.listContainers())[0].id
    const rec = await svc.add({ ...REQ, container_id })
    await svc.update({ id: rec.id, saved: true })
    await svc.remove(rec.id)
    const infoMsgs = logger.calls.filter((c) => c.level === 'info').map((c) => c.msg)
    expect(infoMsgs).toHaveLength(3)
    expect(infoMsgs[0]).toContain('记一条')
    expect(infoMsgs[1]).toContain('更新')
    expect(infoMsgs[2]).toContain('删除')
  })
})

/**
 * v2.6.1（B15 容器化）：左栏 = 容器（对话/笔记本），右栏 = 该容器下的计算历史。
 * 权威 = 内部计算设计文档（不进公开仓）§四「容器化修订」。
 * 本段守四件事：容器 CRUD（删除连记录一起删）/ 记录归属与跨容器隔离 /
 * 老数据迁移（无 container_id → 自动创建的「默认」容器）**幂等、只写一次** / 新增的写盘路径同样守 jsonStore 守卫。
 */
describe('计算容器（v2.6.1 B15 容器化）', () => {
  it('listContainers 首次调用自动建「默认」容器；重复调用只读不写（幂等）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const list = await box.calcs.listContainers()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('默认')
    expect(list[0].id).toBeTruthy()
    expect(list[0].created).toBeTruthy()
    // 落盘形态 Record<id, CalcContainer>（key = id）
    const file = await readContainersFile(ws)
    expect(Object.keys(file)).toEqual([list[0].id])
    expect(file[list[0].id].name).toBe('默认')

    // 幂等：再调只读不写——字节与 mtime 都不动（jsonStore 无变化不写盘）
    const bytes = await fsp.readFile(containersFilePath(ws), 'utf-8')
    const st = await fsp.stat(containersFilePath(ws))
    const again = await box.calcs.listContainers()
    expect(again.map((c) => c.id)).toEqual([list[0].id])
    expect(await fsp.readFile(containersFilePath(ws), 'utf-8')).toBe(bytes)
    expect((await fsp.stat(containersFilePath(ws))).mtimeMs).toBe(st.mtimeMs)
  })

  it('createContainer / renameContainer：trim 落盘；空名拒绝；未知与原型链假 id 拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)
    await box.calcs.listContainers() // 先有默认容器

    const c = await box.calcs.createContainer({ name: '  报价  ' })
    expect(c.name).toBe('报价')
    expect(c.id).toBeTruthy()
    expect((await box.calcs.listContainers()).map((x) => x.name)).toEqual(['默认', '报价'])
    expect((await readContainersFile(ws))[c.id].name).toBe('报价')

    const r = await box.calcs.renameContainer({ id: c.id, name: ' 报价 2026 ' })
    expect(r.name).toBe('报价 2026')
    expect((await readContainersFile(ws))[c.id].name).toBe('报价 2026')

    await expect(box.calcs.createContainer({ name: '   ' })).rejects.toThrow('容器名')
    await expect(box.calcs.createContainer({ name: undefined as unknown as string })).rejects.toThrow('容器名')
    await expect(box.calcs.renameContainer({ id: c.id, name: '' })).rejects.toThrow('容器名')
    await expect(box.calcs.renameContainer({ id: 'nope', name: 'x' })).rejects.toThrow('不存在')
    await expect(box.calcs.renameContainer({ id: '__proto__', name: 'PWN' })).rejects.toThrow('不存在')
    await expect(box.calcs.renameContainer({ id: 'toString', name: 'PWN' })).rejects.toThrow('不存在')
    // 拒绝的调用不改盘、不污 Object.prototype
    expect(({} as Record<string, unknown>).name).toBeUndefined()
    expect((await readContainersFile(ws))[c.id].name).toBe('报价 2026')
  })

  it('记录归属：list(容器) 只含该容器；跨容器互不可见；list() 仍可全量', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const [def] = await box.calcs.listContainers()
    const other = await box.calcs.createContainer({ name: '客户 A 的账' })
    const r1 = await addReq(box)
    const r2 = await addReq(box, { container_id: other.id, expression: '2 × 3', result: '6.00' })
    expect(r1.container_id).toBe(def.id)
    expect(r2.container_id).toBe(other.id)

    expect((await box.calcs.list(def.id)).map((r) => r.id)).toEqual([r1.id])
    expect((await box.calcs.list(other.id)).map((r) => r.id)).toEqual([r2.id])
    expect((await box.calcs.list()).map((r) => r.id)).toEqual([r1.id, r2.id])
    // 未知容器 = 空集（不抛：删容器与切换之间有个窗口）
    expect(await box.calcs.list('nope-container')).toEqual([])
    // 盘上归属也分开
    const file = await readCalcsFile(ws)
    expect(file[r1.id].container_id).toBe(def.id)
    expect(file[r2.id].container_id).toBe(other.id)
  })

  it('add 容器校验：缺 container_id / 容器不存在（含原型链假 id）→ 拒绝且不落账', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    await expect(box.calcs.add({ ...REQ, container_id: '' } as CalcCreateRequest)).rejects.toThrow('容器')
    await expect(box.calcs.add({ ...REQ, container_id: '   ' } as CalcCreateRequest)).rejects.toThrow('容器')
    await expect(box.calcs.add({ ...REQ, container_id: 'ghost' } as CalcCreateRequest)).rejects.toThrow('容器不存在')
    await expect(box.calcs.add({ ...REQ, container_id: '__proto__' } as CalcCreateRequest)).rejects.toThrow('容器不存在')
    await expect(box.calcs.add({ ...REQ, container_id: 'toString' } as CalcCreateRequest)).rejects.toThrow('容器不存在')
    expect(await box.calcs.list()).toHaveLength(0)
    await expect(fsp.stat(calcsFilePath(ws)), '被拒绝的 add 不该落盘').rejects.toThrow()
  })

  it('removeContainer：连其中记录一起删并返回条数；别容器记录不动；未知 id 与原型链假 id 拒绝', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const [def] = await box.calcs.listContainers()
    const other = await box.calcs.createContainer({ name: '客户 A 的账' })
    const rDef = await addReq(box)
    await addReq(box, { container_id: other.id })
    await addReq(box, { container_id: other.id, expression: '1 + 1', result: '2.00' })

    const removed = await box.calcs.removeContainer(other.id)
    expect(removed).toBe(2)
    expect((await box.calcs.listContainers()).map((c) => c.id)).toEqual([def.id])
    expect((await box.calcs.list()).map((r) => r.id)).toEqual([rDef.id])
    // 盘上两处都删干净：容器没了、它的记录也没了
    expect(Object.hasOwn(await readContainersFile(ws), other.id)).toBe(false)
    expect(Object.keys(await readCalcsFile(ws))).toEqual([rDef.id])

    await expect(box.calcs.removeContainer('nope')).rejects.toThrow('不存在')
    await expect(box.calcs.removeContainer('__proto__')).rejects.toThrow('不存在')
    await expect(box.calcs.removeContainer('')).rejects.toThrow('缺少容器 id')
    expect(({} as Record<string, unknown>).id).toBeUndefined()
  })

  it('删掉最后一个容器后，列表会再给出一个新的「默认」（不进入无容器死锁）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const [def] = await box.calcs.listContainers()
    expect(await box.calcs.removeContainer(def.id)).toBe(0)
    const again = await box.calcs.listContainers()
    expect(again).toHaveLength(1)
    expect(again[0].name).toBe('默认')
    expect(again[0].id).not.toBe(def.id)
  })

  it('老数据迁移：无 container_id 的记录归入自动创建的「默认」容器——幂等、只写一次', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    // 老工作区形态：calcs.json 是 v2.5.9 的记录（无 container_id），且没有 calc-containers.json
    const legacy = {
      'old-1': {
        id: 'old-1',
        expression: '1 + 1',
        result: '2.00',
        resultKind: 'number',
        saved: true,
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
      },
      'old-2': {
        id: 'old-2',
        expression: '2 × 3',
        result: '6.00',
        resultKind: 'number',
        saved: false,
        title: '留存标题',
        created: '2026-01-02T00:00:00.000Z',
        updated: '2026-01-02T00:00:00.000Z',
      },
    }
    await fsp.writeFile(calcsFilePath(ws), JSON.stringify(legacy, null, 2), 'utf-8')

    const containers = await box.calcs.listContainers()
    expect(containers).toHaveLength(1)
    expect(containers[0].name).toBe('默认')
    const list = await box.calcs.list()
    expect(list.map((r) => r.id)).toEqual(['old-1', 'old-2'])
    for (const r of list) expect(r.container_id).toBe(containers[0].id)

    // 迁移只补 container_id：saved 两态与其它字段一字未动
    const file = await readCalcsFile(ws)
    expect(file['old-1'].container_id).toBe(containers[0].id)
    expect(file['old-1'].saved).toBe(true)
    expect(file['old-2'].saved).toBe(false)
    expect(file['old-2'].title).toBe('留存标题')
    expect(file['old-1'].created).toBe('2026-01-01T00:00:00.000Z')

    // 幂等、只写一次：后续任意次访问，两个文件字节与 mtime 都不动
    const calcsBytes = await fsp.readFile(calcsFilePath(ws), 'utf-8')
    const calcsStat = await fsp.stat(calcsFilePath(ws))
    const cBytes = await fsp.readFile(containersFilePath(ws), 'utf-8')
    const cStat = await fsp.stat(containersFilePath(ws))
    await box.calcs.listContainers()
    await box.calcs.list()
    await box.calcs.listContainers()
    await box.calcs.list(containers[0].id)
    expect(await fsp.readFile(calcsFilePath(ws), 'utf-8')).toBe(calcsBytes)
    expect((await fsp.stat(calcsFilePath(ws))).mtimeMs).toBe(calcsStat.mtimeMs)
    expect(await fsp.readFile(containersFilePath(ws), 'utf-8')).toBe(cBytes)
    expect((await fsp.stat(containersFilePath(ws))).mtimeMs).toBe(cStat.mtimeMs)

    // 重启（新 BoxService + 重开同一工作区）仍幂等：不重建容器、不重写文件
    const box2 = buildTestBox(home)
    await box2.workspace.open(ws)
    const containers2 = await box2.calcs.listContainers()
    expect(containers2.map((c) => c.id)).toEqual([containers[0].id])
    expect((await box2.calcs.list(containers2[0].id)).map((r) => r.id)).toEqual(['old-1', 'old-2'])
    expect(await fsp.readFile(calcsFilePath(ws), 'utf-8')).toBe(calcsBytes)
    expect((await fsp.stat(calcsFilePath(ws))).mtimeMs).toBe(calcsStat.mtimeMs)
    expect(await fsp.readFile(containersFilePath(ws), 'utf-8')).toBe(cBytes)
  })

  it('迁移归属到最老容器（已有容器时不另造「默认」）；孤儿 container_id 归回最老容器', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const c1 = await box.calcs.createContainer({ name: '先建的' })
    const c2 = await box.calcs.createContainer({ name: '后建的' })
    const legacy = {
      'old-1': {
        id: 'old-1',
        expression: '1 + 1',
        result: '2.00',
        resultKind: 'number',
        saved: false,
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
      },
      'old-2': {
        id: 'old-2',
        expression: '2 × 3',
        result: '6.00',
        resultKind: 'number',
        saved: false,
        container_id: 'ghost-container', // 指向不存在的容器：不留在看不见的地方
        created: '2026-01-02T00:00:00.000Z',
        updated: '2026-01-02T00:00:00.000Z',
      },
    }
    await fsp.writeFile(calcsFilePath(ws), JSON.stringify(legacy, null, 2), 'utf-8')

    const list = await box.calcs.list()
    expect(list.map((r) => r.container_id)).toEqual([c1.id, c1.id])
    expect((await box.calcs.listContainers()).map((c) => c.id)).toEqual([c1.id, c2.id])
  })

  it('容器 Logger 注入：新建/重命名/删除各调一次 info', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const logger = new MemoryLogger()
    const svc = new CalcsService(box.workspace, logger)
    const c = await svc.createContainer({ name: '报价' })
    await svc.renameContainer({ id: c.id, name: '报价 2026' })
    await svc.removeContainer(c.id)
    const infoMsgs = logger.calls.filter((x) => x.level === 'info').map((x) => x.msg)
    expect(infoMsgs).toHaveLength(3)
    expect(infoMsgs[0]).toContain('新建')
    expect(infoMsgs[1]).toContain('重命名')
    expect(infoMsgs[2]).toContain('删除')
  })
})