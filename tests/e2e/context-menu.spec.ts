import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface MenuProbe {
  x: number
  y: number
  width: number
  height: number
  innerWidth: number
  innerHeight: number
  position: string
  left: string
  top: string
}

/**
 * 右键菜单位置回归（v2.4.8 打磨轮钳制回归取证 + 根治后防护）。
 * 断言：菜单必须完全落在视口内、尺寸小于视口、贴近鼠标点（允许边缘钳制内移）。
 * 取证信息（bbox/computed/父链）打印到 stdout 并截图留档 test-results/。
 */
test.describe('右键菜单钳制', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
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

  /** 菜单几何取证：等 ResizeObserver 钳制稳定（top 连续两次读取相同）后取 bbox 打印留档 */
  const probeMenu = async (label: string): Promise<MenuProbe> => {
    await page.waitForSelector('#ctx-menu-root', { timeout: 5000 })
    // RO 首次回调在布局后绘制前完成，尺寸稳定（含字体加载）后 pos 才到位——轮询至 top 稳定
    await page.waitForFunction(
      () => {
        const el = document.getElementById('ctx-menu-root')
        if (!el) return false
        const w = window as any
        const top = el.getBoundingClientRect().top
        const stable = w.__menuTop === top
        w.__menuTop = top
        return stable
      },
      null,
      { polling: 60, timeout: 5000 },
    )
    const probe = await page.evaluate(() => {
      const el = document.getElementById('ctx-menu-root')!
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      let n: Element | null = el
      const chain: string[] = []
      while (n && chain.length < 8) {
        chain.push(`${n.tagName}.${String((n as HTMLElement).className ?? '').slice(0, 70)}`)
        n = n.parentElement
      }
      const firstBtn = el.querySelector('button')
      return {
        x: r.x, y: r.y, width: r.width, height: r.height,
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        position: cs.position, left: cs.left, top: cs.top,
        inlineStyle: el.getAttribute('style'),
        computed: { width: cs.width, minWidth: cs.minWidth, maxWidth: cs.maxWidth, display: cs.display, whiteSpace: cs.whiteSpace },
        btnCount: el.querySelectorAll('button').length,
        firstBtnWidth: firstBtn ? firstBtn.getBoundingClientRect().width : null,
        parentChain: chain,
        dpr: window.devicePixelRatio,
      }
    })
    console.log(`[ctx-menu 取证:${label}]`, JSON.stringify(probe))
    await page.screenshot({ path: `test-results/ctx-menu-${label}.png` })
    return probe as MenuProbe
  }

  /** 核心断言：菜单完全落在视口内，且不是全屏（根治「撑满整个界面」的验收口径） */
  const expectMenuInViewport = (probe: MenuProbe, label: string) => {
    expect(probe.x, `${label} x`).toBeGreaterThanOrEqual(0)
    expect(probe.y, `${label} y`).toBeGreaterThanOrEqual(0)
    expect(probe.x + probe.width, `${label} 右缘`).toBeLessThanOrEqual(probe.innerWidth)
    expect(probe.y + probe.height, `${label} 下缘`).toBeLessThanOrEqual(probe.innerHeight)
    expect(probe.width, `${label} 宽<视口宽`).toBeLessThan(probe.innerWidth)
    expect(probe.height, `${label} 高<视口高`).toBeLessThan(probe.innerHeight)
  }

  test('文件浏览器右键：菜单完全落在视口内', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-ctx-'))
    const sharp = (await import('sharp')).default
    const imgSrc = path.join(wsDir, '..', `ctx-${Date.now()}.png`)
    await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 66, g: 135, b: 245 } } })
      .png()
      .toFile(imgSrc)

    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '右键集' }))
    const importEvent = await page.evaluate(async (src) => {
      const qb = (window as any).qihebox
      return new Promise((resolve) => {
        const unsub = qb.events.on('import:complete', (data: any) => {
          unsub()
          resolve(data)
        })
        void qb.files.import({
          source_paths: [src],
          target_product_set: '右键集',
          target_folder: '主图',
          target_type: 'image',
          sub_folder: '主图',
        })
      })
    }, imgSrc) as { success: boolean }
    expect(importEvent.success).toBe(true)

    // 进入文件浏览器（/files/image/<产品集>/<子文件夹>）
    await page.evaluate(async () => {
      const route = `/files/image/${encodeURIComponent('右键集')}/${encodeURIComponent('主图')}`
      window.history.pushState({}, '', route)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const card = page.locator('.card').first()
    await card.waitFor({ timeout: 10000 })
    const box1 = (await card.boundingBox())!
    const clickX = box1.x + box1.width / 2
    const clickY = box1.y + box1.height / 2

    // 场景 1：卡片上右键（常规位置）
    await card.click({ button: 'right' })
    const probe1 = await probeMenu('normal')
    await page.keyboard.press('Escape')

    // 场景 2：缩小窗口后右下角右键（钳制路径）
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w.isMaximized()) w.unmaximize()
      w.setSize(640, 480)
    })
    await page.waitForTimeout(300)
    await card.click({ button: 'right' })
    const probe2 = await probeMenu('clamped')
    await page.keyboard.press('Escape')

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})

    // —— 断言（取证信息已全量打印）——
    expectMenuInViewport(probe1, 'normal')
    expectMenuInViewport(probe2, 'clamped')
    // 常规场景菜单位置应贴近右键点（允许钳制内移，但不应偏离超过半视口）
    expect(Math.abs(probe1.x - clickX), 'normal 贴近右键点 x').toBeLessThan(probe1.innerWidth / 2)
    expect(Math.abs(probe1.y - clickY), 'normal 贴近右键点 y').toBeLessThan(probe1.innerHeight / 2)
  })

  test('预览 Modal 内右键：菜单完全落在视口内', async () => {
    const card = page.locator('.card').first()
    await card.waitFor({ timeout: 10000 })
    // 双击打开预览（v2.4.8 交互：单击选择、双击预览）
    await card.dblclick()
    const previewZone = page.locator('.aspect-video').first()
    await previewZone.waitFor({ timeout: 10000 })
    await previewZone.click({ button: 'right' })
    const probe = await probeMenu('modal')
    await page.keyboard.press('Escape') // 关菜单
    expectMenuInViewport(probe, 'modal')
    await page.keyboard.press('Escape') // 菜单已关，这次 Esc 落到预览 Modal 将其关闭（避免遮挡后续用例）
    await page.waitForSelector('.aspect-video', { state: 'detached', timeout: 3000 }).catch(() => {})
  })

  test('产品集右键菜单：点击外部关闭（payload 页面统一关闭语义）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-ctx2-'))
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '外部关闭集' }))

    await page.evaluate(async () => {
      window.history.pushState({}, '', '/product-sets')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const card = page.locator('.card').first()
    await card.waitFor({ timeout: 10000 })

    // 右键 → 菜单出现（ProductSets 用 Show when=payload()——payload 残留曾是 menus 不消失的根因）
    await card.click({ button: 'right' })
    await page.waitForSelector('#ctx-menu-root', { timeout: 5000 })

    // 点击页面空白处（标题区）→ 菜单应卸载
    await page.mouse.click(600, 120)
    await page.waitForSelector('#ctx-menu-root', { state: 'detached', timeout: 3000 })

    // 再次右键仍可打开（payload 清理后重新设置无碍）
    await card.click({ button: 'right' })
    await page.waitForSelector('#ctx-menu-root', { timeout: 5000 })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#ctx-menu-root', { state: 'detached', timeout: 3000 })

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
