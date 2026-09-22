/**
 * 渲染层订阅清理时序门禁（2026-09-23，批 2.5 · P2「update:available 订阅泄漏」；
 * 2026-09-23 2.6 审查轮 1 扩面：hook 自身块 → **任意 async 函数体**）
 *
 * 锁的事：`onMount(async () => { … await … onCleanup(fn) })` 这种写法里，`onCleanup` **永远不会注册**。
 * Solid 的 `onCleanup` 只认「当前 Owner」这一个上下文（`solid-js/dist/solid.js`：`Owner === null` 时
 * 直接丢弃，dev 包只多打一句 `cleanups created outside a createRoot or render will never be run`）；
 * `await` 之后的续体早已不在 Owner 里 ⇒ 取消订阅函数永远没人调用：`preload/index.ts` 的
 * `ipcRenderer.on` 监听器逐次堆积，事件还在为已卸载的组件写信号。
 *
 * **扩面（2026-09-23 · 2.6 审查轮 1）**：第一版只扫三支 hook 的**自身块**，于是漏掉了最常见的真形状
 * ——组件把初始化拆进一个 async 辅助函数、在 hook 块里 await 它：
 *   `const initEditor = async (md) => { const mod = await loadCrepe(); … onCleanup(offSave) }`
 *   `onMount(async () => { … await initEditor(res.data ?? "") … })`
 * hook 块里一行 `onCleanup` 都没有 ⇒ 旧扫描器全绿，而注册照样被静默丢弃。修前实测全渲染层放宽后
 * 唯一命中 = `components/NoteEditorModal.tsx:285`（同块首个 await 在 :248）：`offSave()` 永不执行
 * ⇒ `note.save` 处理器留到会话结束，关掉笔记编辑器后按 Ctrl+S，陈旧处理器把笔记写成 0 字节
 * （数据丢失级）。判据本身一字不变：**同块里出现 await 之后再注册 onCleanup** 即违规。
 *
 * 为什么用"扫源码"而不是渲染组件来测：本仓**没有组件级渲染测试基座**（devDeps 里无 jsdom /
 * @solidjs/testing-library，vitest 只跑 node 环境的 main 侧逻辑，渲染层一律由 e2e 兜）。
 * 而「清理必须在第一个 await 之前注册」是一条纯语法级不变量（真缺陷只有一种写法），
 * 扫源码即可钉死——与 `uiInventory` / `uiScan` 等既有源码门禁同一路数。
 *
 * 反向实验（改坏必红）：修前全绿直跑本门禁即红在真实文件上——旧 hook 口径红在两处
 * （`components/TitleBar.tsx:19`、`pages/Profile.tsx:83`），扩面后再红一处
 * （`components/NoteEditorModal.tsx:285` 这处"嵌套 async 辅助函数"形状）；第二个用例把
 * **三种**坏形状（hook 块内 / 嵌套 async 辅助函数 / `async function`）注入临时文件，
 * 长期钉住这条判据不退化（连同「注释散文里的 await/onCleanup 不许误报」
 * 「本块没有 await 不算违规」「注册在 await 之前不算违规」三条正当样本）。
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

/**
 * 异步函数体开头——**不只 hook**：`async function name(…) {` / `async method(…) {`（对象·类方法，
 * 可带泛型）/ `async (…) => {`（可带返回类型）/ `async x => {`。
 * 为什么必须逐行匹配：扫描器靠**逐行括号计数**找块尾，只能认「同一行开体」的函数头；跨行的函数头
 * （`async (x) =>\n{`）拿不到起点，只会**少扫**（漏报）而不会把正常代码误报成违规——方向安全，
 * 与「缩进/字符串里的花括号让深度提前归零」是同一条原则。
 */
const ASYNC_FN = [
  /\basync\s+function\b[^(]*\([^)]*\)[^;{}]*\{/, // async function name(…) {
  /\basync\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\([^)]*\)[^;{}]*\{/, // async method(…) {（含泛型）
  /\basync\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^{;]*)?=>\s*\{/, // async (…) => { / async x => {
]

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

/** 逐文件找「同一个 async 函数体里，onCleanup 出现在 await 之后」的写法 */
function findLateCleanups(file: string): Hit[] {
  const lines = codeLinesOf(fs.readFileSync(file, 'utf8'))
  const hits: Hit[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!ASYNC_FN.some((re) => re.test(lines[i]))) continue
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
      // 块尾：进过块且括号回到 0 ⇒ 本函数结束（缩进/字符串里的花括号若让深度提前归零，
      // 只会**少扫**几行 = 漏报，不会把正常代码误报成违规，方向上是安全的）
      if (opened && depth <= 0) break
    }
  }
  return hits
}

describe('渲染层 async 函数体里的 onCleanup 必须在第一个 await 之前', () => {
  it('全渲染层零命中（历史三处：pages/Profile.tsx、components/TitleBar.tsx、components/NoteEditorModal.tsx）', () => {
    const bad = sourceFiles(RENDERER).flatMap((f) => findLateCleanups(f))
    const report = bad
      .map((h) => `${path.relative(ROOT, h.file)}:${h.line}（同块首个 await 在 :${h.awaitLine || '—'}）`)
      .join('\n  ')
    expect(bad.length, `onCleanup 注册在 await 之后 ⇒ 永不注册、订阅泄漏：\n  ${report}`).toBe(0)
  })

  it('门禁器自证：三种坏形状可红，注释散文/后续 await/先注册三种正当写法不许误报（反向实验，防门禁自身退化）', () => {
    // 自证样本写进临时目录（不落进渲染层源码树——半路崩了也不给 src/ 留垃圾）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-cleanup-gate-'))
    const scan = (name: string, text: string): Hit[] => {
      const p = path.join(dir, name)
      fs.writeFileSync(p, text)
      return findLateCleanups(p)
    }
    try {
      // 坏形状①（旧口径就能红）：hook 块里 await 之后才注册
      const bad = scan('bad.tsx', ['onMount(async () => {', '  const v = await api.app.version()', '  onCleanup(() => v)', '})'].join('\n'))
      expect(bad).toHaveLength(1)
      expect(bad[0].awaitLine).toBe(2)
      expect(bad[0].line).toBe(3)
      // 坏形状②（扩面才抓得到 = NoteEditorModal 修前真形状）：注册住在「被 hook await 的 async 辅助函数」里
      const nested = scan(
        'nested.tsx',
        [
          'onMount(async () => {',
          '  const res = await api.files.readTextFile(props.filePath)',
          '  await initEditor(res.data ?? "")',
          '})',
          '',
          'const initEditor = async (md: string) => {',
          '  const mod = await loadCrepe()',
          '  onCleanup(() => { offSave() })',
          '}',
        ].join('\n'),
      )
      expect(nested).toHaveLength(1)
      expect(nested[0].line).toBe(8) // 辅助函数自己的块里才算：hook 块（1-4 行）不背这条账
      expect(nested[0].awaitLine).toBe(7)
      // 坏形状③：`async function` 声明（与箭头函数同等对待，不给声明式开后门）
      const fn = scan('fn.ts', ['export async function boot() {', '  await ready()', '  onCleanup(() => {})', '}'].join('\n'))
      expect(fn).toHaveLength(1)
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