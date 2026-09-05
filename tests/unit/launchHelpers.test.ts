import { describe, it, expect } from 'vitest'
import { e2eUserDataDirName, e2eUserDataDir, e2eLaunchEnv } from '../e2e/helpers/launch'
import os from 'node:os'
import path from 'node:path'

/** v2.5.8 A4（台账 D-07）：per-spec e2e userData 隔离 helper 纯函数 */
describe('e2e launch helpers', () => {
  it('目录名 = qihebox-e2e-<label>', () => {
    expect(e2eUserDataDirName('smoke')).toBe('qihebox-e2e-smoke')
    expect(e2eUserDataDirName('profile-account')).toBe('qihebox-e2e-profile-account')
  })

  it('绝对路径 = tmpdir/<目录名>', () => {
    expect(e2eUserDataDir('smoke')).toBe(path.join(os.tmpdir(), 'qihebox-e2e-smoke'))
  })

  it('env 组装：QIHEBOX_E2E=1 + USERDATA 目录名 + 保留 process.env', () => {
    const env = e2eLaunchEnv('smoke')
    expect(env.QIHEBOX_E2E).toBe('1')
    expect(env.QIHEBOX_E2E_USERDATA).toBe('qihebox-e2e-smoke')
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('env 附加项可覆盖默认（如 QIHEBOX_AUTOSTART）且 USERDATA 不可被 extra 误覆盖语义……覆盖优先级：extra 后置生效', () => {
    const env = e2eLaunchEnv('smoke', { QIHEBOX_AUTOSTART: '1' })
    expect(env.QIHEBOX_AUTOSTART).toBe('1')
    const overridden = e2eLaunchEnv('smoke', { QIHEBOX_E2E_USERDATA: 'custom' })
    expect(overridden.QIHEBOX_E2E_USERDATA).toBe('custom')
  })
})
