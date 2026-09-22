/**
 * 计算台账服务单测（v2.5.9/A7；权威 = 内部计算设计文档（不进公开仓）§三 对象模型与存储）
 * 覆盖：落账默认值（saved=false / created=updated / 可选字段缺省）/ 入参校验（含类型面）/
 * 列表顺序（先记的在先）/ update 补丁语义（title·note·saved 互不打扰、'' 清空、undefined 不动）/
 * 取消标记（saved true→false）/ 未知 id 与原型链假 id（`__proto__` / `toString`）拒绝 / remove / 持久化（重开工作区仍在）/
 * 工作区隔离（各自 calcs.json）/ 损坏文件拒绝覆盖（jsonStore 守卫）/
 * Logger 注入（add/update/remove 各调一次 info）。
 */
import { describe, it, expect } from 'vitest'
import { buildTestBox } from './helpers'
import { CalcsService } from '../../src/main/core/calcs'
import { MemoryLogger } from '../../src/main/core/logger'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { CalcRecord } from '../../src/shared/types'

function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-calcs-'))
}

function calcsFilePath(ws: string): string {
  return path.join(ws, '.qihefilemanager', 'calcs.json')
}

async function readCalcsFile(ws: string): Promise<Record<string, CalcRecord>> {
  return JSON.parse(await fsp.readFile(calcsFilePath(ws), 'utf-8'))
}

const REQ = { expression: '(3200 + 380) × 1.15', result: '4,117.00', resultKind: 'number' as const }

describe('计算台账服务（v2.5.9/A7）', () => {
  it('落账与默认值：saved=false、created=updated、title/note 缺省、id 非空', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const rec = await box.calcs.add(REQ)
    expect(rec.id).toBeTruthy()
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

    await expect(box.calcs.add({ ...REQ, expression: '   ' })).rejects.toThrow('算式')
    await expect(box.calcs.add({ ...REQ, result: ' ' })).rejects.toThrow('结果')
    await expect(
      box.calcs.add({ ...REQ, resultKind: 'nope' as unknown as 'number' }),
    ).rejects.toThrow('resultKind')
    // 校验失败不落账（文件不产生）
    await expect(fsp.stat(calcsFilePath(ws))).rejects.toThrow()
  })

  it('列表顺序：先记的在先（时间流按录入顺序）', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const a = await box.calcs.add({ expression: '1 + 1', result: '2.00', resultKind: 'number' })
    const b = await box.calcs.add({ expression: '2 × 3', result: '6.00', resultKind: 'number' })
    const c = await box.calcs.add({ expression: '2026-09-16 + 60', result: '2026-11-15', resultKind: 'date' })
    const list = await box.calcs.list()
    expect(list.map((r) => r.id)).toEqual([a.id, b.id, c.id])
  })

  it('update 补丁语义：title/note/saved 各自独立；空串清空；undefined 不动；created 不变', async () => {
    const home = await tmp()
    const ws = await tmp()
    const box = buildTestBox(home)
    await box.workspace.create(ws)

    const rec = await box.calcs.add(REQ)
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
    const rec = await box.calcs.add(REQ)

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

    const rec = await box.calcs.add(REQ)
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
    const rec = await box.calcs.add(REQ)

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
    await box.calcs.add(REQ)

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
    await expect(box.calcs.add(REQ)).rejects.toThrow()
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
    const rec = await svc.add(REQ)
    await svc.update({ id: rec.id, saved: true })
    await svc.remove(rec.id)
    const infoMsgs = logger.calls.filter((c) => c.level === 'info').map((c) => c.msg)
    expect(infoMsgs).toHaveLength(3)
    expect(infoMsgs[0]).toContain('记一条')
    expect(infoMsgs[1]).toContain('更新')
    expect(infoMsgs[2]).toContain('删除')
  })
})