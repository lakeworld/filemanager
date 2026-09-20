import { describe, it, expect } from 'vitest'
import { collectFailures, readInputs } from '../../scripts/check-version-sync.mjs'

/**
 * 版本一致性门禁的单测（v2.5.9/A3+A5）。
 *
 * 规矩（`DEBUG-SOP.md` §三）：**任何"防回潮"断言提交前必须做一次反向实验**——
 * 只验"当前树绿"等于没验（判据可能恒真）。所以每条判据都在这里被注入一次错误、断言它响。
 */

/** 一份"四处全对"的输入，各用例只改一处 */
function good(overrides = {}) {
  return {
    version: '2.5.9',
    changelog: '# 更新日志\n\n## v2.5.9（2026-09-24）\n\n- 开门见山\n',
    readme: '[![Version](https://img.shields.io/badge/Version-v2.5.9-green.svg)]()',
    releaseExists: true,
    tutorials: [],
    releaseDirPresent: false,
    ...overrides,
  }
}

describe('版本一致性门禁（check-version-sync）', () => {
  it('四处全对 ⇒ 无失败项', () => {
    expect(collectFailures(good())).toEqual([])
  })

  it('反向实验 ①：CHANGELOG 缺段头 ⇒ 红', () => {
    const failures = collectFailures(good({ changelog: '## v2.5.8\n' }))
    expect(failures.some((f) => f.includes('CHANGELOG.md 缺'))).toBe(true)
  })

  it('反向实验 ②：README badge 漏跟 ⇒ 红（历史上真实漏过的那一处）', () => {
    const failures = collectFailures(good({ readme: 'Version-v2.5.8-green' }))
    expect(failures.some((f) => f.includes('README.md badge'))).toBe(true)
  })

  it('反向实验 ③：RELEASE 说明文件不存在 ⇒ 红', () => {
    const failures = collectFailures(good({ releaseExists: false }))
    expect(failures.some((f) => f.includes('docs/RELEASE-2.5.9.md 不存在'))).toBe(true)
  })

  it('反向实验 ④：version 形态非法（把 v 前缀写进 package.json）⇒ 红', () => {
    const failures = collectFailures(good({ version: 'v2.5.9' }))
    expect(failures.some((f) => f.includes('形态非法'))).toBe(true)
  })

  it('反向实验 ⑤：归位教程残留旧版本号 ⇒ 红且点名文件（A5 停发判据）', () => {
    const failures = collectFailures(
      good({
        releaseDirPresent: true,
        tutorials: [
          { file: '软件发布包/2.5.9/deb/安装教程-Linux.md', text: '适用于 2.5.9，历史写法 2.5.1 不该出现' },
          { file: '软件发布包/2.5.9/win/安装教程-Windows.md', text: '适用于 2.5.9' },
        ],
      }),
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('2.5.1')
    expect(failures[0]).toContain('安装教程-Linux.md')
  })

  it('边界 ⑥：发布包未归位时教程自检按纪律跳过（不算红，也不假装验过）', () => {
    const failures = collectFailures(good({ releaseDirPresent: false, tutorials: [{ file: 'x', text: '2.5.1' }] }))
    expect(failures).toEqual([])
  })

  it('边界 ⑦：教程里写 Electron 版本号不误伤（只认 2.5.x 产品版形态）', () => {
    const failures = collectFailures(
      good({ releaseDirPresent: true, tutorials: [{ file: 't.md', text: '本教程用 Electron 31.7.7 构建' }] }),
    )
    expect(failures).toEqual([])
  })

  it('集成：当前树真读文件必须绿（这四个文件在仓里）', () => {
    const inputs = readInputs()
    expect(inputs.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(collectFailures(inputs)).toEqual([])
  })
})