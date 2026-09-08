#!/usr/bin/env node
/**
 * 渲染层 Tailwind 类核查（v2.5.8 A1，缺陷台账 D-13 固化）：
 *
 * 宿主 Tailwind 按**源码**扫描编译 —— 源码里写了 Tailwind/自定义类但编译 CSS 里没有
 * 对应规则时，样式**静默失效**（D-13 实录：`note-editor-wrap` 挂在 class 串里但源码与
 * 产物 CSS 均无规则，无样式无定位用途 = 死类名）。本脚本把渲染层源码里出现的全部
 * class token 对本仓编译 CSS 做 presence 核查，缺失即报错退出。
 *
 * 用法：npm run check:classes（需先 `npm run build` 产出渲染层 CSS）
 * 退出码：0 全覆盖；1 有缺失；2 编译 CSS 未找到（先构建渲染层）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src', 'renderer', 'src')

// —— 1. 定位编译 CSS（取最新 index-*.css；Tailwind 全量产物在主 CSS，分片 CSS 为懒加载库样式不查）——
const assetsDir = path.join(ROOT, 'out', 'renderer', 'assets')
const cssFile = (() => {
  if (!fs.existsSync(assetsDir)) return null
  const cands = fs.readdirSync(assetsDir)
    .filter((f) => /^index-.*\.css$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(assetsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return cands.length ? path.join(assetsDir, cands[0].f) : null
})()
if (!cssFile) {
  console.error(`✗ 编译 CSS 未找到：${assetsDir}/index-*.css（先 npm run build 构建渲染层）`)
  process.exit(2)
}
const css = fs.readFileSync(cssFile, 'utf-8')

// —— 2. 抽取渲染层 class token ——
// 约定字面量白名单：非 class 的字符串字面量（id / data-testid 值 / 业务枚举 / locale /
// CSS 属性名 / 内联 style 取值 / 第三方库类），防误报。逐条带出处注释。
const SKIP = new Set([
  'zh-CN',            // toLocaleString 的 BCP-47 locale 字面量
  'YYYY-MM-DD',       // 日期格式字面量（DatePicker / Search）
  'page-fit',         // pdf.js 缩放模式枚举值（PdfPreview）
  'sans-serif',       // font-family 字面量（Logo）
  'ghost-danger',     // Button variant 联合类型/映射键（ui/Button.tsx）
  '!def.scope',       // TagInput 注释里的变量表达式
  'no-drag',          // -webkit-app-region 内联 style 取值（App/Header/TitleBar）
  'align-content',    // CSS 属性名（VirtualGrid style 对象）
  'background-color', // CSS 属性名（TagChip/TagChips/TagInput/Settings/tags store）
  'background-size', // CSS 属性名（App 背景光斑/点阵 style 对象，v2.5.8 精致化 W0）
  'animation-delay', // CSS 属性名（Dashboard 统计卡 stagger style 对象，v2.5.8 精致化 W2 批 1）
  'grid-template-columns', // CSS 属性名（Quotes/QuoteDetail/QuoteFormModal/VirtualGrid）
  'label-wrapper',    // Crepe/milkdown 第三方库内部类（样式在库分片 CSS，非宿主编译产物）
  'ctx-menu-root',    // ContextMenu 容器 id
  'global-search-input', // Header 搜索框 id
  'note-entities',    // Notes datalist id
  'note-editor-loading', // NoteEditorModal data-testid
  'compress-include-notes', // ProductSets data-testid
  'staged-identify',  // StagedIdentifyList data-testid
  'staged-identify-banner', // Invoices data-testid
  'batch-identifying', // Invoices data-testid
  'file:',            // 协议比较字面量（index.tsx window.location.protocol === 'file:'，v2.5.7 补丁）——非 Tailwind file: 变体
])
// 无连字符的 utility/自定义类（含连字符的 token 一律核查；单词类只信这个集合，
// 避免把 'peer'/'all'/'create' 这类业务字符串字面量误当 class）
const SINGLE_WORD = new Set([
  'flex', 'grid', 'block', 'hidden', 'inline', 'truncate', 'italic', 'underline',
  'relative', 'absolute', 'fixed', 'sticky', 'static', 'input', 'group',
  'card', 'glass',
])
// Tailwind variant 前缀白名单：token 含 ':' 时，前缀必须全是已知 variant，
// 否则视为内联 style 片段（'max-height:16rem'）或事件名跳过
const VARIANTS = new Set([
  'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'disabled', 'enabled',
  'group-hover', 'group-focus', 'peer-checked', 'peer-disabled',
  'sm', 'md', 'lg', 'xl', '2xl', 'dark',
  'first', 'last', 'odd', 'even', 'visited', 'checked', 'empty',
  'before', 'after', 'placeholder', 'selection', 'marker', 'file', 'backdrop', 'open',
])

/** Tailwind selector 转义（与编译产物一致）：非 [a-zA-Z0-9_-] 一律反斜杠转义；
 *  逗号 Tailwind 产物转义为 `\2c `（hex escape + 空格终止符，实测 index-*.css） */
const escapeSel = (t) => t.replace(/([^a-zA-Z0-9_-])/g, '\\$1').replace(/\\,/g, '\\2c ')

/** token 是否为疑似 class（过滤 import 路径 / MIME / 内联 style / 事件名等字符串字面量） */
const looksLikeClass = (tok) => {
  if (tok.length < 2 || !/^[a-zA-Z!]/.test(tok)) return false
  if (/[()=;]/.test(tok)) return false
  // HTML data-*/aria-* 属性名（h() 属性对象的 key）不是 class
  if (tok.startsWith('data-') || tok.startsWith('aria-')) return false
  // 含 '/'：utility 的斜杠后只能是透明度数字或任意值（bg-black/30、w-[1/2]），
  // 'application/octet-stream'、'solid-js/h' 这类在此被滤掉
  const slash = tok.indexOf('/')
  if (slash >= 0 && !/^[\d[]/.test(tok.slice(slash + 1))) return false
  // 含 ':'：前缀链必须全是已知 variant（最后一段是本体）
  if (tok.includes(':')) {
    const parts = tok.split(':')
    if (!parts.slice(0, -1).every((p) => VARIANTS.has(p))) return false
  }
  return tok.includes('-') || tok.includes('!') || tok.includes(':') || SINGLE_WORD.has(tok)
}

/** 递归收集 .ts/.tsx/.js/.jsx（递归防子目录静默漏检——plugins 仓 v0.6.0 教训） */
const listSourceFiles = (dir) => {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listSourceFiles(p))
    else if (/\.(ts|tsx|js|jsx)$/.test(ent.name)) out.push(p)
  }
  return out
}

const tokens = new Map() // token → Set<file>
for (const file of listSourceFiles(SRC)) {
  const src = fs.readFileSync(file, 'utf-8')
  // 先抹掉 import/from 的模块路径字符串，避免 'solid-js/h' 被当 token
  const stripped = src
    .replace(/\bfrom\s*'[^']*'/g, '')
    .replace(/\bfrom\s*"[^"]*"/g, '')
    .replace(/\bimport\s*\(\s*["'][^"']*["']\s*\)/g, '')
  // 提取所有字符串字面量（'...' / "..." / `...`），按空白拆 token。
  // 含 ${ 的模板段无法静态判定 → 该字面量整体跳过（分支小串仍是独立字面量，会被单独捕获）；
  // 动态拼接的最终效果由截图走查兜底。
  for (const m of stripped.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)) {
    const lit = m[1] ?? m[2] ?? m[3]
    if (lit.includes('${')) continue
    for (const raw of lit.split(/\s+/)) {
      // 单引号串内含转义引号的 HTML 片段（markdown.ts/Help.tsx innerHTML 模板）会把
      // `border-surface-200"` / `my-3">` 这类带尾巴的切片当 token——剥掉首尾引号/尖括号再核查
      const tok = raw.replace(/^[<>"'\\]+|[<>"'\\]+$/g, '')
      if (!tok || !looksLikeClass(tok) || SKIP.has(tok)) continue
      if (!tokens.has(tok)) tokens.set(tok, new Set())
      tokens.get(tok).add(path.relative(ROOT, file))
    }
  }
}

// —— 3. presence 核查 ——
// 选择器边界必须精确匹配：`css.includes('.w-2')` 会被 `.w-20`、`.w-2\/3` 命中（假阳性），
// 结果就是不存在的类被放行、页面上静默失效（plugins 仓 v0.6.0 w-2 宽 0 实录）。
// 编译产物里类名后的下一个字符只能是 `{`、`,`、`.`、`:`、`>`、空白或 `}`（转义类名以 `\XX` 结尾的
// 形如 `.w-1\.5{`，故允许反斜杠开头的续接）。
const missing = []
for (const [tok, files] of [...tokens.entries()].sort()) {
  const sel = '.' + escapeSel(tok)
  let found = false
  for (let i = css.indexOf(sel); i >= 0; i = css.indexOf(sel, i + 1)) {
    const next = css[i + sel.length]
    if (next === undefined || /[{,.\:>}\s]/.test(next)) { found = true; break }
  }
  if (!found) missing.push({ tok, files: [...files] })
}

console.log(`[classcheck] 编译 CSS：${path.relative(ROOT, cssFile)}`)
console.log(`[classcheck] 扫描 ${path.relative(ROOT, SRC)}，共 ${tokens.size} 个 class token`)
if (missing.length === 0) {
  console.log('[classcheck] ✓ 全部命中编译 CSS')
  process.exit(0)
}
console.error(`[classcheck] ✗ ${missing.length} 个 token 在编译 CSS 中不存在（效果静默失效）：`)
for (const { tok, files } of missing) {
  console.error(`  - ${tok}    （${files.join(', ')}）`)
}
console.error('处理：换已有类，或改内联 style；确认为约定字面量则加入脚本 SKIP 白名单。')
process.exit(1)
