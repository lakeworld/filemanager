/**
 * Windows 平台分支清单门禁（W0 防复发，2026-09-08 Windows 测试约定 Task 1）
 *
 * 守两件事：
 *   1. **点位一致**：源码里的平台点位集合 === 基线（新增/删除/改类别都要显式 `npm run win:update`）
 *   2. **新点位必须带测试**：win32-branch / path-win32 两类点位若没有任何测试引用其模块（UNCOVERED）→ 红
 *
 * 机制与 tests/unit/plugins-api-surface.test.ts 同构（同一套 update/break 环境变量约定）。
 * 背景：win32 分支在 Linux 宿主上永不执行，过去全靠「发版后真机挂账」——见内部 Windows 测试守则。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  BASELINE_PATH,
  collectWinSites,
  isEnforced,
  serializeSites,
  type WinSite,
} from './helpers/winBranches'

const WIN_UPDATE = process.env.WIN_UPDATE === '1'
const WIN_BREAK = process.env.WIN_BREAK === '1'
const WIN_BREAK_REASON = process.env.WIN_BREAK_REASON || ''

/** 只比较点位行（`- ` 开头），头注释不参与 */
function siteLines(text: string): string[] {
  return text.split('\n').filter((l) => l.startsWith('- '))
}

function readBaseline(): string {
  if (!fs.existsSync(BASELINE_PATH)) return ''
  // break-reason 头是人工豁免记录、不参与点位比较（比较两侧恒等即可，actual 侧永不产出该行）
  return fs
    .readFileSync(BASELINE_PATH, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('<!-- break-reason:'))
    .join('\n')
}

/** 增/删/改摘要：按「文件:行 | 类别」为标识对齐（行内容里的覆盖测试变化也算改） */
function formatDiff(baseline: string, actual: string): string {
  const b = siteLines(baseline)
  const a = siteLines(actual)
  const keyOf = (l: string) => l.split(' | ').slice(0, 2).join(' | ')
  const bMap = new Map(b.map((l) => [keyOf(l), l]))
  const aMap = new Map(a.map((l) => [keyOf(l), l]))
  const added = a.filter((l) => !bMap.has(keyOf(l)))
  const removed = b.filter((l) => !aMap.has(keyOf(l)))
  const changed = a.filter((l) => bMap.has(keyOf(l)) && bMap.get(keyOf(l)) !== l)
  const sec = (title: string, lines: string[]) =>
    lines.length ? `${title}（${lines.length}）\n${lines.map((l) => '    ' + l).join('\n')}` : `${title}（0）`
  return [sec('新增点位', added), sec('消失点位', removed), sec('变更点位', changed)].join('\n  ')
}

function uncovered(sites: WinSite[]): WinSite[] {
  return sites.filter((s) => isEnforced(s.kind) && s.coveredBy.length === 0)
}

describe('Windows 平台分支清单基线', () => {
  const sites = collectWinSites()
  const actual = serializeSites(sites)

  it('清单与基线逐行一致（变更须经 npm run win:update 显式落盘）', () => {
    const baseline = readBaseline()
    if (WIN_UPDATE) {
      const bad = uncovered(sites)
      if (bad.length && !WIN_BREAK) {
        throw new Error(
          `[win:update] 拒绝写入：${bad.length} 个强制点位无测试覆盖\n` +
            bad.map((s) => `    ${s.file}:${s.line} (${s.kind}) → ${s.text}`).join('\n') +
            '\n  处置：为该模块补一个单测（被 tests/unit 引用即算覆盖），' +
            '或确属不可单测面时 WIN_BREAK=1 WIN_BREAK_REASON=<原因> npm run win:update（原因入基线头）。',
        )
      }
      const reason = bad.length && WIN_BREAK ? `<!-- break-reason: ${WIN_BREAK_REASON || '（未填写）'} -->\n` : ''
      fs.writeFileSync(BASELINE_PATH, reason + actual)
      console.log(`[win:update] 已写入基线：${sites.length} 个点位（UNCOVERED ${bad.length}）`)
      return
    }
    expect(baseline, `\n  ${formatDiff(baseline, actual)}`).toBe(actual)
  })

  it('强制点位（win32-branch / path-win32）全部有测试引用', () => {
    const bad = uncovered(sites)
    expect(
      bad.map((s) => `${s.file}:${s.line} (${s.kind}) ${s.text}`),
      `以下 Windows 平台点位没有任何单测引用其模块（在 tests/unit 里 import 该模块或做源码文本锚即算覆盖）：\n${bad
        .map((s) => `  - ${s.file}:${s.line} [${s.kind}] ${s.text}`)
        .join('\n')}`,
    ).toEqual([])
  })

  it('确实扫到了平台点位（防空清单假绿：扫描器或路径规则被改坏时该报红）', () => {
    expect(sites.length).toBeGreaterThanOrEqual(8)
    expect(sites.some((s) => s.file.includes('explorer.ts'))).toBe(true)
    expect(sites.some((s) => s.file.includes('clipboard.ts'))).toBe(true)
    expect(sites.some((s) => s.file.includes('window.ts'))).toBe(true)
    expect(sites.some((s) => s.file.includes('open.ts'))).toBe(true)
    expect(sites.some((s) => s.file.includes('autoLaunchMain.ts'))).toBe(true)
  })
})
