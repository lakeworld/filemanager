/**
 * paths.ts 受保护配置路径判定单测（v2.5.3 T2）：
 * .qihefilemanager/ 下的配置/台账 JSON 只允许事务化写路径，禁止文件直写旁路。
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { isProtectedConfigPath, cmDir } from '../../src/main/core/paths'

describe('isProtectedConfigPath（v2.5.3 T2）', () => {
  const ws = '/work/我的工作区'

  it('.qihefilemanager 目录本身受保护', () => {
    expect(isProtectedConfigPath(ws, cmDir(ws))).toBe(true)
  })

  it('.qihefilemanager 下的任意文件（config/metadata/customers 等）受保护', () => {
    expect(isProtectedConfigPath(ws, path.join(cmDir(ws), 'metadata.json'))).toBe(true)
    expect(isProtectedConfigPath(ws, path.join(cmDir(ws), 'config.json'))).toBe(true)
    expect(isProtectedConfigPath(ws, path.join(cmDir(ws), 'sub', 'nested.json'))).toBe(true)
  })

  it('工作区用户内容路径不受保护', () => {
    expect(isProtectedConfigPath(ws, path.join(ws, '产品集', 'A', '说明.md'))).toBe(false)
    expect(isProtectedConfigPath(ws, path.join(ws, '图包', 'img.jpg'))).toBe(false)
  })

  it('工作区之外不受保护（由 isPathInsideWorkspaceReal 兜底）', () => {
    expect(isProtectedConfigPath(ws, '/other/.qihefilemanager/metadata.json')).toBe(false)
  })

  it('路径归一化：相对路径与 .. 解析后判定', () => {
    // 本函数接受绝对路径输入（调用方已先做工作区校验）；此处验证 resolve 语义不误判
    const base = '/work/我的工作区'
    expect(isProtectedConfigPath(base, path.join(base, '.qihefilemanager', '..', '.qihefilemanager', 'tags.json'))).toBe(true)
  })
})