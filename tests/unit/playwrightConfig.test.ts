import { describe, expect, it } from 'vitest'
import config from '../../playwright.config'
import soakConfig from '../../playwright.memory-soak.config'

describe('Playwright 回归配置', () => {
  it('应保留失败产物并默认排除 soak 与 conformance 套件', () => {
    expect(config.use).toMatchObject({
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'retain-on-failure',
    })
    expect(config.testIgnore).toEqual(expect.arrayContaining(['**/conformance/**', '**/memory-soak.spec.ts']))
  })

  it('memory-soak 独立配置：仅收集 soak、禁用诊断产物（T8）', () => {
    expect(soakConfig.testMatch).toEqual(expect.arrayContaining(['**/memory-soak.spec.ts']))
    expect(soakConfig.use).toMatchObject({ trace: 'off', video: 'off', screenshot: 'off' })
    expect(soakConfig.timeout).toBeGreaterThanOrEqual(30 * 60 * 1000)
  })
})
