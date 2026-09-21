/**
 * v2.5.9/A2 测试卫生门禁：**任何"长得像测试"的文件都必须被某个配置认领**（治 A1b 那类静默死）。
 *
 * 病灶原话：spec 被 `testIgnore` 挡住、CI 从不执行却全程绿——"看着有覆盖，其实从不跑"。
 * ⚠ 本会话差点自己再犯一次：探针命名成 `probe-clip-import.mjs.ts`，既不匹配默认套件的
 * `*.spec.ts`，也不匹配探针配置的 `probe 前缀那条 pattern` ⇒ **谁都跑不到它，而我当时以为它在跑**
 * （是 `--list` 数出来才发现）。文件名差一个后缀就静默，正说明这条得由机器守，不能靠记性。
 *
 * 三条判据（互不冗余）：
 *  ① **无孤儿**：`tests/e2e/**` 下任何含 `test(` 的 `.ts` 文件，必须被默认套件认领，
 *     或被某个替代配置的 `testMatch` 认领。两边都不认领 ⇒ 红（本条就是抓 `.mjs.ts` 那种手滑）。
 *  ② **不重复认领**：一个文件只准有一条跑法（既进默认套件又被替代配置认领 ⇒ 红，
 *     否则同一文件在两处各跑一遍，数字会骗人）。
 *  ③ **被排除的要自证**：凡不进默认套件的文件，**前 40 行内必须自证为何被排除**（头部注释或 `describe` 标题写明均可）
 *     （挡了默认套件还无人知情 = 把 A1b 的形状合法化）。
 *
 * 豁免：`tests/e2e/conformance/**` 由 `run-conformance.mjs` 独立驱动（CI 有专门一步），整目录不判。
 * 全程纯字符串运算，不起 Playwright 进程（跑一次 --list 要好几秒，不该压进 `npm test` 的反馈环）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const E2E = path.join(ROOT, 'tests', 'e2e')

/** 替代配置 = 有自己 testMatch 的那些；新增替代配置必须在这里登记（漏登记 ⇒ 其认领的文件被判孤儿，会立刻暴露） */
const ALT_CONFIGS = [
  'playwright.probe.config.ts',
  'playwright.crash-diag.config.ts',
  'playwright.memory-soak.config.ts',
]

/** 整目录豁免：由独立驱动脚本跑的套件 */
const EXEMPT_DIRS = ['conformance']

/** 把 Playwright 的 glob 子集（`**`、`*`、字面量）转成正则——够用且可被本文件反向实验验证 */
function globToRe(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000SLASHSTAR\u0000')
    .replace(/\*\*/g, '\u0000ANY\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000SLASHSTAR\u0000/g, '(?:.*/)?')
    .replace(/\u0000ANY\u0000/g, '.*')
  return new RegExp(`^${esc}$`)
}

interface Cfg {
  testIgnore: string[]
  /** 默认配置不写 testMatch ⇒ 用 Playwright 默认语义：`*.spec.ts` / `*.test.ts` */
  testMatch: string[]
}

function readConfig(file: string): Cfg {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf-8')
  const arr = (key: string): string[] => {
    const m = src.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`, 's'))
    if (!m) return []
    return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
  }
  return {
    testIgnore: arr('testIgnore'),
    testMatch: arr('testMatch').length ? arr('testMatch') : ['**/*.spec.ts', '**/*.test.ts'],
  }
}

const DEFAULT_CFG = readConfig('playwright.config.ts')
const ALT_CFG = ALT_CONFIGS.map((f) => ({ file: f, cfg: readConfig(f) }))

function specFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else if (e.name.endsWith('.ts')) {
        const body = fs.readFileSync(full, 'utf-8')
        // "长得像测试" = 出现 test(...) / test.skip(...) 调用（helpers 里没有，天然豁免）
        if (/(^|\n)\s*test(\.\w+)*\s*\(/.test(body)) out.push(path.relative(E2E, full).split(path.sep).join('/'))
      }
    }
  }
  walk(E2E)
  return out.sort()
}

const claimedByDefault = (rel: string): boolean =>
  DEFAULT_CFG.testMatch.some((g) => globToRe(g).test(rel)) &&
  !DEFAULT_CFG.testIgnore.some((g) => globToRe(g).test(rel))

const claimedByAlt = (rel: string): string[] =>
  ALT_CFG.filter(({ cfg }) => cfg.testMatch.some((g) => globToRe(g).test(rel))).map((x) => x.file)

describe('A2 · 每个 spec 都必须被某个配置认领（A1b 静默死的机器防线）', () => {
  const files = specFiles()
  /** 参与 ①②③ 判定的集合：conformance 套件由 run-conformance.mjs 独立驱动，整目录豁免 */
  const inScope = files.filter((f) => !EXEMPT_DIRS.some((d) => f === d || f.startsWith(d + '/')))

  it('样本自证：确实扫到了足量 spec（扫到 0 个 = 本门禁自己是假的）', () => {
    expect(files.length, `tests/e2e 下应扫到大量含 test() 的文件，实得 ${files.length}`).toBeGreaterThan(40)
    // 反向实验的靶子形状必须先存在：有一个文件被 testIgnore 里的 probe 模式挡住
    expect(files.filter((f) => /^probe-.*\.spec\.ts$/.test(f)).length, 'probe-* 样本存在').toBeGreaterThan(0)
  })

  it('① 无孤儿：每个 spec 至少有 1 条明确跑法', () => {
    const orphans = inScope.filter((f) => !claimedByDefault(f) && claimedByAlt(f).length === 0)
    expect(
      orphans,
      `这些文件谁都跑不到（默认套件不匹配 + 没有任何替代配置认领）：${orphans.join(', ')}。` +
        `修法二选一：改名为 *.spec.ts 让默认套件认领，或在某个替代配置的 testMatch 里登记它。`,
    ).toEqual([])
  })

  it('② 不重复认领：进默认套件的就不能又被替代配置跑一遍', () => {
    const twice = inScope.filter((f) => claimedByDefault(f) && claimedByAlt(f).length > 0)
    expect(twice, `这些文件会被两套配置各跑一次，计数会虚高：${twice.join(', ')}`).toEqual([])
  })

  it('③ 被排除出默认套件的文件，必须自证为何被排除', () => {
    const undocumented = inScope.filter((f) => {
      if (claimedByDefault(f)) return false
      // 自证可以写在两处：头部注释，或 `describe/test` 标题里（本仓探针的传统写法是
      // 「xxx（probe，不入默认套件）」——那已经在知情位置上了。判据要的是"有人知情"，不是"必须第一行"。
      const head = fs.readFileSync(path.join(E2E, f), 'utf-8').split('\n').slice(0, 40).join('\n')
      return !/(^|\n)\s*(\/\*|\/\/)/.test(head) && !/不入默认套件|probe|soak|取证|走查|诊断|testIgnore/.test(head)
    })
    expect(
      undocumented,
      `不进默认套件却没有说明注释（挡了 CI 还无人知情）：${undocumented.join(', ')}`,
    ).toEqual([])
  })

  it('④ 配置面自证：testIgnore 的四条模式都真在挡东西（防止"以为被挡、其实没挡"）', () => {
    for (const g of DEFAULT_CFG.testIgnore) {
      const hit = files.filter((f) => globToRe(g).test(f))
      expect(hit.length, `testIgnore 里的 ${g} 一个文件都没挡住——要么它已失效该删，要么语义与我预期不同`).toBeGreaterThan(0)
    }
    // 探针与两个专项套件**必须**被默认套件挡住：这条反向守卫防"有人手滑把 testIgnore 删了"
    for (const f of files.filter((x) => /^probe-.*\.spec\.ts$/.test(x))) {
      expect(claimedByDefault(f), `${f} 竟会进 CI 默认套件（探针须人工判读，不该自动跑）`).toBe(false)
    }
  })
})
