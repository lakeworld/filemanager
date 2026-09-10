/**
 * 单测临时目录兜底清理（2026-09-10 卫生批，v2.5.x）
 *
 * 治的是什么：全仓 167 处 `fsp.mkdtemp` / `fs.mkdtempSync` 分散在 87 个测试文件里，
 * **建完不删**——`/tmp` 里积出 46,151 个 `qihebox-*` 目录 / 676MB（每跑一次全量漏一批）。
 * 挨个改 87 个文件既吵又容易漏，且挡不住以后新写的用例，所以在这里**一处收口**：
 * setup 文件先于测试模块加载，包住 `mkdtemp` / `mkdtempSync`，把本轮创建的目录登记进
 * worker 清单，`afterAll`（每个测试文件结束时）删除——粒度按文件，不破坏
 * 「`beforeAll` 建目录、多个 `it` 复用」的既有用法。
 *
 * 只删**自己创建过的绝对路径**，不做模式猜测；且必须位于 `os.tmpdir()` 之下才删。
 * worker 中途崩掉导致 afterAll 没跑到的，由 `tmpGuard.ts`（globalSetup teardown）按清单补扫。
 * 新增测试无需自写清理，直接 `fsp.mkdtemp(...)` 即被登记（本文件头注释即口径来源）。
 */
import { afterAll } from 'vitest'
import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 清单目录名固定，worker 各写一个 `<pid>.txt`（避免并发追加串写）；teardown 读完整目录后一并删除 */
export const TMP_MANIFEST_DIR = path.join(os.tmpdir(), 'qihebox-test-manifests')

const tmpRoot = fsSync.realpathSync(os.tmpdir())
/** 本文件内创建过的目录（afterAll 删除后清空，防同文件多钩子重复删） */
const createdHere = new Set<string>()

function record(dir: unknown): void {
  if (typeof dir !== 'string') return // mkdtemp 传 encoding 时返回 Buffer，本仓无此用法，保守跳过
  createdHere.add(dir)
  try {
    fsSync.mkdirSync(TMP_MANIFEST_DIR, { recursive: true })
    fsSync.appendFileSync(path.join(TMP_MANIFEST_DIR, `${process.pid}.txt`), dir + '\n')
  } catch {
    // 清单写失败不影响测试本身：afterAll 仍会删本文件创建的目录
  }
}

/** 只删「自己登记过」且「确在系统临时目录下」的路径，两道闸都不满足就留着不动 */
function removeRecorded(): void {
  for (const dir of createdHere) {
    createdHere.delete(dir)
    const real = safeReal(dir)
    if (!isUnderTmp(real)) continue
    try {
      fsSync.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      // 清理失败不判红测试，但必须出声——静默正是这次要治的病
      console.warn(`[tmpTracker] 临时目录清理失败（保留在盘上）: ${dir} — ${(err as Error).message}`)
    }
  }
}

function safeReal(p: string): string {
  try {
    return fsSync.realpathSync(p)
  } catch {
    return p
  }
}

function isUnderTmp(abs: string): boolean {
  const rel = path.relative(tmpRoot, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

const promisesMkdtemp = fsp.mkdtemp.bind(fsp)
const fsMkdtemp = fsSync.mkdtemp.bind(fsSync)
const fsMkdtempSync = fsSync.mkdtempSync.bind(fsSync)

// fsp / fs 的默认导出是可写普通对象（本仓 167 处调用全部走属性访问，无解构导入），
// 因此属性替换对后续 import 的测试模块生效。
;(fsp as { mkdtemp: unknown }).mkdtemp = async (...args: Parameters<typeof promisesMkdtemp>) => {
  const dir = await promisesMkdtemp(...args)
  record(dir)
  return dir
}
;(fsSync as { mkdtemp: unknown }).mkdtemp = (...args: Parameters<typeof fsMkdtemp>) => {
  const dir = fsMkdtemp(...args)
  record(dir)
  return dir
}
;(fsSync as { mkdtempSync: unknown }).mkdtempSync = (...args: Parameters<typeof fsMkdtempSync>) => {
  const dir = fsMkdtempSync(...args)
  record(dir)
  return dir
}

afterAll(removeRecorded)
