#!/usr/bin/env node
/**
 * 推公开仓「三子代理私密面深度校验」留档闸（2026-09-23 立，用户指令：**每次**推公开仓必走）。
 *
 * 背景：2026-09-12 因私人邮箱进过公开历史重写过一次；2026-09-23 又发现公开面残留
 * 「收费/计价」措辞与内部文档名。教训是——白名单提交只挡「哪些文件进仓」，挡不住
 * 「内容写了什么」。静态门禁（check-no-secrets.mjs）管的是**已知规则**（凭据/路径/身份），
 * 管不了「商业口径、内部规划名、隐私数据的语义判断」——那需要**人（AI）逐面审**。
 *
 * 故立此闸：push 前每个待推送的 tip sha 必须有对应审计记录（三路结论 + 证据）。
 *   - 记录目录：内部审计目录（不进公开仓；路径见下方 AUDIT_DIR）
 *   - 记录文件名：<YYYY-MM-DD>-<sha 前 7 位>.md（内容模板由 `--new` 生成）
 *   - 三路固定角度：① 凭据与身份面 ② 商业与内部信息面 ③ 隐私数据与产物/生态面
 *   - 判定必须显式写「可放行」；有阻塞项时写清处置（修掉 / 用户拍板接受）
 *
 * 用法：
 *   node scripts/check-push-audit.mjs              # pre-push 钩子调用（读 stdin 的 refs 行）
 *   node scripts/check-push-audit.mjs --check <sha># 单查某个 sha
 *   node scripts/check-push-audit.mjs --new <sha>  # 生成该 sha 的记录模板
 *   node scripts/check-push-audit.mjs --list       # 列已留档的审计记录
 *
 * 逃生通道：git push --no-verify（仅紧急；事后必须补记录，否则下次仍被拦）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** 本地日期（仓库文件名口径一律本地时区；不用 toISOString——那是 UTC，凌晨会差一天） */
function localDate() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const AUDIT_DIR = path.join(root, 'docs', 'INTERNAL', 'push-audits')
const ZERO = '0'.repeat(40)

function shortSha(sha) {
  return String(sha).slice(0, 7)
}

/** 记录是否覆盖该 sha：文件名前缀匹配，或文件内容含该 sha（前 7 位及以上） */
function findRecord(sha) {
  if (!fs.existsSync(AUDIT_DIR)) return null
  const s7 = shortSha(sha)
  for (const f of fs.readdirSync(AUDIT_DIR)) {
    if (!f.endsWith('.md')) continue
    if (f.includes(s7)) return path.join(AUDIT_DIR, f)
    const body = fs.readFileSync(path.join(AUDIT_DIR, f), 'utf8')
    if (body.includes(s7) || body.includes(sha)) return path.join(AUDIT_DIR, f)
  }
  return null
}

function template(sha) {
  const date = localDate()
  return `# 推公开仓审计记录 · ${date} · ${shortSha(sha)}

> 流程出处：qihe-box AGENTS.md「推公开仓 SOP」+ \`scripts/check-push-audit.mjs\`。
> **三路必须分别由三个子代理独立跑**（不同角度、各自取证），不许一路代替三路。

## 待推送内容

- HEAD：\`${sha}\`
- 相对上一次公开推送的增量：<一句话：几文件、干什么>
- 静态门禁：\`npm run check:leaks\` = <绿/红>；\`npm run check:leaks:history\` = <绿/红>

## 第 1 路 · 凭据与身份面（子代理：<agent 号/时间>）

- 结论：<无命中 / 命中 N 条>
- 证据：<命令 → 结果摘要>
- 阻塞项与处置：<无 / 逐条>

## 第 2 路 · 商业与内部信息面（子代理：<agent 号/时间>）

- 结论：<价格面 / 内部文档名 / 路线图 / 提交信息面>
- 证据：<命令 → 结果摘要>
- 阻塞项与处置：<无 / 逐条>

## 第 3 路 · 隐私数据与产物/生态面（子代理：<agent 号/时间>）

- 结论：<真人数据 / 截图与二进制 / 产物（releases·artifacts·wiki）/ 生态（fork·镜像·npm）>
- 证据：<命令 → 结果摘要>
- 阻塞项与处置：<无 / 逐条>

## 总判定

- [ ] 三路均已回、结论与证据可复核
- [ ] 阻塞项：<无 / 已修 / 用户拍板接受（记拍板时间与方式）>
- 放行结论：**可放行 / 不可放行**
`
}

function readShasFromStdin() {
  // pre-push 协议：<local ref> <local sha> <remote ref> <remote sha>（删除分支时 local sha 全 0）
  const input = fs.readFileSync(0, 'utf8')
  const shas = new Set()
  for (const line of input.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const localSha = parts[1]
    if (localSha && localSha !== ZERO) shas.add(localSha)
  }
  return [...shas]
}

const args = process.argv.slice(2)
const mode = args[0]

if (mode === '--list') {
  if (!fs.existsSync(AUDIT_DIR)) {
    console.log('（尚无审计记录目录）')
    process.exit(0)
  }
  for (const f of fs.readdirSync(AUDIT_DIR).filter((x) => x.endsWith('.md')).sort()) console.log(f)
  process.exit(0)
}

if (mode === '--new') {
  const sha = args[1]
  if (!sha) {
    console.error('用法：node scripts/check-push-audit.mjs --new <sha>')
    process.exit(2)
  }
  fs.mkdirSync(AUDIT_DIR, { recursive: true })
  const date = localDate()
  const file = path.join(AUDIT_DIR, `${date}-${shortSha(sha)}.md`)
  if (fs.existsSync(file)) {
    console.log(`已存在：${path.relative(root, file)}`)
    process.exit(0)
  }
  fs.writeFileSync(file, template(sha))
  console.log(`模板已生成：${path.relative(root, file)}`)
  console.log('填完三路结论与证据后再 push。')
  process.exit(0)
}

const targets = mode === '--check' ? (args[1] ? [args[1]] : []) : readShasFromStdin()
const missing = targets.filter((sha) => !findRecord(sha))

if (targets.length === 0) {
  console.log('✓ 推送审计闸：无新增提交（只推标签/删除时不拦）')
  process.exit(0)
}

if (missing.length === 0) {
  const rec = findRecord(targets[0])
  console.log(`✓ 推送审计闸：${targets.map(shortSha).join(', ')} 已有三路私密面审计记录（${path.relative(root, rec)}）`)
  process.exit(0)
}

console.error(`✗ 推公开仓前必须完成「三子代理私密面深度校验」并留档——以下 sha 无记录：${missing.map(shortSha).join(', ')}`)
console.error('')
console.error('  强制流程（qihe-box AGENTS.md「推公开仓 SOP」，每次都必须走）：')
console.error('    ① 第 1 路 凭据与身份面   ② 第 2 路 商业与内部信息面   ③ 第 3 路 隐私数据与产物/生态面')
console.error('    三路分别派三个子代理独立审计（各自取证、贴命令与结果），不许合并成一路。')
console.error('    另跑静态门禁：npm run check:leaks 与 npm run check:leaks:history。')
console.error('')
console.error('  留档：')
console.error('    node scripts/check-push-audit.mjs --new ' + shortSha(missing[0]))
console.error('    → 生成 docs/INTERNAL/push-audits/<日期>-<sha7>.md，填完三路结论与总判定后再 push。')
console.error('')
console.error('  逃生（仅紧急，事后必须补记录）：git push --no-verify')
process.exit(1)