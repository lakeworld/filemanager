/**
 * 插件目录「详情化」真链路 e2e（v2.6.2 宿主侧，2.6.2 开工卡 ① 的验收面）。
 *
 * 为什么单独一份、且必须真跑：`plugins-update-notice.test.ts` 里那组「接线与反向钉」只钉源码
 * （字符串在不在文件里、缩略图有没有写成 button），钉不住**行为**——图片到底加载没加载、
 * 翻页到头绕没绕回、官方没写素材时界面显不显示假话。本 spec 把目录接口换成**本地桩 HTTP 服务**，
 * 走真实主进程 fetch + 真实渲染层解码，钉的是用户看得到的那部分。
 * 桩形状照 `src/main/plugins/catalog.ts` 的服务端约定抄（含 `data.plugins` 外层与 `generatedAt`）；
 * 图片由同一个桩以 `http://127.0.0.1:<port>/img/*.png` 提供（契约只认 http(s) 绝对地址，data URL 会被丢掉）。
 *
 * 登录态：写 `<userData>/account.json`，token 带 `raw:` 前缀 → 绕开 safeStorage（口径同
 * `probe-wave5-memory-f5-crepe.spec.ts` 与本仓 f5 加密链夹具）。零真凭据、零现网。
 * ⚠ label 专属 userData，收尾删掉自己写的 account.json，别污染别人的未登录断言。
 *
 * 2.6.1 补（假绿审计判据）：详情弹窗的「安装」钮**真点**一条——桩发真包字节（build 产物
 * `out/plugins/com.qihe.hello.qbox`，sha/size 与目录条目同源），点了必须有包请求、且装完
 * `plugins.list` 里真出现；只断言按钮文案等于没测（把 onClick 摘掉也照绿）。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LABEL = 'plugin-catalog-detail'
const USER_DATA = path.join(os.tmpdir(), e2eUserDataDirName(LABEL))
/** 假 token 明文（落盘写作 `raw:` + 此值；主进程解密后原样进 Authorization 头） */
const FAKE_TOKEN = 'e2e-catalog-token'

/** 真·1×1 PNG（69 字节；与 account-captcha 桩同一份已回解校验过签名/IHDR/IDAT/IEND 的字节） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mO4IycHAALyARlNudhnAAAAAElFTkSuQmCC',
  'base64',
)
// 夹具自查（2026-09-25 首轮跑挂在此）：图片地址一律挂 **origin**（不带 `/api`），
// 与下面的 `/img/...` 路由分支同源。上一版把图 URL 拼成 `${apiBase}/img/...`（= `/api/img/...`），
// 落进了桩的 catch-all JSON 分支 → `<img>` 收到 200 application/json → 整块「图未加载」，
// 看着像宿主 bug、其实是桩路由没对上。图片地址与路由分支必须一起看，别只改一边。

/** 详情长文：恰好两段（空行分隔）——渲染层按空行切段，两段都出现才算没吞内容 */
const DEMO_DETAIL =
  '第一段：把仓库里的进货单直接变成客户档案，不需要手工誊录。\n\n第二段：识别结果先在框里让你确认，你点保存才落库。'
const DEMO_RELEASE_NOTES = '演示更新说明：修掉了重复识别同一张单的问题。'

/** 安装链真点夹具：build 产物里的 hello 插件（与 plugins.spec.ts 同源）。详情弹窗的「安装」钮
 *  此前只被断言过文案、从未真点（审计实读：把 onClick 摘掉也照绿）——这里把它真点下去：
 *  桩上必须收到这一枪包请求、装完 plugins.list 里必须真出现、再卸掉收场。 */
const HELLO_ID = 'com.qihe.hello'
const HELLO_QBOX = path.join(ROOT, 'out', 'plugins', 'com.qihe.hello.qbox')
/** 缺文件 = 前置没满足（e2e 前必须 build）⇒ 直接抛，别静默跳过当绿 */
const HELLO_BYTES = fs.readFileSync(HELLO_QBOX)
const HELLO_SHA = createHash('sha256').update(HELLO_BYTES).digest('hex')

const seenCatalogHeaders: string[] = []
/** 目录端点逐枪记录的请求路径（钉"没打成 /api/api/… 双段"；双段只会在下面兜底分支吃 200 JSON） */
const seenCatalogUrls: string[] = []
let catalogHits = 0
/** 包体端点逐枪记录的路径（安装链真点判据：点了「安装」必须有这一枪） */
const pkgHits: string[] = []
/** 云 API 基址（含尾 /api，主进程 `resolveApiBase()` 的实际形状） */
let apiBase = ''
/** 桩服务的裸 origin（图片走这条：真实服务端给的 downloadUrl/图片本就不必挂在 /api 下） */
let origin = ''
const mockServers: http.Server[] = []

function catalogPayload(): unknown {
  return {
    code: 200,
    data: {
      generatedAt: new Date().toISOString(),
      plugins: [
        {
          id: 'com.qihe.demo',
          name: '目录演示插件',
          author: '启禾',
          source: '启禾官方',
          description: '演示条目：带三张截图与完整介绍。',
          images: [`${origin}/img/demo-1.png`, `${origin}/img/demo-2.png`, `${origin}/img/demo-3.png`],
          detail: DEMO_DETAIL,
          permissions: { network: ['api.example.com'], clipboard: true },
          versions: [
            {
              version: '0.9.0',
              apiCompat: [1, 1],
              size: 1_500_000,
              sha256: 'a'.repeat(64),
              downloadUrl: `${origin}/pkg/com.qihe.demo.qbox`,
              releaseNotes: DEMO_RELEASE_NOTES,
            },
          ],
        },
        {
          // 官方没给素材的条目：界面要如实说"没写"，不许编占位、也不许留空框
          id: 'com.qihe.bare',
          name: '无素材插件',
          versions: [
            { version: '1.0.0', apiCompat: [1, 1], sha256: 'b'.repeat(64), downloadUrl: `${origin}/pkg/bare.qbox` },
          ],
        },
        {
          // 混装夹具（v2.6.1 B16）：一条目里 1 张好图 + 1 张坏图（404）——坏的那张只退成占位，
          // 同一行/同一缩略条里的好图必须照渲染（失败态一旦提到父级整块退，下面那条 img 断言必红）
          id: 'com.qihe.brokenimg',
          name: '碎图插件',
          images: [`${origin}/img/good-1.png`, `${origin}/img/missing.png`],
          versions: [
            { version: '1.0.0', apiCompat: [1, 1], sha256: 'c'.repeat(64), downloadUrl: `${origin}/pkg/broken.qbox` },
          ],
        },
        {
          // 宿主 API 版本不兼容：置灰 + 文案「不可安装」，且不得说"这一版官方没写更新说明"（根本没有可装版本）
          id: 'com.qihe.newapi',
          name: '新协议插件',
          versions: [
            { version: '2.0.0', apiCompat: [2, 3], sha256: 'd'.repeat(64), downloadUrl: `${origin}/pkg/new.qbox` },
          ],
        },
        {
          // 安装链真点条目：sha256/size 由 build 产物实时算（桩照这个发，装得上才算真链）
          id: HELLO_ID,
          name: 'Hello 示例插件',
          entitlement: 'login',
          description: '安装链真点用例：点「安装」必须真下载、真装上。',
          versions: [
            {
              version: '2.5.5',
              apiCompat: [1, 1],
              size: HELLO_BYTES.length,
              sha256: HELLO_SHA,
              downloadUrl: `${origin}/pkg/com.qihe.hello.qbox`,
            },
          ],
        },
      ],
    },
  }
}

function startMock(): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = (req.url ?? '').split('?')[0]
      if (p === '/api/box/plugin-catalog') {
        catalogHits += 1
        seenCatalogUrls.push(p)
        seenCatalogHeaders.push(String(req.headers.authorization ?? ''))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(catalogPayload()))
        return
      }
      if (p.startsWith('/img/demo-') || p.startsWith('/img/good-')) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
        res.end(PNG)
        return
      }
      if (p === '/pkg/com.qihe.hello.qbox') {
        // 真包字节（sha/size 与目录条目同源）：安装链要真校验、真解包，桩发假字节就装不上
        pkgHits.push(p)
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(HELLO_BYTES.length) })
        res.end(HELLO_BYTES)
        return
      }
      if (p.startsWith('/pkg/')) {
        pkgHits.push(p)
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      if (p.startsWith('/img/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      // 心跳等其它端点一律 200：别让假登录态被判成会话过期（口径同 account-captcha 桩）
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 200 }))
    })
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      apiBase = `${origin}/api`
      mockServers.push(server)
      resolve()
    })
  })
}

test.describe('插件目录详情化（v2.6.2 真链路）', () => {
  test.describe.configure({ mode: 'serial' })

  let app: ElectronApplication
  let page: Page

  const detailButton = (name: string) =>
    page.getByRole('button', { name: `查看「${name}」的详情`, exact: true })
  const dialog = () => page.getByRole('dialog')

  test.beforeAll(async () => {
    await startMock()
    // 清场重写：e2e userData 跨运行持久，label 专属目录里的 account.json 只归本 spec 用
    await fsp.rm(USER_DATA, { recursive: true, force: true }).catch(() => {})
    await fsp.mkdir(USER_DATA, { recursive: true })
    await fsp.writeFile(
      path.join(USER_DATA, 'account.json'),
      JSON.stringify({ token: `raw:${FAKE_TOKEN}`, userId: 'e2e-user', email: 'e2e@test.dev', deviceId: 'e2e-device' }),
      { mode: 0o600 },
    )
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_USERDATA: e2eUserDataDirName(LABEL),
        QIHE_API_BASE: apiBase,
      },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    // 预热主进程 token 缓存（正常启动流程 App onMount 也会做这件事；此处显式等待，消除与目录拉取的竞态）
    const st = await page.evaluate(async () => (window as any).qihebox.account.status())
    expect(st.data.loggedIn).toBe(true)
    await page.evaluate(() => {
      window.location.hash = '/settings/plugins'
    })
    await expect(page.getByRole('heading', { name: '插件', exact: true })).toBeVisible({ timeout: 15000 })
  })

  test.afterAll(async () => {
    if (app) {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
    await fsp.rm(path.join(USER_DATA, 'account.json'), { force: true }).catch(() => {})
    for (const s of mockServers) await new Promise<void>((r) => s.close(() => r()))
  })

  test('目录请求走真实主进程：端点无双段、带 Bearer 登录态、只由显式动作拉取', async () => {
    // demo 三张图渲染出来 ⇒ 断言的不是"请求发过"，而是"请求成功并驱动了界面"
    await expect(page.locator('[data-testid="catalog-thumb"][src*="/img/demo-"]')).toHaveCount(3, { timeout: 15000 })
    // v2.6.1 B16：进页面 = **恰好一枪**（写死条数：重打 / 双段落兜底 / 后台自轮询都会多枪，少一枪也红）。
    // 旧判据 `seenCatalogHeaders.length === catalogHits` 是同一分支自增的恒真式，永远绿。
    expect(catalogHits).toBe(1)
    // 双段 /api/api/box/… 是批 2.5 P0-1 踩过的坑：落桩兜底 200 → "目录永远空"，这里逐枪钉真实路径
    expect(seenCatalogUrls).toEqual(['/api/box/plugin-catalog'])
    // 逐条断言 Bearer（不是数条数）
    expect(seenCatalogHeaders).toEqual([`Bearer ${FAKE_TOKEN}`])
    // 静置窗口内不增长（单窗口只证"这段窗口内没有"）
    const before = catalogHits
    await page.waitForTimeout(2500)
    expect(catalogHits).toBe(before)
    // 正控：点「刷新」必须且只多一枪——证明计数与请求链路都是活的（没有这一步，"不增长"
    // 也可能只是页面没在跑/计数没接上）。两段式 stub「首枪缺数据、次枪补全 ⇒ 界面到完整态」
    // 在本产品不成立：目录只在进页面/刷新/重试三处显式拉取，无自动重拉（实测首枪回空目录即停在空态）。
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect.poll(() => catalogHits, { timeout: 10000 }).toBe(before + 1)
    expect(seenCatalogHeaders).toEqual([`Bearer ${FAKE_TOKEN}`, `Bearer ${FAKE_TOKEN}`])
  })

  test('缩略图真解码；无素材条目不留空框；坏图只退那一张（混装夹具）', async () => {
    const natural = await page
      .locator('[data-testid="catalog-thumb"][src*="/img/demo-"]')
      .first()
      .evaluate((el) => (el as HTMLImageElement).naturalWidth)
    // 真加载过（naturalWidth>0）——只钉 src 属性会放过"属性写上了但图没解码"这类假绿
    expect(natural).toBeGreaterThan(0)
    // 无素材条目与不兼容条目都没有缩略块：整页只有 demo 与 broken 两行有块（空框会被读成"图坏了"）
    await expect(page.locator('[data-testid="catalog-thumbs"]')).toHaveCount(2)
    // 混装夹具（碎图插件 = 1 张好图 + 1 张坏图）：坏的那张退成占位…
    const brokenThumbs = page.locator('[data-testid="catalog-thumbs"]').filter({ hasText: '图未加载' })
    await expect(brokenThumbs.getByText('图未加载')).toBeVisible({ timeout: 15000 })
    // …同一缩略条里的好图必须照常渲染并解码（失败态若提到父级、整块退成占位，这枚 img 根本不在 → 必红）
    const goodInRow = brokenThumbs.locator('[data-testid="catalog-thumb"][src*="/img/good-"]')
    await expect(goodInRow).toHaveCount(1)
    expect(await goodInRow.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    // 行本身与「详情」入口照常
    await expect(detailButton('碎图插件')).toBeVisible()
  })

  test('详情弹窗：大图 + 到头绕回 + 介绍分段 + 权限摘要 + 更新说明逐字', async () => {
    await detailButton('目录演示插件').click()
    const gallery = dialog().locator('[data-testid="catalog-gallery"]')
    await expect(gallery).toBeVisible()
    expect(await gallery.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(dialog().getByText('目录演示插件', { exact: true })).toBeVisible()
    // 介绍按空行切成两段，两段都要出现（只显第一段 = 吞内容）
    await expect(dialog().getByText(/第一段：把仓库里的进货单/)).toBeVisible()
    await expect(dialog().getByText(/第二段：识别结果先在框里让你确认/)).toBeVisible()
    await expect(dialog().locator('[data-testid="detail-permissions"]')).toHaveText('网络 api.example.com、剪贴板')
    await expect(dialog().locator('[data-testid="detail-release-notes"]')).toHaveText(DEMO_RELEASE_NOTES)
    // 翻页：1/3 → 2/3 → 3/3 → 绕回 1/3 → 往前绕回 3/3
    const pos = dialog().locator('[data-testid="gallery-pos"]')
    await expect(pos).toHaveText('1 / 3')
    await dialog().getByTestId('gallery-next').click()
    await expect(pos).toHaveText('2 / 3')
    await dialog().getByTestId('gallery-next').click()
    await expect(pos).toHaveText('3 / 3')
    await dialog().getByTestId('gallery-next').click()
    await expect(pos).toHaveText('1 / 3')
    await dialog().getByTestId('gallery-prev').click()
    await expect(pos).toHaveText('3 / 3')
    // 页脚文案：未装过 = 「安装」（判据唯一住在 registry.catalogInstallLabel，界面只是渲染它）
    await expect(dialog().locator('[data-testid="detail-install"]')).toHaveText('安装')
    await dialog().locator('[data-testid="detail-close"]').click()
    await expect(gallery).toHaveCount(0)
  })

  test('详情弹窗的「安装」钮真点：桩上收到真包请求 + plugins.list 里真出现（不是只钉文案）', async () => {
    // 清场：本 spec 的 userData 跨运行持久，先卸掉上次可能留下的 hello（失败无关紧要）
    await page
      .evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), HELLO_ID)
      .catch(() => undefined)
    const before = pkgHits.length
    await detailButton('Hello 示例插件').click()
    const install = dialog().locator('[data-testid="detail-install"]')
    await expect(install).toHaveText('安装')
    await install.click()
    // ① 真链第一跳：桩上必须收到这一枪包请求——摘掉 onClick / 接错通道，这里就没有请求
    await expect.poll(() => pkgHits.length, { timeout: 20000 }).toBeGreaterThan(before)
    expect(pkgHits.slice(before)).toEqual(['/pkg/com.qihe.hello.qbox'])
    // ② 真链第二跳：装完 plugins.list 里真出现（下载 → sha256 校验 → 解包落盘 全过）
    await expect
      .poll(
        async () => {
          const l = await page.evaluate(async () => (window as any).qihebox.plugins.list())
          return (l.data as Array<{ id: string }>).some((p) => p.id === HELLO_ID)
        },
        { timeout: 30000 },
      )
      .toBe(true)
    const close = dialog().locator('[data-testid="detail-close"]')
    if ((await close.count()) > 0) await close.click()
    // 收场：卸掉 hello，别留给重跑与同 spec 其它用例
    await page.evaluate(async (id) => (window as any).qihebox.plugins.uninstall(id), HELLO_ID)
  })

  test('官方没写素材时如实说"没写"，而不是编占位或静默隐藏', async () => {
    await detailButton('无素材插件').click()
    await expect(dialog().locator('[data-testid="detail-absent"]')).toContainText('官方还没写这个插件的功能介绍')
    await expect(dialog().locator('[data-testid="detail-release-notes-absent"]')).toContainText('这一版官方没写更新说明')
    await expect(dialog().locator('[data-testid="catalog-gallery"]')).toHaveCount(0)
    // 权限也没声明 → 摘要走「未声明」，不得凭空写"不需要权限"
    await expect(dialog().locator('[data-testid="detail-permissions"]')).toHaveText('未声明')
    await dialog().locator('[data-testid="detail-close"]').click()
  })

  test('不兼容条目：置灰文案「不可安装」，且不谎称"这一版没写更新说明"', async () => {
    await expect(page.getByText('不兼容')).toBeVisible({ timeout: 15000 })
    await detailButton('新协议插件').click()
    const install = dialog().locator('[data-testid="detail-install"]')
    await expect(install).toHaveText('不可安装')
    await expect(install).toBeDisabled()
    // 没有可装版本 ⇒ 不该出现"这一版官方没写更新说明"（那是针对某个具体版本的陈述）
    await expect(dialog().locator('[data-testid="detail-release-notes-absent"]')).toHaveCount(0)
    await dialog().locator('[data-testid="detail-close"]').click()
  })
})
