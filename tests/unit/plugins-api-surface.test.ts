/**
 * API 兼容性守护（v2.5，Task 1 / PLAN-v2.5-测试.md §三.A）。
 *
 * 守护插件协议公开面「只增不删」（API_VERSION=1）：
 *   - 常规：extractApiSurface() 序列化 === 基线文件内容；不一致 → 行级 diff 摘要。
 *   - API_UPDATE=1：读旧基线 → 超集强制（新符号集合 ⊇ 旧符号集合）；任何旧符号消失 → 拒绝写回 + diff；
 *     超集通过 → 写回基线。API_FORCE_BREAK=1 + BREAK_REASON=<原因> → 跳过超集强制并写回（原因入头注释）。
 *   - preload/ipc 源码包含性断言（防清单凭空增删）。
 */
import { describe, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  extractApiSurface,
  serialize,
  assertPreloadManifestMatchesSource,
  assertIpcManifestMatchesSource,
  BASELINE_PATH,
} from './helpers/apiSurface'

const API_UPDATE = process.env.API_UPDATE === '1'
const FORCE_BREAK = process.env.API_FORCE_BREAK === '1'
const BREAK_REASON = process.env.BREAK_REASON || ''

function readBaseline(): string {
  return fs.existsSync(BASELINE_PATH) ? fs.readFileSync(BASELINE_PATH, 'utf8') : ''
}

/** 序列化内容里的符号行（`- xxx`），超集强制按符号行集合比较。 */
function symbolLines(content: string): string[] {
  return content
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))
}

function readBreakReason(content: string): string {
  const m = content.match(/break-reason:\s*(.+)$/m)
  return m ? m[1].trim() : '（无）'
}

/** 行级 diff 摘要：只列基线独有（消失）与实际独有（新增/变更）行。 */
function formatDiff(baseline: string, actual: string): string {
  const a = baseline.split('\n')
  const b = actual.split('\n')
  const aSet = new Set(a)
  const bSet = new Set(b)
  const onlyBaseline = a.filter((l) => !bSet.has(l))
  const onlyActual = b.filter((l) => !aSet.has(l))
  const parts: string[] = [`基线 ${a.length} 行 vs 实际 ${b.length} 行：`]
  if (onlyBaseline.length) parts.push(`—— 基线独有（消失）——\n${onlyBaseline.map((l) => `  - ${l}`).join('\n')}`)
  if (onlyActual.length) parts.push(`—— 实际独有（新增/变更）——\n${onlyActual.map((l) => `  + ${l}`).join('\n')}`)
  return parts.join('\n\n')
}

describe('preload / ipc 清单与源码包含性', () => {
  it('preload 清单方法名与 src/preload/index.ts 定义一致（防凭空增删）', () => {
    assertPreloadManifestMatchesSource()
  })

  it('ipc 清单通道名与源码注册/调用一致（防凭空增删）', () => {
    assertIpcManifestMatchesSource()
  })
})

describe('API surface 基线（types / preload / ipc）', () => {
  if (API_UPDATE) {
    it('API_UPDATE：超集强制（只增不删）后写回基线', () => {
      const oldContent = readBaseline()
      const surface = extractApiSurface()
      const oldSymbols = new Set(symbolLines(oldContent))
      const newSymbols = new Set(symbolLines(serialize(surface, '（无）')))

      if (FORCE_BREAK) {
        const reason = BREAK_REASON || '（无）'
        fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
        fs.writeFileSync(BASELINE_PATH, serialize(surface, reason), 'utf8')
        return
      }

      const missing = [...oldSymbols].filter((s) => !newSymbols.has(s)).sort()
      if (missing.length > 0) {
        throw new Error(
          `API surface 超集强制失败：${missing.length} 个旧符号消失（只增不删）：\n\n` +
            missing.map((m) => `  - ${m}`).join('\n') +
            '\n\n如需破坏性变更，用 API_FORCE_BREAK=1 BREAK_REASON=<原因> npm run api:update 显式声明。',
        )
      }

      const reason = readBreakReason(oldContent)
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
      fs.writeFileSync(BASELINE_PATH, serialize(surface, reason), 'utf8')
    })
  } else {
    it('extractApiSurface() 序列化 === 基线文件内容', () => {
      const baseline = readBaseline()
      if (!baseline) {
        throw new Error(`基线缺失：${BASELINE_PATH}\n先运行 npm run api:update 生成。`)
      }
      const surface = extractApiSurface()
      const actual = serialize(surface, readBreakReason(baseline))
      if (actual !== baseline) {
        throw new Error(`API surface 与基线不一致：\n\n${formatDiff(baseline, actual)}`)
      }
    })
  }
})
