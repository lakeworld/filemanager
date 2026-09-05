import { describe, it, expect } from 'vitest'
import { e2eUserDataDirName } from '../e2e/helpers/launch'

/** v2.5.8 A4（台账 D-07）：per-spec e2e userData 隔离 helper 纯函数 */
describe('e2e launch helpers', () => {
  it('目录名 = qihebox-e2e-<label>', () => {
    expect(e2eUserDataDirName('smoke')).toBe('qihebox-e2e-smoke')
    expect(e2eUserDataDirName('profile-account')).toBe('qihebox-e2e-profile-account')
  })
})
