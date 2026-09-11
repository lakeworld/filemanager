/**
 * 单测临时目录终局清扫（2026-09-10 卫生批，与 `setup/tmpTracker.ts` 配对）
 *
 * 两层防漏，缺一不可：
 *  1) **清单精确删**：`tmpTracker` 把每个它拦到的 `mkdtemp` 结果写进清单（worker 各一文件），
 *     这里按清单删——路径是"我创建的"，最准；worker 中途被杀导致文件级 afterAll 没跑到时靠它。
 *  2) **前缀补扫**：tracker 拦不全——`vi.mock('node:fs/promises', { spy: true })` 的
 *     文件（如 `jsonStore.test.ts`）拿到的是被替换的模块，`import * as fsp` 又是冻结命名空间，
 *     外部替换不了属性。这类产物按**前缀**扫。前缀与清扫判定都不写死在本文件里，
 *     统一走 `tests/helpers/tmpNames.ts`（从测试源码现算 A 类 mkdtemp + B 类模板字符串两种前缀，
 *     删除判定含「本轮窗口」与「停更 ≥10 分钟且带本仓所有权标记」两分支），
 *     所以新增用例改了前缀不需要回来维护清单；**解析范围刻意不含 `tests/e2e`**——
 *     e2e 侧的清理走 playwright 自己的 teardown（`tests/e2e/helpers/tmpTeardown.ts`）。
 */
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectTmpPrefixes, sweepTmpEntries } from '../../helpers/tmpNames'

const MANIFEST_DIR = path.join(os.tmpdir(), 'qihebox-test-manifests')
const tmpRoot = fsSync.realpathSync(os.tmpdir())
const ROOT = path.resolve(__dirname, '..', '..', '..')

function underTmp(abs: string): boolean {
  const rel = path.relative(tmpRoot, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function removeDir(dir: string): boolean {
  try {
    fsSync.rmSync(dir, { recursive: true, force: true })
    return !fsSync.existsSync(dir)
  } catch {
    return false
  }
}

export default async function tmpGuardSetup(): Promise<() => void> {
  // 解析范围刻意只到单测/压测两处（e2e 由自己的 teardown 收尾），见文件头注释
  const prefixes = collectTmpPrefixes([path.join(ROOT, 'tests', 'unit'), path.join(ROOT, 'tests', 'bench')])
  // 时间窗下界取"开跑前 1 秒"：本轮创建的产物 mtime 必然晚于它；同时给时钟粒度留余量
  const startedAt = Date.now() - 1000
  fsSync.rmSync(MANIFEST_DIR, { recursive: true, force: true })
  fsSync.mkdirSync(MANIFEST_DIR, { recursive: true })
  if (prefixes.length === 0) {
    console.warn('[tmpGuard] 未从 tests/ 解析到任何临时产物前缀，补扫层已失效——检查 tests/helpers/tmpNames.ts 的解析正则是否还合用')
  }

  return function teardown(): void {
    const failed: string[] = []

    // 第 1 层：清单精确删
    try {
      for (const f of fsSync.readdirSync(MANIFEST_DIR)) {
        const lines = fsSync.readFileSync(path.join(MANIFEST_DIR, f), 'utf8').split('\n').filter(Boolean)
        for (const dir of lines) {
          if (!fsSync.existsSync(dir)) continue
          if (!underTmp(fsSync.realpathSync(dir))) {
            console.warn(`[tmpGuard] 清单路径不在系统临时目录下，拒绝删：${dir}`)
            continue
          }
          if (!removeDir(dir)) failed.push(dir)
        }
      }
    } catch {
      /* 清单目录不存在 = tracker 一次都没写，正常 */
    }
    fsSync.rmSync(MANIFEST_DIR, { recursive: true, force: true })

    // 第 2 层：前缀补扫（抓 tracker 拦不到的 spy/mock 冻结模块，以及时间戳命名的散文件）
    const sweep = sweepTmpEntries({ prefixes, runStartMs: startedAt })
    failed.push(...sweep.failed)
    if (sweep.failed.length > 0) {
      console.warn(`[tmpGuard] ${sweep.failed.length} 个临时产物未能删除（不判红测试，但必须出声）：\n  ${sweep.failed.slice(0, 10).join('\n  ')}`)
    }
    if (sweep.dirs + sweep.files > 0) {
      console.log(`[tmpGuard] 补扫掉 tracker 拦不到的临时产物 目录 ${sweep.dirs} / 文件 ${sweep.files}${sweep.stale ? `（其中陈旧死残 ${sweep.stale} 个）` : ''}`)
    }
  }
}
