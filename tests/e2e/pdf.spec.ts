import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 生成一个最小的合法单页 PDF（PDF OK 文本），xref 偏移程序化计算保证解析正确。
 * 用于 PDF 预览回归测试（v2.4.2：曾因 pdfjs worker 加载失败导致 PDF 打不开）。
 */
function minimalPdf(): Buffer {
  const stream = 'BT /F1 24 Tf 72 720 Td (PDF OK) Tj ET\n'
  const objs: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    4: `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  }
  let out = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 1; i <= 5; i++) {
    offsets[i] = out.length
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = out.length
  out += 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'utf-8')
}

test.describe('PDF 预览回归（v2.4.2）', () => {
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

  test('双击 PDF → pdfjs 渲染出 canvas，无「PDF 预览失败」', async () => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-pdf-'))
    const srcPdf = path.join(os.tmpdir(), `pdf-reg-${Date.now()}.pdf`)
    await fsp.writeFile(srcPdf, minimalPdf())

    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: 'PDF系列' }))

    const imp = (await page.evaluate(
      async (srcPdf: string) => {
        const qb = (window as any).qihebox
        return new Promise((resolve) => {
          const unsub = qb.events.on('import:complete', (data: any) => {
            unsub()
            resolve(data)
          })
          void qb.files.import({
            source_paths: [srcPdf],
            target_product_set: 'PDF系列',
            target_type: 'cert',
            sub_folder: '3C',
          })
        })
      },
      srcPdf,
    )) as { success: boolean }
    expect(imp.success).toBe(true)

    await page.evaluate(async () => {
      window.history.pushState({}, '', `/files/cert/${encodeURIComponent('PDF系列')}/${encodeURIComponent('3C')}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForSelector('.card', { timeout: 15000 })

    await page.evaluate(() => {
      const el = document.querySelector('.card') as HTMLElement
      el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    // pdfjs 渲染完成标志：出现 canvas（渲染队列开始），且无错误横幅
    await page.waitForFunction(
      () => document.querySelectorAll('canvas').length > 0,
      null,
      { timeout: 20000 },
    )
    const bodyText = await page.evaluate(() => document.body.innerText)
    expect(bodyText).not.toContain('PDF 预览失败')
    expect(errors.filter((e) => !e.includes('DevTools'))).toEqual([])
    const pageInfo = bodyText.match(/← 上一页\s*\d+\s*\/\s*(\d+)/)
    expect(pageInfo).toBeTruthy() // 页码出现且非 0/0

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(srcPdf, { force: true }).catch(() => {})
  })
})
