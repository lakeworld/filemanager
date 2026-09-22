import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * A8（登录图形码 + 客户端内注册）三态 e2e —— **打本地桩服务，不碰现网**。
 *
 * 与 `profile-account.spec.ts` 的分工（两份都要，别合并）：那份钉"e2e 环境恒未登录"的既有口径
 * （无 baseUrl ⇒ 不联网）；本份钉 A8 新增的三态与**契约落地**（图码真渲染、码值真进头、注册链真走通）。
 * 桩服务打在 127.0.0.1 的随机端口，经 `QIHE_API_BASE` 注入主进程（三级回退的第一级），
 * 所以走的是**真实主进程 HTTP 客户端**，不是 mock 掉的渲染层——这是本用例的价值所在。
 *
 * 服务端字段形状照闭源仓的验证码中继实现与客户端登录 e2e 逐字抄，桩改得跟现网不一样就等于自证自。
 */
const CAPTCHA_ID = 'e2e-cap-1'
/** 1×1 透明 PNG（现网返回的就是带前缀的 data URL，桩照同一形状） */
/** 真·1×1 PNG（69 字节，python zlib+struct 现算并回解校验过签名/IHDR/IDAT/IEND，见 D28 卡 §四） */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mO4IycHAALyARlNudhnAAAAAElFTkSuQmCC'

interface Seen {
  url: string
  method: string
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

test.describe('账号区三态 · 图形码与注册链（v2.5.9 A8）', () => {
  test.describe.configure({ mode: 'serial' })

  let app: ElectronApplication
  let page: Page
  let server: http.Server
  const seen: Seen[] = []
  let apiBase = ''
  /** 让某个端点在下一次返回失败（测"码错换一张"这类分支用），用完自动复位 */
  let failNextAuth = false

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Record<string, unknown> = {}
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        } catch {
          // 非 JSON 请求体：原样保留空对象，断言时用不到它
        }
        seen.push({ url: req.url ?? '', method: req.method ?? 'GET', headers: req.headers, body })
        const json = (status: number, obj: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(obj))
        }
        const p = (req.url ?? '').split('?')[0]
        if (p === '/api/captcha') return json(200, { code: 200, captcha_id: CAPTCHA_ID, image: PNG_DATA_URL })
        if (p === '/api/collections/users/records') return json(200, { id: 'u-e2e-1' })
        if (p === '/api/auth/email-verification/request') return json(200, { code: 200 })
        if (p === '/api/auth/email-verification/confirm') return json(200, { code: 200 })
        if (p === '/api/collections/users/auth-with-password') {
          if (failNextAuth) {
            failNextAuth = false
            return json(400, { code: 400, message: 'captcha invalid' })
          }
          return json(200, { token: 'e2e-token', record: { id: 'u-e2e-1', email: String(body.identity ?? '') } })
        }
        // 心跳等其它端点：一律 200，别让登录后的心跳把会话判成过期
        return json(200, { code: 200 })
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`

    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_USERDATA: e2eUserDataDirName('account-captcha'),
        QIHE_API_BASE: apiBase,
      },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
  })

  test.afterAll(async () => {
    if (app) {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
    await new Promise<void>((r) => server.close(() => r()))
  })

  /** 进「我的」页并等账号区挂载（沿用 profile-account.spec.ts 的复位式导航，避免拉别页数据） */
  const gotoProfile = async (): Promise<void> => {
    await page.evaluate(() => {
      window.location.hash = '/__e2e-reset'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
    await page.evaluate(() => {
      window.location.hash = decodeURIComponent('/profile')
    })
    await page.waitForTimeout(400)
    await expect(page.getByRole('heading', { name: '账号' })).toBeVisible({ timeout: 15000 })
  }

  /** 回到未登录态（上一条用例可能已登录，账号文件是持久的） */
  const ensureLoggedOut = async (): Promise<void> => {
    const out = page.getByRole('button', { name: '登出' })
    if (await out.isVisible().catch(() => false)) {
      await out.click()
      await expect(page.getByPlaceholder('邮箱')).toBeVisible({ timeout: 10000 })
    }
  }

  const loginBtn = () => page.getByRole('button', { name: /^(登录|登录中\.\.\.)$/ })

  test('态① 未登录：图码由主进程取到并渲染成 <img>；按钮保持可点（必填闸门在提交处，见下一条）', async () => {
    await gotoProfile()
    await ensureLoggedOut()

    const img = page.getByAltText('图形验证码')
    await expect(img).toBeVisible({ timeout: 15000 })
    // 断 src 而不是断"请求发过"：证明 data URL 一路走到了渲染层（中间任何一环丢就白屏占位）
    expect(await img.getAttribute('src')).toBe(PNG_DATA_URL)
    // 只断 src 相等挡不住"base64 是坏串"（本用例第一版就踩了：串本身 padding 不对，
    // <img> 有固定宽高照样 visible，看着绿其实是一张解不开的图）⇒ 必须断**真解码出了像素**
    expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
    // v2.5.9 收口后图码必填，但 enforcement 在 handleLogin（点击即拦、给人话错误），
    // 不靠禁用按钮——禁用按钮点不下去，用户反而不知道差什么
    await expect(loginBtn()).toBeEnabled()

    const captchaReqs = seen.filter((s) => s.url === '/api/captcha')
    expect(captchaReqs.length).toBeGreaterThanOrEqual(1)
    expect(captchaReqs[0].headers['x-qihe-client']).toBe('box')
  })

  test('态① 未填码点登录 ⇒ 前端即拦：人话错误可见 + 零 auth 请求（必填红线）', async () => {
    await gotoProfile()
    await ensureLoggedOut()
    const authBefore = seen.filter((s) => s.url === '/api/collections/users/auth-with-password').length
    await page.getByPlaceholder('邮箱').fill('e2e-nocaptcha@qihe.test')
    await page.getByPlaceholder('密码').fill('e2epw12345')
    await loginBtn().click()

    await expect(page.getByText('请输入图形验证码')).toBeVisible({ timeout: 10000 })
    expect(seen.filter((s) => s.url === '/api/collections/users/auth-with-password').length).toBe(authBefore)
  })

  test('态① 点图码换一张（图码一次性，留在原图上重试必然再失败）', async () => {
    await gotoProfile()
    await ensureLoggedOut()
    const before = seen.filter((s) => s.url === '/api/captcha').length
    await page.getByAltText('图形验证码').click()
    await expect
      .poll(() => seen.filter((s) => s.url === '/api/captcha').length, { timeout: 10000 })
      .toBeGreaterThan(before)
  })

  test('态① 填码登录 ⇒ 码值真进 X-Captcha-Id/Value 头，服务端仍收得到 X-Qihe-Client: box', async () => {
    await gotoProfile()
    await ensureLoggedOut()
    await page.getByPlaceholder('邮箱').fill('e2e-login@qihe.test')
    await page.getByPlaceholder('密码').fill('e2epw12345')
    await page.getByPlaceholder('图形验证码（必填）').fill('9k2m')
    await loginBtn().click()

    await expect
      .poll(
        () => {
          const hits = seen.filter((s) => s.url === '/api/collections/users/auth-with-password')
          const last = hits[hits.length - 1]
          return last ? `${last.headers['x-captcha-id']}|${last.headers['x-captcha-value']}|${last.headers['x-qihe-client']}` : ''
        },
        { timeout: 15000 },
      )
      .toBe(`${CAPTCHA_ID}|9k2m|box`)
    // 已登录态出现（三态里最难自动覆盖的一条，靠桩服务把这一步补齐）
    await expect(page.getByRole('button', { name: '登出' })).toBeVisible({ timeout: 15000 })
  })

  test('反向实验：登录失败 ⇒ 自动换一张新码（不逼用户在旧图上重试）', async () => {
    await gotoProfile()
    await ensureLoggedOut()
    const captchaBefore = seen.filter((s) => s.url === '/api/captcha').length
    failNextAuth = true
    await page.getByPlaceholder('邮箱').fill('e2e-fail@qihe.test')
    await page.getByPlaceholder('密码').fill('e2epw12345')
    await page.getByPlaceholder('图形验证码（必填）').fill('0000')
    await loginBtn().click()
    await expect
      .poll(() => seen.filter((s) => s.url === '/api/captcha').length, { timeout: 15000 })
      .toBeGreaterThan(captchaBefore)
  })

  test('态② 注册 → 态③ 待验证 → 输码自动登录（整链不出客户端）', async () => {
    await gotoProfile()
    await ensureLoggedOut()

    await page.getByRole('button', { name: '没有账号？注册账号 →' }).click()
    await expect(page.getByPlaceholder('密码（至少 8 位）')).toBeVisible({ timeout: 10000 })
    await page.getByPlaceholder('邮箱').fill('E2e.Newuser@qihe.test')
    await page.getByPlaceholder('密码（至少 8 位）').fill('e2epw12345')
    await page.getByRole('button', { name: '注册账号' }).click()

    // ① 建档：username = 邮箱前缀（服务端字段形状照 erp 用例）
    await expect
      .poll(
        () => {
          const r = seen.find((s) => s.url === '/api/collections/users/records')
          return r ? `${r.body.username}|${r.body.passwordConfirm !== undefined}` : ''
        },
        { timeout: 15000 },
      )
      .toBe('E2e.Newuser|true')
    // ② 发码：进待验证态，文案点名邮箱（客户端内闭环，不甩用户去网页）
    await expect(page.getByText('验证邮件已发到', { exact: false })).toBeVisible({ timeout: 15000 })
    await expect
      .poll(() => seen.some((s) => s.url === '/api/auth/email-verification/request'), { timeout: 15000 })
      .toBe(true)

    // ③ 验码：通过后自动转登录（密码由渲染层留在手里，主进程不代存）
    await page.getByPlaceholder('6 位数字验证码').fill('246813')
    await page.getByRole('button', { name: '验证并登录' }).click()
    await expect
      .poll(
        () => {
          const r = seen.find((s) => s.url === '/api/auth/email-verification/confirm')
          return r ? String(r.body.code) : ''
        },
        { timeout: 15000 },
      )
      .toBe('246813')
    await expect(page.getByRole('button', { name: '登出' })).toBeVisible({ timeout: 15000 })
  })

  test('反向实验：注册只填一半 ⇒ 本地即拦，一次请求都不发', async () => {
    await gotoProfile()
    await ensureLoggedOut()
    await page.getByRole('button', { name: '没有账号？注册账号 →' }).click()
    const before = seen.length
    await page.getByRole('button', { name: '注册账号' }).click()
    await expect(page.getByText('请输入邮箱和密码')).toBeVisible({ timeout: 10000 })
    expect(seen.length).toBe(before)
  })

  test('反向实验：验证码非 6 位 ⇒ 文案在前端，不打 confirm 端点', async () => {
    await gotoProfile()
    await ensureLoggedOut()
    await page.getByRole('button', { name: '没有账号？注册账号 →' }).click()
    await page.getByPlaceholder('邮箱').fill('e2e-short@qihe.test')
    await page.getByPlaceholder('密码（至少 8 位）').fill('e2epw12345')
    await page.getByRole('button', { name: '注册账号' }).click()
    await expect(page.getByText('验证邮件已发到', { exact: false })).toBeVisible({ timeout: 15000 })
    const confirmBefore = seen.filter((s) => s.url === '/api/auth/email-verification/confirm').length
    await page.getByPlaceholder('6 位数字验证码').fill('12ab')
    await page.getByRole('button', { name: '验证并登录' }).click()
    await expect(page.getByText('请输入 6 位数字验证码')).toBeVisible({ timeout: 10000 })
    expect(seen.filter((s) => s.url === '/api/auth/email-verification/confirm').length).toBe(confirmBefore)
  })
})