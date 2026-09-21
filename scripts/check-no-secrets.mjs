#!/usr/bin/env node
/**
 * 公开仓泄漏门禁（2026-09-12 隐私清洗事故固化）：
 *
 * 背景：本仓是公开开源仓（GitHub lakeworld/filemanager）。2026-08-12 起私人 QQ 邮箱被写进
 * `Profile.tsx` / `README.md` / e2e 断言，2026-08-19 从 master 删除，但**历史 blob、两百多笔
 * 提交的 author/committer、三个陈旧分支 tip 仍长期公开可见**。白名单提交（AGENTS.md §一.1）
 * 只挡「哪些文件进仓」，挡不住「文件里写了什么」和「提交元数据写了谁」——本脚本补这两道。
 *
 * 用法：
 *   node scripts/check-no-secrets.mjs              # = --all：扫 HEAD 跟踪文件（CI 门禁，必须绿）
 *   node scripts/check-no-secrets.mjs --all        #   同上
 *   node scripts/check-no-secrets.mjs --history    # 审计口径：连已发布历史的残留一起报（人工复核用）
 *   node scripts/check-no-secrets.mjs --pre-push   # 增量拦截：只查本次新推的提交与对象（钩子用）
 *
 * 三种口径不是一套标准：CI 门禁管「现在树里有没有」；pre-push 管「这次有没有把旧的推回来」；
 * --history 管「历史上留了什么」——已推送过的残留（本仓现存 4 个网盘目录名的历史 blob）在这里
 * 会一直可见，但它不该让每次推送都红（那只会逼人用 --no-verify）。
 *
 * 退出码：0 干净；1 命中；2 用法/git 调用失败。
 * 纪律：命中只报「位置 + 规则名」，**不回显命中内容本身**——门禁日志与 CI 产物本身也是公开面。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOW, IGNORE_PATHS, ALLOWED_IDENTITIES, SERVER_CONFIG_PATHS } from './leak-allowlist.mjs'

// QH_LEAK_ROOT：单测用 fixture 仓覆盖（默认取脚本所在仓的上一级 = 仓库根）
const ROOT = process.env.QH_LEAK_ROOT
  ? path.resolve(process.env.QH_LEAK_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ZERO_OID = /^0+$/

function gitBuffer(args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'buffer', maxBuffer: 1 << 28 })
  if (r.status !== 0) {
    process.stderr.write(`git ${args.join(' ')} 失败：${r.stderr.toString('utf8').trim()}\n`)
    process.exit(2)
  }
  return r.stdout
}

/** 远端是否已有该对象（决定 pre-push 走增量还是全新口径） */
function objectExists(sha) {
  return spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8' }).status === 0
}

// ───────────────────────────── 规则 ─────────────────────────────
/**
 * 占位符特征：文档/示例里出现的假值。命中即放过——否则会逼着把 README 改没，
 * 而 README 恰恰必须教用户怎么自建部署（AGENTS.md §一.2 只禁真实地址，不禁写法）。
 */
const PLACEHOLDER = /your[-_@]|\bexample\b|\.example|\.invalid|\.test\b|localhost|127\.0\.0\.1|\$\{|\$[A-Z_]|%[sd@]|\.\.\.|…|<[^>\n]*>/i

/** 明显是编造的账户名：`/home/user/`、`C:\dev\` 这类夹具不该把门禁刷红 */
const SYNTHETIC_USER = /^(user|u|dev|example|tester|test|ci|jenkins|gitlab-runner|runner|work|tmp|sample|admin|root)$/i

/**
 * 个人邮箱域名（公开仓里出现即视为私人标识）。刻意用「域名族 + 公开联系邮箱白名单」的
 * 泛化写法，而不是把被拦的具体地址抄进源码——门禁源码本身住在公开仓，写出值等于再发一次。
 */
const PERSONAL_EMAIL_RE = /[A-Za-z0-9._%+-]{3,}@(?:[\w-]+\.)*(?:qq|163|126|foxmail|gmail|outlook|hotmail|icloud|sina|sohu)\.(?:com|cn|net|org|cc)\b/gi
const PUBLIC_CONTACTS = new Set(['ai_qihe@vip.qq.com']) // 与 README/PRIVACY/package.json 同源，唯一公开身份

/** 含真实用户名的本机绝对路径（同上：不写死自家用户名，改判「用户名不像编造的」） */
// 用户名段要求至少含一个非点字符：`C:/Users/.../工作区A` 这类省略写法不算泄漏
const HOME_PATH_RE = /(?:\/home|\/Users|\\Users)[/\\]+([A-Za-z0-9._-]*[A-Za-z0-9_-][A-Za-z0-9._-]*)[/\\]/g

function hasPersonalEmail(line) {
  for (const m of line.matchAll(PERSONAL_EMAIL_RE)) {
    if (!PUBLIC_CONTACTS.has(m[0].toLowerCase())) return true
  }
  return false
}

function hasRealUserPath(line) {
  for (const m of line.matchAll(HOME_PATH_RE)) {
    if (!SYNTHETIC_USER.test(m[1])) return true
  }
  return false
}

/**
 * 作者/tagger 名形态检查：把 QQ 号一类纯数字当显示名，等价于把账号写进公开元数据。
 * 刻意不比对具体值——门禁源码住在公开仓，写出被拦的值等于再发一次。
 */
function suspiciousName(name) {
  const n = (name || '').trim()
  if (!n) return false
  if (/^\d{6,12}$/.test(n)) return true
  return hasPersonalEmail(n)
}

// hard：任何文件都查（含 lockfile 等软规则豁免文件）
const HARD_RULES = [
  { name: 'personal-email', probe: hasPersonalEmail, why: '公开面出现个人邮箱域名字面值' },
  // 用户名级本机路径：零豁免（这类值一旦进公开历史就只能重写，不接受任何例外）
  { name: 'local-path', probe: hasRealUserPath, why: '含真实用户名的本机绝对路径' },
  // 网盘目录名：只暴露「用过某同步盘」，不含身份；已迁出公开树的死路径按文件精确豁免
  { name: 'sync-dir', re: /Nutstore Files|我的坚果云/, why: '网盘同步目录名（提示开发机目录布局）' },
  // 私钥**材料**本体；文件名提及（`*.pfx` 忽略模式、签名脚本的输出路径）不算
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bid_rsa\b/, why: '私钥材料' },
  {
    name: 'server-config',
    re: /["']apiBase["']\s*:\s*["']https?:\/\/\S/i,
    benign: (line) => PLACEHOLDER.test(line),
    why: '写死的服务地址（真实地址只准住 gitignore 的 build/server.json）',
  },
]
// soft：命中面大、易误报，跳过 IGNORE_PATHS（lockfile、字体、图片等）
const SOFT_RULES = [
  {
    name: 'credential-assign',
    re: /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|access[_-]?key|password|passwd)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    benign: (line) => PLACEHOLDER.test(line),
    why: '明文凭据赋值',
  },
  {
    name: 'url-with-credentials',
    re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@"']{1,64}:[^/\s@"']{1,128}@/i,
    why: 'URL 内嵌账号密码（ssh/scp/http 形式）',
  },
]

// 前后不接词字符或点：把 `12.0.1.7z`、`1.2.3.4.5`、哈希片段这类四段数字排除掉
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g
/** 回环 / 未指定 / 广播 / 文档保留 / 组播：不算泄漏；其余（含公网与 192.168 内网）一律算 */
function isBenignIp(ip) {
  const o = ip.split('.').map(Number)
  if (o.some((n) => n > 255)) return true // 版本号形状，非 IP
  if (ip === '0.0.0.0' || ip === '255.255.255.255') return true
  if (o[0] === 127) return true // 回环
  if (o[0] === 224 || o[0] === 239 || (o[0] === 223 && o[1] === 255)) return true // 组播/SSM
  if (o[0] === 192 && o[1] === 0 && o[2] === 2) return true // RFC 5737 文档段
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true
  return false
}

/**
 * 抽出一行里「真算泄漏」的 IPv4。四段点分数字在代码里大量是版本号
 * （`version="6.0.0.0"` 程序集版本、npm 包四段版本），按上下文放过；
 * 语义确实相同但非地址的样本（如金额非法输入）走 leak-allowlist 精确豁免。
 * 注意：上下文判定只看 `version` 全词——早先收 `ver` 时 `const server = "10.x"` 被当成版本号漏掉。
 */
function riskyIps(line) {
  const out = []
  for (const m of line.matchAll(IPV4_RE)) {
    if (isBenignIp(m[0])) continue
    const before = line.slice(Math.max(0, m.index - 40), m.index).replace(/["'`\\]/g, '')
    if (/\b(?:version|semver)\s*[=:]?\s*$/i.test(before)) continue
    out.push(m[0])
  }
  return out
}

/** 一行文本跑全部规则；soft=true 时附带软规则。返回命中的规则名数组 */
function matchLine(line, { soft }) {
  const rules = soft ? [...HARD_RULES, ...SOFT_RULES] : HARD_RULES
  const names = []
  for (const r of rules) {
    const fired = r.probe ? r.probe(line) : r.re.test(line) && !(r.benign && r.benign(line))
    if (fired) names.push(r.name)
  }
  if (riskyIps(line).length) names.push('ip-address')
  return names
}

// ───────────────────────────── 命中收集 ─────────────────────────────
const findings = []
const seen = new Set()
function hit(where, rule, why) {
  const key = `${where}|${rule}`
  if (seen.has(key)) return
  seen.add(key)
  const at = (p) => where === p || where.startsWith(`${p}:`)
  for (const a of ALLOW) {
    const fileOk = a.file instanceof RegExp ? a.file.test(where) : at(a.file)
    const ruleOk = a.rule instanceof RegExp ? a.rule.test(rule) : a.rule === rule
    if (fileOk && ruleOk) return
  }
  findings.push({ where, rule, why })
}

const RULE_WHY = {
  ...Object.fromEntries([...HARD_RULES, ...SOFT_RULES].map((r) => [r.name, r.why])),
  'ip-address': '非回环 IPv4（公网与内网地址均不外泄）',
  'commit-identity': '提交/标签身份不在允许清单',
}

function scanText(wherePrefix, text, { soft }) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const name of matchLine(lines[i], { soft })) {
      hit(`${wherePrefix}:${i + 1}`, name, RULE_WHY[name])
    }
  }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}
const softFor = (p) => !IGNORE_PATHS.some((re) => re.test(p))

// ───────────────────────────── 模式一：跟踪文件（--all） ─────────────────────────────
function scanTracked() {
  const files = gitBuffer(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean)
  for (const rel of files) {
    if (SERVER_CONFIG_PATHS.includes(rel)) hit(rel, 'server-config', '打包服务配置文件被跟踪（真实地址严禁进仓）')
    const abs = path.join(ROOT, rel)
    let buf
    try {
      buf = fs.readFileSync(abs)
    } catch {
      continue // 符号链接断裂/稀疏检出：跳过而非炸门禁
    }
    if (isBinary(buf)) continue
    scanText(rel, buf.toString('utf8'), { soft: softFor(rel) })
  }
}

/**
 * 历史口径**能不能审**的纯判据（v2.5.9/A2 补：CI 假绿根治）。
 *
 * 病根（2026-09-21 实测）：GitHub Actions 的 `checkout` 默认 `fetch-depth: 1` ⇒ runner 上是**浅克隆**，
 * `rev-list --objects --all` 从完整仓的 5026 条塌成 **517 条、提交数 1**，而本门禁的历史模式照样
 * 打印「✓ 通过（history）」并 rc=0 —— 一条**保证绿**的门禁比没有门禁更糟：它会替我们把"历史上还有残留"
 * 这件事背书。本仓确实为此重写过一次历史（AGENTS §一.1），所以这条判据不是理论洁癖。
 *
 * 判据用「浅克隆」**而不是**「对象数 < 阈值」：后者会在真小仓上误红，浅克隆是**结构性**的"看不见历史"。
 */
export function historyAuditScope(status) {
  const { isShallow, commitCount } = status
  if (isShallow) {
    return {
      usable: false,
      reason:
        `仓库是浅克隆（shallow）：看不见历史 ⇒ 历史口径等于没审。` +
        `CI 须在 checkout 里加 fetch-depth: 0；本地若是 --depth 克隆，先 git fetch --unshallow。`,
    }
  }
  // ⚠ 只有 shallow 这一条是不可审：**单提交的完整仓照样要审**（那一个提交里就可能藏着私人邮箱，
  // 而且本仓既有 5 条 fixture 用例就是拿单提交仓验历史的）——第一版我多加了"提交数 ≤1 不可审"，
  // 直接把那些用例打红；结构性看不见历史才叫审不了，"内容少"不是。
  void commitCount // 仅作附注信息，不参与判据
  return { usable: true, reason: '' }
}

/** 取真实仓库状态喂给判据（git 查询失败由 gitBuffer 统一 rc=2） */
export function readHistoryAuditStatus() {
  const isShallow = gitBuffer(['rev-parse', '--is-shallow-repository']).toString('utf8').trim() === 'true'
  const commitCount = Number(gitBuffer(['rev-list', '--count', '--all']).toString('utf8').trim()) || 0
  return { isShallow, commitCount }
}

// ───────────────────────────── 模式二：历史（--history / --pre-push） ─────────────────────────────
function objectPaths(refArgs) {
  const out = gitBuffer(['rev-list', '--objects', ...refArgs]).toString('utf8')
  const map = new Map()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const sp = line.indexOf(' ')
    const sha = line.slice(0, sp)
    const p = line.slice(sp + 1).trim()
    if (!p) continue
    if (!map.has(sha)) map.set(sha, [])
    map.get(sha).push(p)
  }
  return map
}

/** 流式读 git cat-file --batch：按头部声明的字节长度精确切块，不靠换行猜边界 */
function streamObjects(shas, onBlob) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', ROOT, 'cat-file', '--batch'])
    proc.on('error', reject)
    let buf = Buffer.alloc(0)
    let pending = null
    proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (pending) {
          if (buf.length < pending.size + 1) return
          const data = buf.subarray(0, pending.size)
          buf = buf.subarray(pending.size + 1)
          if (pending.kind === 'blob') onBlob(pending.sha, data)
          pending = null
          continue
        }
        const nl = buf.indexOf(0x0a)
        if (nl < 0) return
        const header = buf.subarray(0, nl).toString('utf8')
        buf = buf.subarray(nl + 1)
        const m = /^([0-9a-f]{40})\s+(\S+)\s+(\d+)$/.exec(header)
        if (m) pending = { sha: m[1], kind: m[2], size: Number(m[3]) }
      }
    })
    proc.stderr.on('data', (d) => process.stderr.write(d))
    proc.on('close', resolve)
    proc.stdin.write(shas.join('\n') + '\n')
    proc.stdin.end()
  })
}

function splitFields(rec) {
  return rec.split('\0')
}

/** for-each-ref 的 %(xxxemail) 返回 `<user@host>` 形态，log 的 %ae 返回裸地址——统一剥掉尖括号 */
const bareEmail = (s) => (s || '').trim().replace(/^<(.*)>$/, '$1')

function scanCommits(refArgs) {
  const raw = gitBuffer(['log', ...refArgs, '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00']).toString('utf8')
  const recs = raw.split('\n').map((s) => s.trim()).filter(Boolean)
  for (const rec of recs) {
    const [sha, an, ae, cn, ce] = splitFields(rec)
    for (const [who, raw0] of [['author', ae], ['committer', ce]]) {
      const email = bareEmail(raw0)
      if (!email) continue
      if (!ALLOWED_IDENTITIES.some((re) => re.test(email))) {
        hit(`commit ${sha.slice(0, 12)} ${who}`, 'commit-identity', `提交${who}邮箱不在允许清单（历史重写代价极高，写错就晚了）`)
      }
    }
    if (suspiciousName(an) || suspiciousName(cn)) {
      hit(`commit ${sha.slice(0, 12)}`, 'identity-shape', '提交作者名是纯数字账号形态（QQ 号当名字用）')
    }
  }
  // 注解标签的 tagger 同样公开可见（2026-09-12 清洗时正是这里漏过一遍）
  const tags = gitBuffer(['for-each-ref', 'refs/tags', '--format=%(refname)%00%(taggername)%00%(taggeremail)%00']).toString('utf8')
  for (const line of tags.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const [ref, tn, raw1] = splitFields(line)
    const te = bareEmail(raw1)
    if (!te) continue
    if (!ALLOWED_IDENTITIES.some((re) => re.test(te))) {
      if (suspiciousName(tn)) hit(`tag ${ref}`, 'identity-shape', '标签 tagger 名是纯数字账号形态')
      else hit(`tag ${ref}`, 'commit-identity', '标签 tagger 邮箱不在允许清单')
    }
  }
}

async function scanHistory(refArgs) {
  scanCommits(refArgs)
  const paths = objectPaths(refArgs)
  const shas = [...paths.keys()]
  await streamObjects(shas, (sha, data) => {
    if (isBinary(data)) return
    const where = (paths.get(sha) || []).join(',') || `blob ${sha.slice(0, 12)}`
    const soft = (paths.get(sha) || ['x']).every((p) => softFor(p))
    scanText(where, data.toString('utf8'), { soft })
    if (SERVER_CONFIG_PATHS.includes(where.replace(/:.*/, ''))) {
      hit(where, 'server-config', '打包服务配置文件出现在历史中')
    }
  })
}

// ───────────────────────────── 模式三：pre-push stdin ─────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c))).toString('utf8')
}

async function scanPrePush() {
  const stdin = await readStdin()
  const lines = stdin.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) {
    // 无 stdin（手动调用）时退化为全历史扫描，宁可多查不可漏查
    await scanHistory(['--all'])
    return
  }
  const ranges = []
  for (const line of lines) {
    const [localRef, localOid, remoteRef, remoteOid] = line.split(/\s+/)
    if (!localOid || ZERO_OID.test(localOid)) continue // 删除分支：无新内容
    // 只查「本次新引入」的提交与对象：已发布的历史残留不该让每次推送都红（那只会逼人用
    // --no-verify），但把旧分支合回来 / 从旧克隆推回来会落进 range，正是要拦的场景。
    const known = remoteOid && !ZERO_OID.test(remoteOid) && objectExists(remoteOid)
    const spec = known ? `${remoteOid}..${localOid}` : localOid
    ranges.push(spec)
    process.stdout.write(`· 检查 ${localRef || remoteRef || '(无 ref)'} → ${localOid.slice(0, 12)}（${known ? '增量' : '全新'}）\n`)
  }
  if (!ranges.length) return
  scanCommits(ranges)
  const paths = objectPaths(ranges)
  await streamObjects([...paths.keys()], (sha, data) => {
    if (isBinary(data)) return
    const where = (paths.get(sha) || []).join(',') || `blob ${sha.slice(0, 12)}`
    const soft = (paths.get(sha) || ['x']).every((p) => softFor(p))
    scanText(where, data.toString('utf8'), { soft })
  })
}

// ───────────────────────────── 历史口径的"审不了就红" ─────────────────────────────
/** 不可审 ⇒ 立即 rc=2 并给出修法（**绝不打印"通过"**：假绿比没门禁更糟） */
function assertAuditableHistory(mode) {
  const scope = historyAuditScope(readHistoryAuditStatus())
  if (scope.usable) return
  process.stderr.write(
    `✗ 公开仓泄漏门禁（${mode}）拒绝执行：${scope.reason}\n` +
      `  边界另记：CI 上 --all 只含**被检出的那根分支**，其它分支/标签与账号外围（AGENTS §一.9 第④⑤层）\n` +
      `  仍须本地/人工盘——本门禁绿，不等于"公开面已盘完"。\n`,
  )
  process.exit(2)
}

// ───────────────────────────── 入口 ─────────────────────────────
async function main() {
  const mode = (process.argv[2] || '--all').replace(/^--/, '')
  if (mode === 'all') scanTracked()
  else if (mode === 'history') {
    assertAuditableHistory(mode)
    await scanHistory(['--all'])
  } else if (mode === 'pre-push') {
    assertAuditableHistory(mode)
    await scanPrePush()
  }
  else {
    process.stderr.write('用法：check-no-secrets.mjs [--all|--history|--pre-push]\n')
    process.exit(2)
  }

  if (findings.length) {
    process.stderr.write(`\n✗ 公开仓泄漏门禁：${findings.length} 处命中（值不回显，按规则定位）\n`)
    for (const f of findings) process.stderr.write(`  ${f.where}  rule=${f.rule}  —— ${f.why}\n`)
    process.stderr.write(
      `\n  处置：改内容 / 改提交身份；确属误报的写进 scripts/leak-allowlist.mjs 并注明理由。\n` +
        `  规则清单：node scripts/check-no-secrets.mjs --rules\n` +
        `  注意：文件里删掉不等于清除——已推送过的内容会留在公开历史里（本仓已为此重写过一次历史）。\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`✓ 公开仓泄漏门禁通过（${mode}）\n`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain && process.argv.includes('--rules')) {
  for (const r of [...HARD_RULES, ...SOFT_RULES, { name: 'ip-address', why: '非回环 IPv4（公网与内网地址均不外泄）' }, { name: 'commit-identity', why: '提交/标签身份必须在允许清单内' }, { name: 'identity-shape', why: '作者/tagger 显示名是纯数字账号形态（QQ 号当名字）' }]) {
    process.stdout.write(`  ${r.name}  ${r.why || ''}\n`)
  }
  process.exit(0)
}

if (isMain) main().catch((e) => {
  process.stderr.write(`门禁自身异常：${e && e.stack ? e.stack : e}\n`)
  process.exit(2)
})
