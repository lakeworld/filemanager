/**
 * 渲染层订阅清理时序门禁（2026-09-23，批 2.5 · P2「update:available 订阅泄漏」）
 *
 * 锁的事：`onMount(async () => { … await … onCleanup(fn) })` 这种写法里，`onCleanup` **永远不会注册**。
 * Solid 的 `onCleanup` 只认「当前 Owner」这一个上下文（`solid-js/dist/solid.js`：`Owner === null` 时
 * 直接丢弃，dev 包只多打一句 `cleanups created outside a createRoot or render will never be run`）；
 * `await` 之后的续体早已不在 Owner 里 ⇒ 取消订阅函数永远没人调用：`preload/index.ts` 的
 * `ipcRenderer.on` 监听器逐次堆积，事件还在为已卸载的组件写信号。
 *
 * 为什么用"扫源码"而不是渲染组件来测：本仓**没有组件级渲染测试基座**（devDeps 里无 jsdom /
 * @solidjs/testing-library，vitest 只跑 node 环境的 main 侧逻辑，渲染层一律由 e2e 兜）。
 * 而「清理必须在第一个 await 之前注册」是一条纯语法级不变量（真缺陷只有一种写法），
 * 扫源码即可钉死——与 `uiInventory` / `uiScan` 等既有源码门禁同一路数。
 *
 * 反向实验（改坏必红）：修前全绿直跑本门禁即红在这两处真实文件上
 * （`components/TitleBar.tsx:19`、`pages/Profile.tsx:83`，报文含同块首个 await 的行号）；
 * 第二个用例把「await 之后注册」的坏形状注入临时文件，长期钉住这条判据不退化
 * （连同「注释散文里的 await/onCleanup 不许误报」「本块没有 await 不算违规」两条反向样本）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 回调块形态：进块是 `onMount(async () => {` / `createEffect(async () => {`（含 `async (…) =>` 变体） */
const ASYNC_HOOK = /\b(onMount|createEffect|createComputed)\s*\(\s*async\b/

interface Hit {
  file: string
  line: number
  awaitLine: number
}

/**
 * 去注释后按行返回（行号与原文件对齐）。必须先去注释再找 `await` / `onCleanup`：
 * 中文注释里写「必须先于第一个 await 注册」这种散文，会被裸正则当成真 await
 * （2026-09-23 实测踩过——第一版扫描器就是这么把自己扫红的）。
 */
function codeLinesOf(src: string): string[] {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  // 行注释：`//` 前是冒号时留给 `https://` 这类串，不当注释切
  return noBlock.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
}

/** 逐文件找「同一个 async 回调块里，onCleanup 出现在 await 之后」的写法 */
function findLateCleanups(file: string): Hit[] {
  const lines = codeLinesOf(fs.readFileSync(file, 'utf8'))
  const hits: Hit[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!ASYNC_HOOK.test(lines[i])) continue
    let depth = 0
    let opened = false
    let firstAwait = 0
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') {
          depth++
          opened = true
        } else if (ch === '}') depth--
      }
      if (firstAwait === 0 && /\bawait\b/.test(lines[j])) firstAwait = j + 1
      if (/\bonCleanup\s*\(/.test(lines[j])) {
        // 只有「同块里已经有 await，且它在本行之前」才算违规；
        // onCleanup 在 await 之前（或本块根本没有 await）都是正当写法
        if (firstAwait > 0 && firstAwait < j + 1) hits.push({ file, line: j + 1, awaitLine: firstAwait })
      }
      // 块尾：进过块且括号回到 0 ⇒ 本回调结束（缩进/字符串里的花括号若让深度提前归零，
      // 只会**少扫**几行 = 漏报，不会把正常代码误报成违规，方向上是安全的）
      if (opened && depth <= 0) break
    }
  }
  return hits
}

describe('渲染层 onMount async 回调里的 onCleanup 必须在第一个 await 之前', () => {
  it('全渲染层零命中（历史两处：pages/Profile.tsx、components/TitleBar.tsx）', () => {
    const bad = sourceFiles(RENDERER).flatMap((f) => findLateCleanups(f))
    const report = bad
      .map((h) => `${path.relative(ROOT, h.file)}:${h.line}（同块首个 await 在 :${h.awaitLine || '—'}）`)
      .join('\n  ')
    expect(bad.length, `onCleanup 注册在 await 之后 ⇒ 永不注册、订阅泄漏：\n  ${report}`).toBe(0)
  })

  it('门禁器自证：该红的是真违规，注释散文/后续 await 不许误报（反向实验，防门禁自身退化）', () => {
    // 自证样本写进临时目录（不落进渲染层源码树——半路崩了也不给 src/ 留垃圾）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-cleanup-gate-'))
    const scan = (name: string, text: string): Hit[] => {
      const p = path.join(dir, name)
      fs.writeFileSync(p, text)
      return findLateCleanups(p)
    }
    try {
      // 真违规：await 之后才注册
      const bad = scan('bad.tsx', ['onMount(async () => {', '  const v = await api.app.version()', '  onCleanup(() => v)', '})'].join('\n'))
      expect(bad).toHaveLength(1)
      expect(bad[0].awaitLine).toBe(2)
      expect(bad[0].line).toBe(3)
      // 正当写法：注册在 await 之前
      expect(scan('good.tsx', ['onMount(async () => {', '  onCleanup(() => {})', '  const v = await api.app.version()', '})'].join('\n'))).toHaveLength(0)
      // 正当写法：本块根本没有 await（onCleanup 不欠谁）
      expect(scan('sync.tsx', ['onMount(() => {', '  onCleanup(() => {})', '})'].join('\n'))).toHaveLength(0)
      // 注释里的「await / onCleanup」是散文，不是代码（2026-09-23 第一版扫描器就栽在这）
      expect(
        scan(
          'comments.tsx',
          ['onMount(async () => {', '  // 订阅与 onCleanup 必须先于第一个 await 注册', '  onCleanup(() => {})', '  await api.app.version()', '})'].join('\n'),
        ),
      ).toHaveLength(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})