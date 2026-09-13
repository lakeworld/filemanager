/**
 * v2.5.8 D18（预览连续切换）：导航判定逻辑的单测。
 *
 * 权威 = `docs/INTERNAL/PLAN-v2.5.8-预览连续切换与体验盘点.md` §三 D1/D4 + §六。
 * 边界语义 2026-09-13 用户拍板 #1：**循环绕回**（最后一张再按 → 回第一张），不是「到头停 + 禁用按钮」。
 *
 * 为什么测的是 `lib/previewNav.ts` 而不是 `stores/preview.ts`：
 * 本仓单测跑在 `environment: 'node'` 且 **vitest 没配 `~` 别名**（只有 `electron.vite.config.ts:32` 配了），
 * 而 `stores/preview.ts:2` 就 import `~/wails/api`（该模块顶层读 `window.qihebox`）。
 * 所以按 `lib/selectionBar.ts`、`lib/searchSelect.ts` 同一分层口径办：
 * **「算哪一张」是可测纯函数住 lib，「怎么换」的异步链住 store**。
 * store 那半边（代际递增 / 会话复位 / 元数据重载）由 e2e 真链覆盖
 * （`tests/e2e/preview-nav.spec.ts` 例 4「连按 5 次终态为最后一张」）。
 */
import { describe, it, expect } from 'vitest'
import {
  previewIndexOf,
  nextPreviewIndex,
  canPreviewNav,
  previewPositionLabel,
  planPreviewNav,
} from '../../src/renderer/src/lib/previewNav'

const entry = (path: string) => ({
  name: path.split('/').pop() as string,
  path,
  size: 10,
  modified: '2026-09-13',
  file_type: 'image',
  thumbnail_path: null,
})

const A = entry('/ws/a.jpg')
const B = entry('/ws/b.jpg')
const C = entry('/ws/c.jpg')
const LIST = [A, B, C]

describe('previewIndexOf（当前项在列表快照里的下标）', () => {
  it('按 path 命中', () => {
    expect(previewIndexOf(LIST, '/ws/a.jpg')).toBe(0)
    expect(previewIndexOf(LIST, '/ws/c.jpg')).toBe(2)
  })

  it('未传列表 / 空列表 / 未传当前路径 ⇒ -1（没有快照这回事）', () => {
    expect(previewIndexOf(undefined, '/ws/a.jpg')).toBe(-1)
    expect(previewIndexOf(null, '/ws/a.jpg')).toBe(-1)
    expect(previewIndexOf([], '/ws/a.jpg')).toBe(-1)
    expect(previewIndexOf(LIST, undefined)).toBe(-1)
    expect(previewIndexOf(LIST, '')).toBe(-1)
  })

  it('当前文件不在列表里 ⇒ -1（预览期间被外部改名/删除 = 快照过期）', () => {
    expect(previewIndexOf(LIST, '/ws/gone.jpg')).toBe(-1)
  })

  it('按 path 比对而非对象引用：调用方重排出新数组也认得出来', () => {
    expect(previewIndexOf([entry('/ws/a.jpg'), B, C], '/ws/a.jpg')).toBe(0)
  })
})

describe('nextPreviewIndex（循环绕回 + 四条不动守卫）', () => {
  it('中间位置 ±1 正常移动', () => {
    expect(nextPreviewIndex(LIST, '/ws/b.jpg', 1)).toBe(2)
    expect(nextPreviewIndex(LIST, '/ws/b.jpg', -1)).toBe(0)
  })

  it('最后一张再按 → 绕回第一张（拍板 #1）', () => {
    expect(nextPreviewIndex(LIST, '/ws/c.jpg', 1)).toBe(0)
  })

  it('第一张再按 ← 绕回最后一张', () => {
    expect(nextPreviewIndex(LIST, '/ws/a.jpg', -1)).toBe(LIST.length - 1)
  })

  it('守卫一：长度 1 不动（没什么可切的）', () => {
    expect(nextPreviewIndex([A], '/ws/a.jpg', 1)).toBeNull()
    expect(nextPreviewIndex([A], '/ws/a.jpg', -1)).toBeNull()
  })

  it('守卫二：空列表 / 未传列表 不动（QuoteFormModal 这类不传 list 的调用点 = 现状不变）', () => {
    expect(nextPreviewIndex([], '/ws/a.jpg', 1)).toBeNull()
    expect(nextPreviewIndex(undefined, '/ws/a.jpg', 1)).toBeNull()
    expect(nextPreviewIndex(null, '/ws/a.jpg', -1)).toBeNull()
  })

  it('守卫三：快照过期（当前项不在列表）不动', () => {
    expect(nextPreviewIndex(LIST, '/ws/gone.jpg', 1)).toBeNull()
  })

  it('守卫四：未传当前路径不动', () => {
    expect(nextPreviewIndex(LIST, undefined, 1)).toBeNull()
  })

  it('连按 N 次走完一圈：每张恰好访问一次且回到起点', () => {
    const seen: string[] = []
    let cur: string | undefined = '/ws/a.jpg'
    for (let i = 0; i < LIST.length; i++) {
      const next = nextPreviewIndex(LIST, cur, 1)
      expect(next).not.toBeNull()
      cur = LIST[next as number].path
      seen.push(cur)
    }
    expect(seen).toEqual(['/ws/b.jpg', '/ws/c.jpg', '/ws/a.jpg'])
  })
})

describe('canPreviewNav / previewPositionLabel（弹窗按钮与位置指示的显隐判据）', () => {
  it('列表 >1 且当前项在列表里才给导航', () => {
    expect(canPreviewNav(LIST, '/ws/a.jpg')).toBe(true)
    expect(canPreviewNav([A], '/ws/a.jpg')).toBe(false)
    expect(canPreviewNav(LIST, '/ws/gone.jpg')).toBe(false)
    expect(canPreviewNav(undefined, '/ws/a.jpg')).toBe(false)
  })

  it('位置指示是 1 基计数；下标 <0（快照过期）不显示', () => {
    expect(previewPositionLabel(0, 3)).toBe('1 / 3')
    expect(previewPositionLabel(2, 3)).toBe('3 / 3')
    expect(previewPositionLabel(-1, 3)).toBe('')
  })
})

describe('planPreviewNav（导航落点 + context 原样透传）', () => {
  it('返回下一张与同一份 context（productSet 等字段一字不动地跟着走）', () => {
    const ctx = { productSet: 'PS1', editMetadata: true, list: LIST, onDelete: () => {} }
    const plan = planPreviewNav(LIST, '/ws/a.jpg', 1, ctx)
    expect(plan?.file.path).toBe('/ws/b.jpg')
    expect(plan?.context).toBe(ctx) // 同一引用：不做浅拷贝，避免 onDelete 丢失
    expect(plan?.context.list).toBe(LIST) // 快照不重排：导航期间列表变化留给下一次开
  })

  it('不可导航时返回 null（守卫与 nextPreviewIndex 同一套判据，不留第二份）', () => {
    expect(planPreviewNav(LIST, '/ws/c.jpg', 1, { list: LIST })).not.toBeNull() // 绕回是有值的
    expect(planPreviewNav(undefined, '/ws/a.jpg', 1, {})).toBeNull()
    expect(planPreviewNav([A], '/ws/a.jpg', -1, { list: [A] })).toBeNull()
    expect(planPreviewNav(LIST, '/ws/gone.jpg', 1, { list: LIST })).toBeNull()
  })
})
