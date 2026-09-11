/**
 * 测试临时产物卫生机制的门禁（2026-09-10 卫生批）
 *
 * 治的是什么：`tests/helpers/tmpNames.ts`（前缀解析 + 清扫判定）是**所有**测试临时目录/散文件的
 * 唯一收口点，它一旦腐烂（解析正则失配、判定条件被改松），残留会静默回到「每跑一次漏一批」的老路
 * ——本仓实测一次全量 e2e 后 `/tmp` 剩 15 项、历史上积到 46,151 个目录 / 676MB。
 * 所以这里钉四件事：① 两种命名写法（`mkdtemp` 字面量、`os.tmpdir()` 模板字符串）都要解析到前缀；
 * ② 本轮窗口内的目录**和散文件**都删；③ 陈旧产物只有带本仓所有权标记才删；
 * ④ 陈旧且无所有权标记的**绝不删**（那是「可能属于别人」的边界，放宽就是越界删文件）。
 * 第 ⑤ 条把（本文件与 e2e 不并发跑，见 tmpCleanup 头注释同一前提）「每个 playwright 配置必须挂收尾」变成机器把关——新增配置忘了挂会红在这里，
 * 而不是红在下一次 `/tmp` 满盘。
 *
 * 口径权威：`tests/helpers/tmpNames.ts` 与 `tests/e2e/helpers/tmpCleanup.ts` 文件头注释。
 * 本测试自建的 fixture 目录走 `mkdtemp`，由中央兜底（tmpTracker）负责清理，无需自写收尾。
 */
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import tmpCleanupSetup from '../e2e/helpers/tmpCleanup'
import { collectTmpPrefixes, sweepTmpEntries } from '../../tests/helpers/tmpNames'

const REPO_ROOT = path.resolve(__dirname, '..', '..')

/** 把产物 mtime 改成很久以前，模拟「上一轮崩溃留下的死残」 */
function makeStale(target: string): void {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  fsSync.utimesSync(target, old, old)
}

describe('测试临时产物卫生机制（tmpNames 解析与清扫）', () => {
  it('① 两种命名写法都能解析出前缀（mkdtemp 字面量 + tmpdir 模板字符串）', () => {
    const src = fsSync.mkdtempSync(path.join(os.tmpdir(), 'qihebox-hygienetest-src-'))
    fsSync.writeFileSync(
      path.join(src, 'a.spec.ts'),
      [
        `const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-fixture-a-'))`,
        'const out = path.join(os.tmpdir(), `qihebox-fixture-b-${Date.now()}.jpg`)',
        `const userData = path.join(os.tmpdir(), e2eUserDataDirName('fixture'))`,
        // 噪声行：非临时产物用途的字面量，不该进前缀集
        `expect(box.metadata.fileMetadataKey(path.join(os.tmpdir(), 'x.jpg'))).toBe('')`,
      ].join('\n'),
    )
    fsSync.mkdirSync(path.join(src, 'nested'), { recursive: true })
    fsSync.writeFileSync(
      path.join(src, 'nested', 'b.ts'),
      `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-fixture-c-'))`,
    )

    const prefixes = collectTmpPrefixes([src])
    expect(prefixes).toContain('qihebox-fixture-a-')
    expect(prefixes).toContain('qihebox-fixture-b-') // B 类：时间戳命名的散文件
    expect(prefixes).toContain('qihebox-fixture-c-') // 递归子目录也要扫到
    expect(prefixes).not.toContain('x.jpg') // 无 `-` 结尾的纯字面量不入集合
  })

  it('②③ 清扫判定：本轮目录+散文件都删；陈旧仅所有权标记者删；陈旧无标记者不删', () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'qihebox-hygienetest-sweep-'))
    const prefixes = ['qihebox-owned-', 'genericname-']

    const mk = (name: string, isDir: boolean): string => {
      const p = path.join(root, name)
      if (isDir) fsSync.mkdirSync(p, { recursive: true })
      else fsSync.writeFileSync(p, 'x')
      return p
    }
    // 本轮产物（mtime = now，落在窗口内）
    const freshDir = mk('qihebox-owned-freshdir', true)
    const freshFile = mk('genericname-freshfile.pdf', false)
    // 陈旧产物（mtime 拨到 3 天前）：所有权标记者应删，通用名者必须留
    const staleOwned = mk('qihebox-owned-staledir', true)
    makeStale(staleOwned)
    const staleGeneric = mk('genericname-stale.pdf', false)
    makeStale(staleGeneric)
    // 完全不相关的名（即便很新也不许碰）
    const foreign = mk('not-ours-at-all', false)

    const run = (): ReturnType<typeof sweepTmpEntries> =>
      sweepTmpEntries({ prefixes, runStartMs: Date.now() - 60_000, root })

    const res = run()
    expect(fsSync.existsSync(freshDir)).toBe(false)
    expect(fsSync.existsSync(freshFile)).toBe(false)
    expect(fsSync.existsSync(staleOwned)).toBe(false)
    expect(fsSync.existsSync(staleGeneric)).toBe(true) // 安全边界：陈旧 + 无所有权 = 不删
    expect(fsSync.existsSync(foreign)).toBe(true)
    expect(res.dirs).toBe(2)
    expect(res.files).toBe(1)
    expect(res.stale).toBe(1)
    expect(res.failed).toEqual([])
    // 幂等：再扫一遍不应重复计数，也不该把留下的删掉
    const again = run()
    expect(again.dirs).toBe(0)
    expect(again.files).toBe(0)
    expect(fsSync.existsSync(staleGeneric)).toBe(true)
  })

  it('⑤ 每个 playwright 配置都必须挂临时产物收尾（新增配置漏挂即红）', async () => {
    const configs = fsSync
      .readdirSync(REPO_ROOT)
      .filter((f) => /^playwright.*\.config\.ts$/.test(f))
      .sort()
    expect(configs.length).toBeGreaterThanOrEqual(2) // 至少默认 + soak
    for (const f of configs) {
      const src = fsSync.readFileSync(path.join(REPO_ROOT, f), 'utf8')
      expect(src, `${f} 必须挂 globalSetup: './tests/e2e/helpers/tmpCleanup.ts'`).toContain(
        `globalSetup: './tests/e2e/helpers/tmpCleanup.ts'`,
      )
    }
  })

  it('tmpCleanup 端到端：清掉本轮 userData 目录与散文件，留下无关项', async () => {
    // 用真实 tmpdir（teardown 的清扫根）构造；本轮窗口内的产物按定义可删
    const mine = 'hygienetest-run'
    const fakeUserData = path.join(os.tmpdir(), `qihebox-e2e-${mine}`)
    const marker = path.join(os.tmpdir(), `qihebox-e2e-${mine}.d.txt`)
    const unrelated = path.join(os.tmpdir(), 'qihebox-e2e-somebody-else-keeping-this')
    const teardown = await tmpCleanupSetup({
      projects: [{ testDir: path.join(REPO_ROOT, 'tests', 'e2e') }],
    })
    // 顺序照实：Playwright 先跑 globalSetup（记下开跑时刻），worker 才开始建产物。
    // 反过来先建再 setup，产物就落在窗口外（实测如此踩到一次：判定为「非本轮」而留下不删）。
    fsSync.mkdirSync(fakeUserData, { recursive: true })
    fsSync.writeFileSync(marker, 'x')
    fsSync.mkdirSync(unrelated, { recursive: true })
    fsSync.writeFileSync(path.join(fakeUserData, 'account.json'), '{}')
    teardown()

    expect(fsSync.existsSync(fakeUserData)).toBe(false)
    expect(fsSync.existsSync(marker)).toBe(false)
    // 同前缀且本轮新建的目录一并收掉（teardown 语义：整套跑完不留 e2e userData）
    expect(fsSync.existsSync(unrelated)).toBe(false)
  })
})
