/**
 * e2e 临时产物收尾（中央兜底，新增 spec 无需自写清理）：
 * e2e 每跑一轮往 tmpdir 撒两类产物——① 每次 launch 的 Electron userData 目录
 * `qihebox-e2e-<label>/`（含隔离的 logs/，见 `launch.ts`）；② spec 自建的临时 workspace 与
 * 时间戳命名的散文件（`qihebox-perf-e2e-*`、`qihebox-outside-<ts>.png`、`sel-inv-<ts>.pdf` 等，
 * 前缀由 spec 自己定，数量比 ① 多得多——收尾初版只认 ① 的前缀，一轮全量后 `/tmp` 仍剩 15 项，
 * 就是这个口径太窄被抓出来的）。
 *
 * 挂在 4 个 `playwright.*.config.ts` 的 **globalSetup** 上：装载时以 Playwright 传入的
 * `config.projects[].testDir` 解析前缀并记下开跑时刻，整套跑完后 Playwright 调用返回的收尾函数——
 * 前缀**从 `tests/e2e` 源码现算**（mkdtemp 与模板字符串两类命名都解析），判定两分支：
 * 本轮窗口内直接删；本轮之前需「停更 ≥10 分钟且带本仓所有权标记」
 * （后者专收死残，例如 memory-soak 跑一半被杀，单轮 userData 可上 G）。
 *
 * 删除失败只打印不判红：收尾是卫生工作，不能把测试结果带崩。
 * 不碰的：探针给人看的产物目录（`v257-shots` / `v258-time-fields` 这类无插值纯字面量，
 * 解析器故意不认——删了等于抹走查证据）。
 */
import path from 'node:path'

import { collectTmpPrefixes, sweepTmpEntries } from '../../helpers/tmpNames'
import { E2E_USERDATA_PREFIX } from './launch'

/** 只用到 `projects[].testDir` 一项，声明成结构性类型（便于单测直接调用，无需伪造 FullConfig） */
export interface TmpCleanupConfig {
  projects: { testDir: string }[]
}

/**
 * 注意：Playwright 的 setup/teardown 文件由它自己的转译器加载，**没有 `__dirname`**
 * （1.62 实测 `ReferenceError: __dirname is not defined`，且因为挂在 globalSetup 上，
 * 一抛就是整套 e2e 直接中止、0 个用例没跑）。仓库根一律从 Playwright 传进来的
 * `config.projects[].testDir`（= `<root>/tests/e2e`）反推，不靠 `process.cwd()`。
 */
export default async function tmpCleanupSetup(config: TmpCleanupConfig): Promise<() => void> {
  const testDir = config.projects[0]?.testDir ?? path.join(process.cwd(), 'tests', 'e2e')
  const prefixes = [...collectTmpPrefixes([testDir]), E2E_USERDATA_PREFIX].sort()
  // 下界留 1 秒余量：文件系统 mtime 向下取整，实测刚建的目录 mtimeMs 可比 Date.now() 早约 5ms，
  // 不留余量则「本轮产物」判定会漏掉刚建的东西（该 bug 由 tmpHygiene.test.ts 端到端那条抓到）
  const startedAt = Date.now() - 1000
  if (prefixes.length === 0) {
    console.warn('[tmpCleanup] 未从 tests/e2e 解析到任何临时产物前缀，收尾已失效——检查 tests/helpers/tmpNames.ts 的解析正则')
  }

  return function teardown(): void {
    const sweep = sweepTmpEntries({ prefixes, runStartMs: startedAt })
    if (sweep.failed.length > 0) {
      console.warn(`[tmpCleanup] ${sweep.failed.length} 项清理失败（忽略）：\n  ${sweep.failed.slice(0, 10).join('\n  ')}`)
    }
    console.log(
      `[tmpCleanup] 已清理 e2e 临时产物 目录 ${sweep.dirs} / 文件 ${sweep.files}（前缀 ${prefixes.length} 个${sweep.stale ? `，其中陈旧死残 ${sweep.stale} 项` : ''}）`,
    )
  }
}
