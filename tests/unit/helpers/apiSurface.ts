/**
 * API 兼容性守护——提取器（v2.5，Task 1 / PLAN-v2.5-测试.md §三.A）。
 *
 * 把三节公开面序列化成确定性 markdown 基线：
 *   1. types 节：用 TypeScript compiler API 解析 src/plugins/types.ts 的公开导出
 *      （导出类型名 / 接口字段名 + 类型文本 / 字面量联合原文 / 函数签名 / 常量值）。
 *      口径钉死：引用类型记 AST 标识符原文（不做 checker 解析 widen），
 *      字面量联合记字面量原文（'global' | 'local' 不得 widen 成 string）；
 *      printer.printNode + 全量排序，保证确定性。
 *   2. preload 节：显式维护清单（PRELOAD_MANIFEST，权威）。
 *   3. ipc 节：显式维护清单（IPC_CHANNELS，权威）。
 *
 * 纯只读：不 import 任何 src 生产代码，不修改 src/ 下任何文件。
 */
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

export const TYPES_FILE = path.join(repoRoot, 'src/plugins/types.ts')
export const PRELOAD_FILE = path.join(repoRoot, 'src/preload/index.ts')
export const IPC_FILE = path.join(repoRoot, 'src/main/plugins/ipc.ts')
export const BASELINE_PATH = path.join(repoRoot, 'tests/unit/__baselines__/plugins-api.md')

/** 三节提取面 */
export interface ApiSurface {
  types: string[]
  preload: string[]
  ipc: string[]
}

/**
 * preload 面清单（显式维护，权威）：window.qihebox.plugins 与 window.qihebox.settings。
 * 测试用源码包含性断言（见 assertPreloadManifestMatchesSource）验证清单与源码一致，防清单凭空增删。
 */
export const PRELOAD_MANIFEST: { plugins: string[]; settings: string[] } = {
  plugins: ['list', 'call', 'setEnabled', 'install', 'uninstall', 'on'],
  settings: ['getDevMode', 'setDevMode'],
}

/** IPC 通道清单（显式维护，权威）：宿主插件相关通道（qihebox:plugins:* / qihebox:settings:*）。 */
export const IPC_CHANNELS: string[] = [
  'qihebox:plugins:list',
  'qihebox:plugins:call',
  'qihebox:plugins:setEnabled',
  'qihebox:plugins:install',
  'qihebox:plugins:uninstall',
  'qihebox:settings:getDevMode',
  'qihebox:settings:setDevMode',
]

const printer = ts.createPrinter({ removeComments: true })

/** 折叠空白为单空格（printNode 会保留源文件多行排版，此处规整为单行，保证确定性）。 */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function loadSource(filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function print(node: ts.Node, sf: ts.SourceFile): string {
  return normalize(printer.printNode(ts.EmitHint.Unspecified, node, sf))
}

function isExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  const mods = ts.getModifiers(node)
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

function dedupeAndSort(lines: string[]): string[] {
  return [...new Set(lines)].sort()
}

function propertyNameText(name: ts.PropertyName | undefined, sf: ts.SourceFile): string {
  if (!name) return ''
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return name.getText(sf)
}

/** Array<T> 或 T[] 的元素类型（仅当是 Array 引用或数组类型时返回，否则 undefined）。 */
function arrayElementType(t: ts.TypeNode): ts.TypeNode | undefined {
  if (ts.isArrayTypeNode(t)) return t.elementType
  if (ts.isTypeReferenceNode(t) && t.typeArguments && t.typeArguments.length === 1) {
    if (ts.isIdentifier(t.typeName) && t.typeName.text === 'Array') return t.typeArguments[0]
  }
  return undefined
}

/** 若类型是「数组 + 匿名对象字面量元素」则返回该元素字面量，否则 undefined。 */
function arrayTypeLiteralElement(t: ts.TypeNode): ts.TypeLiteralNode | undefined {
  const elem = arrayElementType(t)
  return elem && ts.isTypeLiteralNode(elem) ? elem : undefined
}

/** 递归提取接口/对象字面量成员（含嵌套匿名对象与数组元素），产出「路径: 类型文本」或「路径(...): 返回类型」行。 */
function extractMember(member: ts.TypeElement, path: string, out: string[], sf: ts.SourceFile): void {
  if (ts.isPropertySignature(member)) {
    const name = propertyNameText(member.name, sf)
    if (!name) return
    const opt = member.questionToken ? '?' : ''
    const childPath = `${path}.${name}`
    const t = member.type
    if (!t) {
      out.push(`${childPath}${opt}: any`)
      return
    }
    if (ts.isTypeLiteralNode(t)) {
      out.push(`${childPath}${opt}: ${print(t, sf)}`)
      for (const m of t.members) extractMember(m, childPath, out, sf)
    } else {
      const elem = arrayTypeLiteralElement(t)
      if (elem) {
        out.push(`${childPath}${opt}: ${print(t, sf)}`)
        for (const m of elem.members) extractMember(m, `${childPath}[]`, out, sf)
      } else {
        out.push(`${childPath}${opt}: ${print(t, sf)}`)
      }
    }
  } else if (ts.isMethodSignature(member)) {
    const name = propertyNameText(member.name, sf)
    const params = member.parameters.map((p) => print(p, sf)).join(', ')
    const ret = member.type ? `: ${print(member.type, sf)}` : ''
    out.push(`${path}.${name}(${params})${ret}`)
  } else {
    // 索引签名等其余成员：原样文本兜底
    out.push(`${path}${print(member, sf)}`)
  }
}

function extractTypesSurface(): string[] {
  const sf = loadSource(TYPES_FILE)
  const out: string[] = []
  for (const stmt of sf.statements) {
    if (!isExported(stmt)) continue
    if (ts.isTypeAliasDeclaration(stmt)) {
      out.push(`type ${stmt.name.text} = ${print(stmt.type, sf)}`)
    } else if (ts.isInterfaceDeclaration(stmt)) {
      const heritage = stmt.heritageClauses?.map((h) => print(h, sf)).join(' ') ?? ''
      out.push(heritage ? `interface ${stmt.name.text} ${heritage}` : `interface ${stmt.name.text}`)
      for (const member of stmt.members) extractMember(member, stmt.name.text, out, sf)
    } else if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text ?? '(anonymous)'
      const params = stmt.parameters.map((p) => print(p, sf)).join(', ')
      const ret = stmt.type ? `: ${print(stmt.type, sf)}` : ''
      out.push(`function ${name}(${params})${ret}`)
    } else if (ts.isClassDeclaration(stmt)) {
      out.push(`class ${stmt.name?.text ?? '(anonymous)'}`)
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const name = decl.name.getText(sf)
        const init = decl.initializer ? print(decl.initializer, sf) : ''
        out.push(`const ${name} = ${init}`)
      }
    }
  }
  return dedupeAndSort(out)
}

/** 提取三节公开面（types 由编译器解析，preload/ipc 为显式清单）。 */
export function extractApiSurface(): ApiSurface {
  return {
    types: extractTypesSurface(),
    preload: dedupeAndSort([
      ...PRELOAD_MANIFEST.plugins.map((m) => `plugins.${m}`),
      ...PRELOAD_MANIFEST.settings.map((m) => `settings.${m}`),
    ]),
    ipc: dedupeAndSort([...IPC_CHANNELS]),
  }
}

function sectionMarkdown(title: string, items: string[]): string {
  const sorted = dedupeAndSort(items)
  return `## ${title}\n\n${sorted.map((i) => `- ${i}`).join('\n')}`
}

/**
 * 序列化为 markdown：三节分列、每行一个符号、排序后输出（diff 友好、人可读）。
 * breakReason 写入文件头注释（正常基线恒为「（无）」，仅 API_FORCE_BREAK 时由测试写入原因）。
 */
export function serialize(surface: ApiSurface, breakReason = '（无）'): string {
  const reason = breakReason.replace(/[\r\n]+/g, ' ')
  const header = [
    '<!--',
    '  qihe-box API 兼容性守护基线（API_VERSION=1 · 只增不删）',
    '  生成器：tests/unit/helpers/apiSurface.ts · 更新：npm run api:update',
    `  TypeScript: ${ts.version}`,
    `  break-reason: ${reason}`,
    '-->',
    '',
    '# qihe-box 插件协议 API 面（types / preload / ipc）',
    '',
  ].join('\n')
  const body = [
    sectionMarkdown('types', surface.types),
    sectionMarkdown('preload', surface.preload),
    sectionMarkdown('ipc', surface.ipc),
  ].join('\n\n')
  return header + body + '\n'
}

// —— 源码包含性校验（防清单凭空增删）——

function findObjectLiteralProperty(obj: ts.ObjectLiteralExpression, propName: string): ts.ObjectLiteralExpression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === propName && ts.isObjectLiteralExpression(p.initializer)) {
      return p.initializer
    }
  }
  return undefined
}

function objectLiteralPropertyNames(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): string[] {
  const names: string[] = []
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)) {
      const n = p.name
      if (ts.isIdentifier(n)) names.push(n.text)
      else if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) names.push(n.text)
      else names.push(n.getText(sf))
    }
  }
  return names
}

function extractPreloadMethodNames(): { plugins: string[]; settings: string[] } {
  const sf = loadSource(PRELOAD_FILE)
  let api: ts.ObjectLiteralExpression | undefined
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === 'api' && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
        api = decl.initializer
      }
    }
  }
  if (!api) throw new Error('preload/index.ts 未找到 `const api` 对象定义')
  const plugins = findObjectLiteralProperty(api, 'plugins')
  const settings = findObjectLiteralProperty(api, 'settings')
  if (!plugins) throw new Error('preload/index.ts 未找到 `plugins` 命名空间')
  if (!settings) throw new Error('preload/index.ts 未找到 `settings` 命名空间')
  return {
    plugins: objectLiteralPropertyNames(plugins, sf),
    settings: objectLiteralPropertyNames(settings, sf),
  }
}

function listDiff(label: string, expected: string[], actual: string[]): string {
  const exp = dedupeAndSort(expected)
  const act = dedupeAndSort(actual)
  const expSet = new Set(exp)
  const actSet = new Set(act)
  const missing = exp.filter((x) => !actSet.has(x))
  const extra = act.filter((x) => !expSet.has(x))
  if (missing.length === 0 && extra.length === 0) return ''
  const parts: string[] = [`${label} 不一致：`]
  if (missing.length) parts.push(`  清单有、源码无：${missing.join(', ')}`)
  if (extra.length) parts.push(`  源码有、清单无：${extra.join(', ')}`)
  return parts.join('\n')
}

/** 断言 preload 清单与 src/preload/index.ts 中 plugins/settings 命名空间的方法名完全一致。 */
export function assertPreloadManifestMatchesSource(): void {
  const actual = extractPreloadMethodNames()
  const diffs = [
    listDiff('preload.plugins', PRELOAD_MANIFEST.plugins, actual.plugins),
    listDiff('preload.settings', PRELOAD_MANIFEST.settings, actual.settings),
  ].filter(Boolean)
  if (diffs.length) throw new Error(['preload 清单与 src/preload/index.ts 不一致：', ...diffs].join('\n'))
}

function extractIpcHandleChannels(filePath: string, prefix: string): string[] {
  const sf = loadSource(filePath)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'handle' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ipcMain'
    ) {
      const arg0 = node.arguments[0]
      if (arg0 && ts.isStringLiteral(arg0) && arg0.text.startsWith(prefix)) out.push(arg0.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function extractInvokeChannels(filePath: string, prefix: string): string[] {
  const sf = loadSource(filePath)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'invoke') {
      const arg0 = node.arguments[0]
      if (arg0 && ts.isStringLiteral(arg0) && arg0.text.startsWith(prefix)) out.push(arg0.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * 断言 IPC 清单与源码一致：
 *   qihebox:plugins:*  → src/main/plugins/ipc.ts 的 ipcMain.handle 注册；
 *   qihebox:settings:* → src/preload/index.ts 的 invoke 调用（注册在装配层 src/main/index.ts）。
 */
export function assertIpcManifestMatchesSource(): void {
  const pluginChannels = extractIpcHandleChannels(IPC_FILE, 'qihebox:plugins:')
  const settingsChannels = extractInvokeChannels(PRELOAD_FILE, 'qihebox:settings:')
  const actual = dedupeAndSort([...pluginChannels, ...settingsChannels])
  const diff = listDiff('ipc 通道清单', IPC_CHANNELS, actual)
  if (diff) throw new Error(diff)
}
