import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/out/renderer/index.html'

/**
 * 预览生命周期治理 e2e（v2.5.3 T7）：
 * - 关闭预览后无状态残留：再次打开显示新文件内容
 * - 路由离开自动关闭预览（App.tsx 路由 effect → closePreview）
 * - 关闭/离开期间迟到的 URL 不得重开弹窗（store 代际守卫 previewGen）
 * - 预览内删除成功仍触发列表刷新（deleteCurrentFile 捕获的 context.onDelete 照常执行）
 * - 右键菜单 / 删除确认在预览关闭后复位：下一次打开不重现上一会话状态
 * 说明：window.qihebox 为 contextBridge 只读对象（不可注入延迟），
 * 「迟到 URL」用超大噪点 PNG 拉长主进程解码时长制造真实竞态窗口；
 * 「解码必然完成」以主进程预览副本（userData/thumbs/<wsHash>/preview/）落盘为确定性信号，
 * 见 previewArtifactPath / waitForArtifact（O3：替代固定 waitForTimeout 盲等）。
 */

/** 计算主进程预览副本落盘路径（主进程 previewPathFor → thumbnailPath：
 *  userData/thumbs/<sha256(ws 绝对路径)[:8]>/preview/<key[:2]>/<key><ext>.thumb.jpg，
 *  其中 key = sha256(工作区相对路径)[:32]；与 src/main/thumbnail.ts / core/paths.ts 同算法）。
 *  依赖：主进程 `ensurePreview` 在副本写盘完成之后才返回 previewUrl，副本出现 ⇒ 解码必然完成。 */
const previewArtifactPath = (userData: string, wsDir: string, filePath: string): string => {
  const wsHash = createHash('sha256').update(path.resolve(wsDir)).digest('hex').slice(0, 8)
  const rel = path.relative(path.resolve(wsDir), path.resolve(filePath))
  const key = createHash('sha256').update(rel).digest('hex').slice(0, 32)
  const ext = path.extname(filePath).toLowerCase()
  return path.join(userData, 'thumbs', wsHash, 'preview', key.slice(0, 2), `${key}${ext}.thumb.jpg`)
}

/** 自旋等待文件出现（上限 deadlineMs）。O3：以主进程解码产物落盘为「解码必然完成」的信号，
 *  替代固定时长盲等（固定 8s 在慢机上可能早于解码完成，回归删代际守卫也测不出来——假绿）。 */
const waitForArtifact = async (filePath: string, deadlineMs: number): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const st = await fsp.stat(filePath)
      if (st.isFile()) return
    } catch { /* 尚未生成 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`等待预览副本生成超时（${deadlineMs}ms）：${filePath} —— 主进程预览解码管线是否变更？`)
}
// v2.5.9/A1c（CI #101/#102 取证，2026-09-21）：这条在 GitHub runner 上恒红的根因**不是产品**——
// 注解原文两条：`Test timeout of 90000ms exceeded` + 由它派生的 `locator.waitFor: Target page … has been closed`。
// `waitImageCard` 本来就写了「3 次 × 30s」的等待预算（=90s），恰好把全局 90s 预算吃干，
// 任何一次冷索引比本机慢就必然超时；超时后 Playwright 中止页面，剩余等待就报成"target closed"
// （所以那条签名看着像崩溃，其实像超时多过像崩溃）。
// ⇒ 这里只放宽**等待预算**，不放宽判据：卡片必须真的可见才算过，等不到照样红。
test.describe.configure({ timeout: process.env.GITHUB_ACTIONS === 'true' ? 180_000 : 90_000 })

test.describe('预览生命周期治理（v2.5.3 T7）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('preview-lifecycle') } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
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
  })

  const navigateTo = async (url: string): Promise<void> => {
    await page.evaluate(() => { window.location.hash = '/__e2e-reset' }) // 复位到无匹配空路由（等价旧 goto 的空白挂载，不触发任何页面数据拉取）
    await page.reload({ waitUntil: 'domcontentloaded' }) // v2.5.7 补丁：hash 路由下文档路径恒定，reload 取干净挂载
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((u) => {
      window.location.hash = decodeURIComponent(u)
    }, url)
  }

  /** SPA 内导航（整页不 reload）——验证路由切换行为时使用 */
  const spaNavigate = async (url: string): Promise<void> => {
    await page.evaluate((u) => {
      window.location.hash = decodeURIComponent(u)
    }, url)
  }

  /** 建产品集文档工作区并写入若干 md 文件（直写磁盘，docs 页物理扫描可见） */
  const setupMdWorkspace = async (psName: string, files: Record<string, string>): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-pv-md-'))
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    const psRes = await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), psName)
    expect(psRes.success).toBe(true)
    const dir = path.join(wsDir, '产品集', psName, '文档', '说明书')
    await fsp.mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await fsp.writeFile(path.join(dir, name), Buffer.from(content))
    }
    return wsDir
  }

  /** 建图包工作区并导入一张图片（big=true 生成超大噪点 PNG 拉长主进程解码，制造预览 URL 迟到窗口） */
  const setupImageWorkspace = async (psName: string, big = false): Promise<string> => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-pv-img-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), psName)

    const sharp = (await import('sharp')).default
    let pngPath: string
    // v2.5.9/A1c：大图这条用例会造 12000×12000 随机 raw（=432MB 缓冲）+ PNG 编码，
    // 在 2 核 GitHub runner 上可能是几十秒级的 CPU/内存尖峰，并把**紧随其后**那条用例的首跑拖垮
    // （旧现象：首跑挂、Retry 过）。把这段耗时打出来，下次抖动能直接验证或排除这个假设。
    const tBig = Date.now()
    if (big) {
      const { randomBytes } = await import('node:crypto')
      const W = 12000
      const buf = randomBytes(W * W * 3)
      pngPath = path.join(wsDir, '超大图.png')
      await sharp(buf, { raw: { width: W, height: W, channels: 3 } }).png().toFile(pngPath)
      console.log(`[pv] 大图夹具耗时 ${psName}：${W}×${W} raw+png=${Date.now() - tBig}ms`)
    } else {
      pngPath = path.join(wsDir, '小图.png')
      await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 120, g: 160, b: 200 } } })
        .png()
        .toFile(pngPath)
    }
    const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-pv-img-src-'))
    const srcFile = path.join(srcDir, path.basename(pngPath))
    await fsp.copyFile(pngPath, srcFile)
    await page.evaluate(
      async (args) => {
        const { src, ps } = args as { src: string; ps: string }
        return (window as any).qihebox.files.import({
          source_paths: [src],
          target_product_set: ps,
          target_folder: '主图',
          target_type: 'image',
          sub_folder: '主图',
        })
      },
      { src: srcFile, ps: psName },
    )
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {})
    return wsDir
  }

  /** 轮询图包列表直到导入完成出现条目（import 为异步，完成才可双击预览）。
   *  导入完成后整页 reload 重新挂载图包页——全量套件负载下页面首次挂载可能早于导入完成，
   *  且 SPA 同路径导航不会重挂载，产品集卡片列表会过期不显示新集（v2.5.3 修复）。 */
  /**
   * v2.5.9/A1c（2026-09-21）：等图包卡片，并把**各段耗时打出来**。
   * 背景：这条在 CI 上先是"恒红"、加了 180s 预算后降级为 flaky（首跑挂、Retry 过），
   * 而根因一直说不清——旧写法是「3 次 × 30s」盲等，红的时候只看见最后一行 locator 超时，
   * 看不出时间花在哪。现在按段计时：导入落库（真正的"冷索引"）/ 整页 reload / 标题挂载 / 卡片渲染。
   * 判据不变：卡片必须真的可见，等不到照样红。
   */
  /**
   * 每次等卡片的预算。⚠ **必须是 30s，不能按总预算均摊**：
   * 2026-09-21 CI #112 实测——我把它改成 `timeout/3`（15s）后，这条在 runner 上从
   * "首跑挂、Retry 过"变成**两连败**：runner 上卡片就是要 15–30s 才渲染得出来，
   * 均摊等于把每个attempt 的余量砍一半。总预算（3 次）与判据都没变，变的只是这个常数。
   */
  const CARD_ATTEMPT_MS = 30000
  const waitImageCard = async (psName: string, timeout = 45000): Promise<void> => {
    const t0 = Date.now()
    await page.waitForFunction(
      async (psName) => {
        const r = await (window as any).qihebox.files.list({
          product_set: psName,
          file_type: 'image',
          media_type: 'image',
          sub_folder: '主图',
        })
        return !!(r.success && r.data && r.data.length > 0)
      },
      psName,
      { timeout },
    )
    const tListed = Date.now()
    // 整页 reload：重新挂载后产品集列表以最新状态重新加载
    await navigateTo('/images')
    const tNav = Date.now()
    await expect(page.getByRole('heading', { name: '图包库' })).toBeVisible({ timeout: 30000 })
    const tHead = Date.now()
    // 卡片可见性不是本用例断言目标，等它就是为让后续双击可执行。
    // ⚠ 保留「等不到就重新挂载再试」这条恢复路径——它是**承重墙**不是冗余：
    //   SPA 同路径导航不会重挂载，产品集卡片列表会停在旧状态，光靠等时间等不出来
    //   （2026-09-21 实测：把三连试简化成"一个总预算内轮询"后，这条用例从"偶发"变成**稳定复现失败**）。
    // v2.5.9/A1c：在保留恢复路径的同时按段计时 + 每次重试都打印累计耗时，
    //   红的时候能读出时间花在"导入落库 / reload / 标题 / 卡片"哪一段。
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await expect(async () => {
          expect(await page.locator('.card', { hasText: psName }).count()).toBeGreaterThan(0)
        }).toPass({ timeout: CARD_ATTEMPT_MS })
        console.log(
          `[pv] 冷索引分段耗时 ${psName}：导入落库=${tListed - t0}ms 整页reload=${tNav - tListed}ms ` +
            `标题挂载=${tHead - tNav}ms 卡片渲染=${Date.now() - tHead}ms（第 ${attempt} 次即中）总=${Date.now() - t0}ms`,
        )
        return
      } catch (error) {
        lastError = error
        console.log(
          `[pv] 第 ${attempt} 次等卡片未中（累计 ${Date.now() - t0}ms），重新挂载再试：` +
            `导入落库=${tListed - t0}ms reload=${tNav - tListed}ms 标题=${tHead - tNav}ms 本段=${Date.now() - tHead}ms`,
        )
        if (attempt < 3) {
          await navigateTo('/images')
          await expect(page.getByRole('heading', { name: '图包库' })).toBeVisible({ timeout: 30000 })
        }
      }
    }
    throw lastError
  }

  test('关闭预览后无状态残留：再次打开显示新文件', async () => {
    const wsDir = await setupMdWorkspace('生命周期集X', {
      '甲.md': '# 甲文内容',
      '乙.md': '# 乙文内容',
    })
    try {
      await navigateTo('/files/doc/生命周期集X/说明书')
      await expect(page.getByText('甲.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('甲.md').dblclick()
      // v2.5.7（A2 笔记）：md 打开为 NoteEditorModal（.md-prose 只读预览已移除）
      const editor = page.locator('[data-note-editor] [contenteditable="true"]').first()
      await expect(editor).toBeVisible({ timeout: 20000 })
      await expect(editor).toContainText('甲文内容', { timeout: 20000 })

      await page.keyboard.press('Escape')
      await expect(page.locator('[data-note-editor]')).toHaveCount(0)

      await page.getByText('乙.md').dblclick()
      const editor2 = page.locator('[data-note-editor] [contenteditable="true"]').first()
      await expect(editor2).toContainText('乙文内容', { timeout: 20000 })
      await expect(editor2).not.toContainText('甲文内容')
      // 弹窗标题为当前文件，无上一会话残留
      await expect(page.locator('h3.text-lg.font-semibold')).toHaveText('乙.md')
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('路由离开自动关闭预览', async () => {
    const wsDir = await setupMdWorkspace('生命周期集Y', { '甲.md': '# 甲文' })
    try {
      await navigateTo('/files/doc/生命周期集Y/说明书')
      await expect(page.getByText('甲.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('甲.md').dblclick()
      await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })

      await spaNavigate('/certs')
      await expect(page.getByRole('heading', { name: '证书库' })).toBeVisible({ timeout: 15000 })
      // 预览弹窗必须随路由离开关闭（不残留旧页面闭包）
      await expect(page.getByText('用系统程序打开')).toHaveCount(0)
      await expect(page.locator('[data-note-editor]')).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('关闭/离开期间迟到的 URL 不得重开弹窗', async () => {
    // 12000×12000 超大图解码落盘为自然慢窗口，CI xvfb 慢机 90s 超时（2026-08-19 CI 实测超时）；
    // 本地全量门禁覆盖（DISPLAY 真桌面 136/136 绿）
    test.skip(!!process.env.CI, '超大图解码慢窗口在 CI xvfb 时序不可靠，本地真桌面完整验证')
    const wsDir = await setupImageWorkspace('慢图集T7', true)
    try {
      await navigateTo('/images')
      // 等图包页挂载完成（列表加载中先出现页面标题）
      await expect(page.getByRole('heading', { name: '图包库' })).toBeVisible({ timeout: 30000 })
      await waitImageCard('慢图集T7')
      const card = page.locator('.card', { hasText: '慢图集T7' })
      await card.first().waitFor({ timeout: 30000 })

      // 预览副本为确定性落盘产物：主进程保证「副本写盘完成 ⇔ previewUrl IPC 即将 resolve」，
      // 以此作为解码必然完成的信号（O3：替代固定 waitForTimeout(8000) 盲等）
      const userData = await app.evaluate(({ app }) => app.getPath('userData'))
      const entryPath = await page.evaluate(async (ps) => {
        const r = await (window as any).qihebox.files.list({
          product_set: ps,
          file_type: 'image',
          media_type: 'image',
          sub_folder: '主图',
        })
        return r.success && r.data && r.data[0] ? (r.data[0].path as string) : null
      }, '慢图集T7')
      expect(entryPath).toBeTruthy()
      const artifact = previewArtifactPath(userData, wsDir, entryPath!)

      // 双击打开预览后立即路由离开——超大图 previewUrl 需在主进程解码（数百 ms 起步），
      // 若迟到的 URL 被采纳会把弹窗在 /certs 上重新拉起（T7 修复点）
      await card.first().dblclick()
      await spaNavigate('/certs')
      await expect(page.getByRole('heading', { name: '证书库' })).toBeVisible({ timeout: 15000 })

      // O3：自旋等到「解码必然完成」（主进程已将副本写盘）再断言——
      // 固定 8s 在慢机可能早于解码完成，届时弹窗未重开即使删掉代际守卫也测不出来（假绿）。
      // 副本出现 ⇒ 渲染层迟到续体（无论守卫是否生效）必已执行，此后断言才具判别力。
      await waitForArtifact(artifact, 60_000)
      // 落盘后再留余量（IPC 回程 + 渲染续体调度 + Solid effect）
      await page.waitForTimeout(2000)
      await expect(page.getByText('用系统程序打开')).toHaveCount(0)
      await expect(page.locator('[data-note-editor]')).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('预览内删除成功仍触发列表刷新', async () => {
    const wsDir = await setupImageWorkspace('删图集T7')
    try {
      await navigateTo('/images')
      await expect(page.getByRole('heading', { name: '图包库' })).toBeVisible({ timeout: 30000 })
      await waitImageCard('删图集T7')
      const card = page.locator('.card', { hasText: '删图集T7' })
      await card.first().waitFor({ timeout: 30000 })
      await card.first().dblclick()
      await expect(page.getByText('用系统程序打开').first()).toBeVisible({ timeout: 15000 })

      await page.getByRole('button', { name: '🗑️ 删除', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '删除文件' })
      await dialog.waitFor({ timeout: 5000 })
      await dialog.getByRole('button', { name: '删除', exact: true }).click()

      // 删除成功 → onDelete 刷新列表 → 卡片消失；预览随之关闭
      await expect(card).toHaveCount(0, { timeout: 15000 })
      await expect(page.getByText('用系统程序打开')).toHaveCount(0, { timeout: 5000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('右键菜单随预览关闭复位：再次打开不重现', async () => {
    const wsDir = await setupMdWorkspace('生命周期集Z', { '甲.md': '# 甲文' })
    try {
      await navigateTo('/files/doc/生命周期集Z/说明书')
      await expect(page.getByText('甲.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('甲.md').dblclick()
      const editor = page.locator('[data-note-editor]').first()
      await expect(editor).toBeVisible({ timeout: 20000 })

      // 预览区内右键打开菜单（ContextMenu 常驻 modal 的本地 signal，关闭后须复位）
      await editor.click({ button: 'right' })
      await expect(page.getByText('复制文件到剪贴板')).toBeVisible({ timeout: 5000 })

      // 菜单打开状态下路由离开 → App 路由 effect 关闭预览
      await spaNavigate('/certs')
      await expect(page.getByRole('heading', { name: '证书库' })).toBeVisible({ timeout: 15000 })
      await expect(page.getByText('复制文件到剪贴板')).toHaveCount(0)

      // 回到原页面重开预览：上一会话的菜单不得重现
      await spaNavigate('/files/doc/生命周期集Z/说明书')
      await expect(page.getByText('甲.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('甲.md').dblclick()
      await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })
      await expect(page.getByText('复制文件到剪贴板')).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })

  test('删除确认随预览关闭复位：下一会话不再重现', async () => {
    const wsDir = await setupMdWorkspace('生命周期集W', { '甲.md': '# 甲文' })
    try {
      await navigateTo('/files/doc/生命周期集W/说明书')
      await expect(page.getByText('甲.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('甲.md').dblclick()
      await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })

      // 打开删除确认弹窗，处于待确认状态
      await page.getByRole('button', { name: '🗑️ 删除', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '删除文件' })
      await dialog.waitFor({ timeout: 5000 })

      // 确认弹窗打开状态下路由离开 → 预览整体关闭，确认状态必须复位
      await spaNavigate('/certs')
      await expect(page.getByRole('heading', { name: '证书库' })).toBeVisible({ timeout: 15000 })
      await expect(page.getByRole('dialog', { name: '删除文件' })).toHaveCount(0)

      // 回到原页面重开预览：上一会话的删除确认不得重现，且删除按钮可再次正常唤起
      await spaNavigate('/files/doc/生命周期集W/说明书')
      await expect(page.getByText('甲.md')).toBeVisible({ timeout: 15000 })
      await page.getByText('甲.md').dblclick()
      await expect(page.locator('[data-note-editor]')).toBeVisible({ timeout: 20000 })
      await expect(page.getByRole('dialog', { name: '删除文件' })).toHaveCount(0)
      await page.getByRole('button', { name: '🗑️ 删除', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '删除文件' })).toBeVisible({ timeout: 5000 })
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true })
    }
  })
})