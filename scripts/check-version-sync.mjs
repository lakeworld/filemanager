#!/usr/bin/env node
/**
 * 版本一致性门禁（v2.5.9/A3 + A5 收口：唯一权威清单 = `docs/INTERNAL/RELEASE-RUNBOOK.md` §「版本号」）
 *
 * 为什么需要它：bump 的"四处"曾在三份文档里各写一份清单（`AGENTS.md` §三 / RUNBOOK / D20 动作卡），
 * 结果实测 README badge 被漏在外面——**清单多源 = 必然漂移**。本脚本把那一条清单变成可执行的判据：
 *
 *   ① `package.json` version（唯一来源，electron-builder 读它）
 *   ② `CHANGELOG.md` 有 `## v<ver>` 段头
 *   ③ `README.md` badge 写着 `Version-v<ver>-`
 *   ④ `docs/RELEASE-<ver>.md` 存在
 *   ⑤ 发布包**归位后**：`软件发布包/<本版>/{deb,win}/安装教程-*.md` 里不得出现非本版版本号（A5 的「红即停发」）
 *
 * ⑤ 的三条边界（都是实测踩出来的，别简化掉）：
 *   ① 只看**本版目录** `软件发布包/<version>/`——历史目录（`2.5.7/` 里躺着 `2.5.1`）按 A5 裁决
 *      「早已发出，改了帮不到已下载的人」**故意不改**，把它算红等于让门禁常年红；
 *   ② `软件发布包/` 被 `.gitignore` 挡住、不在版本库里 ⇒ 本版目录缺失时**跳过并如实打印**，
 *      不判红（否则是"CI 永远跳、本地永远红"的假门禁）；
 *   ③ 母本 `软件发布包/安装教程-*.md`（无版本目录，供下次复制）也算**本版口径**一并查。
 * 官网 `version.json` 不属本仓（由 `scripts/publish-box-installer.sh` 现算 sha256 后写），故不在此验。
 *
 * 用法：`npm run check:version-sync`（CI test job 常驻，零依赖、紧跟泄漏门禁跑）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = '软件发布包'
/** 教程正文里的版本号字面量：只认 2.5.x 这类产品版形态，避免把 Electron/Node 版本当靶子 */
const VERSION_LITERAL = /2\.\d+\.\d+/g

/**
 * 纯函数判据（单测入口）：喂进四处文本 + 教程清单，吐失败项。
 * 反向实验见 `tests/unit/versionSync.test.ts`——每条判据都必须能被注入的错误打动。
 */
export function collectFailures(input) {
  const failures = []
  const { version, changelog = '', readme = '', releaseExists = false, tutorials = [], releaseDirPresent = false } = input

  if (!/^\d+\.\d+\.\d+$/.test(String(version))) failures.push(`package.json version 形态非法：${version}`)
  if (!changelog.includes(`## v${version}`)) failures.push(`CHANGELOG.md 缺「## v${version}」段头`)
  if (!readme.includes(`Version-v${version}-`)) failures.push(`README.md badge 未跟到 v${version}（历史上漏过一次的就是它）`)
  if (!releaseExists) failures.push(`docs/RELEASE-${version}.md 不存在`)

  if (releaseDirPresent) {
    const offenders = tutorials
      .map((t) => ({ file: t.file, stray: [...new Set((t.text.match(VERSION_LITERAL) || []).filter((v) => v !== version))] }))
      .filter((x) => x.stray.length > 0)
    if (offenders.length > 0) {
      failures.push(
        `归位教程里出现非本版版本号 ⇒ 停发（A5）：${offenders.map((o) => `${o.file}=[${o.stray.join(', ')}]`).join('；')}`,
      )
    }
  }
  return failures
}

/** 从真实文件系统读四处 + 教程（供 CLI 与集成断言用） */
export function readInputs(root = ROOT) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const readIfAny = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      return ''
    }
  }
  const releaseDirAbs = path.join(root, RELEASE_DIR)
  /** 本版归位目录 + 母本正文（历史版本目录**有意**不查，见头注⑤①） */
  const versionDirAbs = path.join(releaseDirAbs, version)
  const releaseDirPresent = fs.existsSync(versionDirAbs)
  const tutorials = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (/^安装教程-.*\.md$/.test(entry.name)) {
        tutorials.push({ file: path.relative(root, abs), text: fs.readFileSync(abs, 'utf8') })
      }
    }
  }
  if (releaseDirPresent) walk(versionDirAbs)
  if (fs.existsSync(releaseDirAbs)) {
    for (const entry of fs.readdirSync(releaseDirAbs, { withFileTypes: true })) {
      if (entry.isFile() && /^安装教程-.*\.md$/.test(entry.name)) {
        const abs = path.join(releaseDirAbs, entry.name)
        tutorials.push({ file: path.relative(root, abs), text: fs.readFileSync(abs, 'utf8') })
      }
    }
  }
  return {
    version,
    changelog: readIfAny('CHANGELOG.md'),
    readme: readIfAny('README.md'),
    releaseExists: fs.existsSync(path.join(root, `docs/RELEASE-${version}.md`)),
    tutorials,
    releaseDirPresent,
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const inputs = readInputs(ROOT)
  const failures = collectFailures(inputs)
  const scope = inputs.releaseDirPresent
    ? `四处 + 本版归位教程（${inputs.tutorials.length} 份）`
    : '四处（本版发布包未归位 ⇒ 教程自检跳过；历史目录按 A5 裁决不查，见脚本头注⑤）'
  if (failures.length === 0) {
    console.log(`[version-sync] ✓ v${inputs.version} 一致：${scope}`)
    process.exit(0)
  }
  console.error(`[version-sync] ✗ v${inputs.version} 版本一致性门禁红（${failures.length} 项）：`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}