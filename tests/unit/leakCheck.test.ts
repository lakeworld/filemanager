/**
 * 公开仓泄漏门禁单测（2026-09-12 隐私清洗事故固化，脚本 = scripts/check-no-secrets.mjs）：
 *
 * 覆盖三件事，缺一不可：
 * 1. **自举证**：对本仓当前跟踪文件跑 `--all` 必须绿——门禁自己红着就没有下一步；
 * 2. **反向实验**（AGENTS.md §一.8 的纪律）：六类违规逐条注入 fixture 仓，断言**必红**且
 *    报出的是对应规则名；漏一类即等于当年那 227 笔提交会再次溜过白名单；
 * 3. **不误报**：占位服务地址、程序集版本号、回环/文档段 IP、允许身份必须放过，
 *    并验证 leak-allowlist 的精确豁免真的生效（否则第一线的 CI 会被噪音淹没）。
 *
 * fixture 用临时 git 仓 + `QH_LEAK_ROOT` 注入，不碰真仓对象库。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRIPT = path.resolve(__dirname, '../../scripts/check-no-secrets.mjs')
// v2.5.9/A2 补：历史口径"审不了就红"的纯判据（脚本有 isMain 守卫，可安全 import）
import { historyAuditScope } from '../../scripts/check-no-secrets.mjs'

/** 在 fixture 仓里跑门禁；args 为脚本参数（--all / --history） */
function runLeak(root: string, args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, QH_LEAK_ROOT: root },
  })
  return { status: r.status ?? 2, all: `${r.stdout}${r.stderr}` }
}

/** 建一个最小 git fixture 仓：写入 files（相对路径 → 内容），以指定身份提交一次 */
function mkRepo(
  files: Record<string, string | Buffer>,
  identity: { name?: string; email?: string } = { name: '启禾软件', email: 'ai_qihe@vip.qq.com' },
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qihe-leak-'))
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
  }
  git('init', '-q', '-b', 'main')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  git('add', '-A')
  git('-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-q', '-m', 'fixture')
  return dir
}

/**
 * 门禁样本值：刻意用经典占位号 `13800138000`（本仓既有测试一直在用的假号）拼出，
 * 且**运行时 join**——把真值或形似真值的字面量直接写进公开源码，等于自己造一次泄漏。
 */
const PRIVATE_ID = ['13800138000', 'qq.com'].join('@')
/** 纯数字显示名样本（QQ 号当名字用的形态） */
const NUMERIC_NAME = '13800138000'

describe('check-no-secrets —— 公开仓泄漏门禁', () => {
  it('自举证：本仓全部历史（含不可达外的所有 ref 可达对象）零命中', () => {
    // 2026-09-12 清洗的常驻防守：历史里再进一条私人标识就红在这里，而不是等下一次开源发布
    const r = spawnSync(process.execPath, [SCRIPT, '--history'], { encoding: 'utf8' })
    const all = `${r.stdout}${r.stderr}`
    expect(all, all).toContain('✓')
    expect(r.status).toBe(0)
  })

  it('自举证：本仓当前跟踪文件必须零命中（不注入 QH_LEAK_ROOT，顺带验默认根目录解析）', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--all'], { encoding: 'utf8' })
    const all = `${r.stdout}${r.stderr}`
    expect(all, all).toContain('✓')
    expect(r.status).toBe(0)
  })

  it('干净 fixture 不误报（允许身份 + 占位地址 + 回环 + 版本号）', () => {
    const dir = mkRepo({
      'README.md': '自建部署写 `{"apiBase": "https://your-server/api"}` 后重启\n',
      'src/a.ts': 'const loopback = "127.0.0.1"\nconst doc = "192.0.2.1"\nconst v = "version=\\"6.0.0.0\\""\n',
    })
    expect(runLeak(dir, ['--all']).status).toBe(0)
    expect(runLeak(dir, ['--history']).status).toBe(0)
  })

  const cases: Array<[string, string, string | Buffer]> = [
    ['personal-email', 'docs/x.md', `联系 ${PRIVATE_ID}\n`],
    ['local-path', 'docs/y.md', '产物在 /home/zhangsan/下载/x.AppImage\n'],
    ['sync-dir', 'docs/z.md', '工作区在 我的坚果云/启禾 下\n'],
    ['private-key', 'keys/id.pem', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnZ2MAoK\n-----END OPENSSH PRIVATE KEY-----\n'],
    ['credential-assign', 'src/conf.ts', 'const apiKey = "Zm9vYmFyLXNlY3JldC12YWx1ZS0xMjM0"\n'],
    ['url-with-credentials', 'src/db.ts', 'const url = "postgres://admin:S3cr3tPass@db.internal:5432/app"\n'],
    ['ip-address', 'src/host.ts', 'const server = "10.20.30.40"\n'],
  ]
  for (const [rule, rel, content] of cases) {
    it(`反向实验：注入 ${rule} 必红`, () => {
      const dir = mkRepo({ [rel]: content })
      const r = runLeak(dir, ['--all'])
      expect(r.status).toBe(1)
      expect(r.all).toContain(`rule=${rule}`)
      // 纪律：只报位置与规则名，绝不回显命中值本身
      expect(r.all).not.toContain('S3cr3tPass')
      expect(r.all).not.toContain('Zm9vYmFy')
    })
  }

  it('反向实验：提交身份不在允许清单时 --history 必红', () => {
    const dir = mkRepo({ 'a.md': 'hi\n' }, { name: 'lake', email: 'someone@example.org' })
    const r = runLeak(dir, ['--history'])
    expect(r.status).toBe(1)
    expect(r.all).toContain('rule=commit-identity')
  })

  it('反向实验：注解标签的 tagger 身份也要查（2026-09-12 清洗时正是这里漏过一遍）', () => {
    const dir = mkRepo({ 'a.md': 'hi\n' })
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    }
    // 分支提交用允许身份，但标签用私人身份签——重写历史时最容易漏的一类
    git(
      '-c',
      'user.name=lake',
      '-c',
      'user.email=someone@example.org',
      'tag',
      '-a',
      'retired/x',
      '-m',
      'fixture 注解标签',
    )
    const r = runLeak(dir, ['--history'])
    expect(r.status).toBe(1)
    expect(r.all).toContain('tag refs/tags/retired/x')
    expect(r.all).toContain('rule=commit-identity')
  })

  it('反向实验：泄漏提交被当增量推回时，pre-push 必红（旧分支回流就是这条路）', () => {
    const dir = mkRepo({ 'a.md': '干净首版\n' })
    fs.writeFileSync(path.join(dir, 'leak.md'), `联系 ${PRIVATE_ID}\n`)
    const git2 = (...a: string[]) => {
      const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    }
    git2('add', '-A')
    git2('-c', 'user.name=启禾软件', '-c', 'user.email=ai_qihe@vip.qq.com', 'commit', '-q', '-m', '带泄漏的第二笔')
    const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const base = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim()
    const stdinLine = `refs/heads/main ${head} refs/heads/main ${base}\n`
    const r = spawnSync(process.execPath, [SCRIPT, '--pre-push'], {
      encoding: 'utf8',
      input: stdinLine,
      env: { ...process.env, QH_LEAK_ROOT: dir },
    })
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('rule=personal-email')
  })

  it('增量口径不追溯历史：整段推为全新（remote_oid 全 0）时才按全量查', () => {
    const dir = mkRepo({ 'a.md': '干净\n' })
    const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const zeros = '0'.repeat(40)
    const r = spawnSync(process.execPath, [SCRIPT, '--pre-push'], {
      encoding: 'utf8',
      input: `refs/heads/main ${head} refs/heads/main ${zeros}\n`,
      env: { ...process.env, QH_LEAK_ROOT: dir },
    })
    expect(`${r.stdout}${r.stderr}`).toContain('（全新）')
    expect(r.status).toBe(0)
  })

  it('反向实验：作者显示名是纯数字账号形态（QQ 号当名字）也要红', () => {
    const dir = mkRepo({ 'a.md': 'hi\n' }, { name: NUMERIC_NAME, email: 'ai_qihe@vip.qq.com' })
    const r = runLeak(dir, ['--history'])
    expect(r.status).toBe(1)
    expect(r.all).toContain('rule=identity-shape')
  })

  it('二进制 blob 跳过（NUL 字节内容不做文本规则）', () => {
    const buf = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from([0, 1, 2, 0]), Buffer.from(PRIVATE_ID)])
    const dir = mkRepo({ 'assets/bin.dat': buf })
    expect(runLeak(dir, ['--all']).status).toBe(0)
  })

  it('例外清单精确生效：同形四段数字在豁免路径内不报，换路径即报', () => {
    const allowed = mkRepo({ 'tests/unit/moneyInput.test.ts': 'expect(f("1.2.3.4")).toBe("1.234")\n' })
    expect(runLeak(allowed, ['--all']).status).toBe(0)
    const notAllowed = mkRepo({ 'src/other.ts': 'expect(f("1.2.3.4")).toBe("1.234")\n' })
    expect(runLeak(notAllowed, ['--all']).status).toBe(1)
  })

  it('跟踪 build/server.json 即红（真实服务地址严禁进仓）', () => {
    const dir = mkRepo({ 'build/server.json': '{}\n' })
    const r = runLeak(dir, ['--all'])
    expect(r.status).toBe(1)
    expect(r.all).toContain('rule=server-config')
  })

  // ───────────── v2.5.9/A2 补：CI 假绿根治（浅克隆下历史口径不得报"通过"）─────────────

  it('纯判据：浅克隆 ⇒ 不可审，且理由里带修法（fetch-depth / unshallow）', () => {
    const r = historyAuditScope({ isShallow: true, commitCount: 1 })
    expect(r.usable).toBe(false)
    expect(r.reason).toContain('浅克隆')
    expect(r.reason).toContain('fetch-depth: 0')
  })

  it('纯判据只看结构性信号：非浅克隆的单提交仓**必须可审**（那一个提交里就可能藏着私人邮箱）', () => {
    // 反向实验的本体：第一版多加过一条"提交数 ≤1 判不可审"，把 5 条既有 fixture 用例打红——
    // "内容少"不是"审不了"，只有浅克隆才是。这条断言防的就是把判据写宽。
    expect(historyAuditScope({ isShallow: false, commitCount: 1 }).usable).toBe(true)
    expect(historyAuditScope({ isShallow: false, commitCount: 2 }).usable).toBe(true)
  })

  it('集成：浅克隆跑 --history 必须 rc=2 且不出现"通过"；同仓完整跑必须 rc=0', () => {
    // fixture：两个提交（避免"提交数 ≤1"这条把集成用例挡掉）
    const dir = mkRepo({ 'README.md': '# fixture\n' })
    const git = (...a: string[]) => {
      const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    }
    fs.writeFileSync(path.join(dir, 'notes.md'), 'second commit\n')
    git('add', '-A')
    git('-c', 'user.name=启禾软件', '-c', 'user.email=ai_qihe@vip.qq.com', 'commit', '-q', '-m', 'fixture 2')

    // 完整（非浅）克隆 ⇒ 历史口径正常绿
    expect(runLeak(dir, ['--history']).status).toBe(0)

    // 浅克隆（照 CI checkout 默认 depth=1 的形态）⇒ 必须拒绝执行，而不是打印"通过"
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'qihe-leak-'))
    const clone = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, path.join(shallow, 'w')], { encoding: 'utf8' })
    expect(clone.status, `git clone 失败：${clone.stderr}`).toBe(0)
    const r = runLeak(path.join(shallow, 'w'), ['--history'])
    expect(r.status).toBe(2)
    expect(r.all).toContain('浅克隆')
    expect(r.all).not.toContain('泄漏门禁通过')
  })
})
