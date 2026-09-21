/**
 * A8 共享纯逻辑单测（`src/shared/accountApi.ts`）。
 *
 * 这文件存在的意义：主进程与渲染层**共用**这份文案与形状判定，所以它的每条分支都得钉住——
 * 尤其是"两个都会命中"的重叠分支（用户名冲突 vs 邮箱已注册），漏一条就会把用户引去
 * 登录一个根本不存在的账号。
 */
import { describe, expect, it } from 'vitest'
import {
  isUsernameConflict,
  looksLikeEmail,
  mapAccountApiError,
  MIN_PASSWORD_LEN,
  usernameFromEmail,
  withRandomSuffix,
} from '../../src/shared/accountApi'

describe('usernameFromEmail', () => {
  it('取邮箱前缀并保留点号', () => {
    expect(usernameFromEmail('Zhang.San@example.com')).toBe('Zhang.San')
  })
  it('非法字符换成 -，首尾 - 去掉', () => {
    expect(usernameFromEmail('  中文 name@x.com')).toBe('name')
    expect(usernameFromEmail('a b@c.com')).toBe('a-b')
  })
  it('前缀整个非法 ⇒ 回落 user（不返回空串，空 username 服务端必拒）', () => {
    expect(usernameFromEmail('中文@x.com')).toBe('user')
  })
})

describe('withRandomSuffix / 冲突判定', () => {
  it('后缀可注入随机源 ⇒ 结果确定可断言', () => {
    expect(withRandomSuffix('zhang', () => 0)).toBe('zhang1000')
    expect(withRandomSuffix('zhang', () => 0.99999)).toBe('zhang9999')
  })
  it('超长前缀先截到 24 再拼（PocketBase username 长度有限）', () => {
    const long = 'x'.repeat(40)
    expect(withRandomSuffix(long, () => 0).length).toBeLessThanOrEqual(28)
  })
  it('只认"username + 占用"的组合，不误伤邮箱重复', () => {
    expect(isUsernameConflict('username with value "z" already exists')).toBe(true)
    expect(isUsernameConflict('邮箱已被使用')).toBe(false)
    expect(isUsernameConflict('username invalid')).toBe(false)
  })
})

describe('looksLikeEmail / 密码下限', () => {
  it('拦明显打错的输入', () => {
    expect(looksLikeEmail('a@b.co')).toBe(true)
    expect(looksLikeEmail('a@b')).toBe(false)
    expect(looksLikeEmail('a b@c.com')).toBe(false)
    expect(looksLikeEmail('  ')).toBe(false)
  })
  it('密码下限 8 位（与官网注册口径一致）', () => {
    expect(MIN_PASSWORD_LEN).toBe(8)
  })
})

describe('mapAccountApiError 逐分支', () => {
  it('429 ⇒ 限流文案（不看服务端原话，PB 的英文 message 对用户无意义）', () => {
    expect(mapAccountApiError('register', 429, 'Too Many Requests')).toContain('操作过于频繁')
  })
  it('验证码错误/过期 ⇒ 引导重取', () => {
    expect(mapAccountApiError('email-confirm', 400, 'invalid verification code')).toContain('验证码错误或已过期')
    expect(mapAccountApiError('email-confirm', 400, 'code expired')).toContain('验证码错误或已过期')
  })
  it('register：邮箱重复 ⇒ 引导去登录', () => {
    expect(mapAccountApiError('register', 400, '邮箱已注册')).toContain('该邮箱已注册')
    expect(mapAccountApiError('register', 409, '')).toContain('该邮箱已注册')
  })
  it('register：用户名占用 ⇒ 与邮箱重复**分开**说', () => {
    expect(mapAccountApiError('register', 400, 'username already exists')).toContain('用户名已被占用')
  })
  it('有原话就透传（v2.5.1 登录 D3/D9 口径），但限长 200 防撑破布局', () => {
    const long = '问'.repeat(300)
    expect(mapAccountApiError('captcha', 400, long).length).toBeLessThanOrEqual(200)
    expect(mapAccountApiError('email-request', 400, 'smtp down')).toBe('smtp down')
  })
  it('反向实验：无原话 ⇒ 各调用有自己的兜底句（不共用一句"失败请重试"）', () => {
    expect(mapAccountApiError('captcha', 500, '')).toContain('点击图片重试')
    expect(mapAccountApiError('register', 500, '')).toContain('注册失败')
    expect(mapAccountApiError('email-request', 500, '')).toContain('验证邮件发送失败')
    expect(mapAccountApiError('email-confirm', 500, '')).toContain('验证失败')
  })
})