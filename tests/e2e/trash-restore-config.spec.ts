import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 回收站恢复被删子文件夹：磁盘 config 回填 + 界面标签条必须一起跟上。
 *
 * 起因为用户报的第二件事（产品集内删/建文件夹「牵动全身」）追出的一条**正确性假设**：
 * `src/main/core/trash.ts:168-187` 在恢复被删子文件夹时会回填 `cfg.image/cert/doc/customer_subfolders`
 * 并 `saveConfig`，而恢复入口 `Trash.tsx:112 handleRestore` 成功后只 `loadTrash()`、**不刷 config 信号**
 * ⇒ 猜想渲染层留着旧 config，随后任何"整份回写"（`updateWorkspaceConfig` → `workspace.ts:233` 整体 saveConfig）
 * 会把刚回填的那条抹掉（丢失更新）。
 *
 * **本文件跑出来是绿的 ⇒ 该假设不成立，已撤回**（写下这条的原因：不撤回，下一轮就有人拿它当真结论）。
 * 不复现的理由也查清了：读数 config-信号的 7 个界面（`FileBrowserView` + ProductSets/Images/Certs/Clients/
 * Search/Settings 各页）**挂载时都各自 `loadWorkspaceConfig()`**，而回收站自己是唯一不显示子文件夹列表的页面
 * ⇒ 用户从回收站回到任何界面时必然重读，旧信号活不过一次换页。**丢失更新的窗口实际为 0。**
 *
 * 那这条测试还留着的价值：它钉的是**正向保证**，不是我的猜想——
 * 恢复后「磁盘 config 有它」与「标签条有它」必须同时成立（谁把 trash.ts 的回填改坏、
 * 或把某页 mount 期的 config 重读删掉，这里都会红）。现有套件里没有任何一条端到端覆盖恢复链。
 */
test.describe('回收站恢复子文件夹：界面与 config 同步', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  test.beforeAll(async () => {
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-trash-cfg-'))
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('trash-restore-config') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => {
      await (window as any).qihebox.productSets.create({ name: '恢复集' })
    })
  })

  test.afterAll(async () => {
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
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
  })

  const imgFolders = () =>
    page.evaluate(async () => {
      const r = await (window as any).qihebox.config.get()
      return (r.data.image_subfolders ?? []) as string[]
    })

  test('删除→恢复：磁盘 config 回填了，渲染层信号也必须跟上', async () => {
    // 1) 新建一个子文件夹（走渲染层入口，顺带让它刷新信号）
    await page.evaluate(async () => {
      const r = await (window as any).qihebox.files.createSubfolder({
        product_set: '恢复集',
        file_type: 'image',
        name: '恢复验证类',
        scope: 'productSet',
      })
      if (!r.success) throw new Error(`建夹失败：${JSON.stringify(r).slice(0, 120)}`)
    })
    await page.evaluate(() => {
      window.location.hash = decodeURIComponent('/files/image/恢复集/恢复验证类')
    })
    await page.waitForTimeout(800)
    expect(await imgFolders()).toContain('恢复验证类')

    // 2) 删除（进回收站，不真删）
    await page.evaluate(async () => {
      const r = await (window as any).qihebox.files.deleteSubfolder({
        product_set: '恢复集',
        file_type: 'image',
        name: '恢复验证类',
        scope: 'productSet',
      })
      if (!r.success) throw new Error(`删夹失败：${JSON.stringify(r).slice(0, 120)}`)
    })
    await page.waitForTimeout(600)
    expect(await imgFolders()).not.toContain('恢复验证类')

    // 3) 从回收站恢复（走渲染层入口，与用户点「恢复」同一条代码路径）
    const restored = await page.evaluate(async () => {
      const list = await (window as any).qihebox.trash.list()
      const items = (list.data?.items ?? list.data ?? []) as Array<{ id: string; original_path?: string; path?: string; name?: string }>
      const hit = items.find((i) => JSON.stringify(i).includes('恢复验证类'))
      if (!hit) throw new Error(`回收站里找不到被删的子文件夹：${JSON.stringify(items).slice(0, 300)}`)
      const r = await (window as any).qihebox.trash.restore(hit.id)
      if (!r.success) throw new Error(`恢复失败：${JSON.stringify(r).slice(0, 160)}`)
      return true
    })
    expect(restored).toBe(true)
    await page.waitForTimeout(800)

    // 4) 判据：主进程侧磁盘 config 确实回填了（这条先立住，否则第 5 步可能是"主进程也没写"）
    const onDisk = await imgFolders()
    expect(onDisk, '主进程恢复时未回填 image_subfolders（那是另一个缺陷，先钉住现状）').toContain('恢复验证类')

    // 5) ★ 本缺陷的主判据：进文件页看**子文件夹标签条**——恢复后它应当立刻回来。
    //    不刷新信号时，标签条读的是旧的 workspaceConfig ⇒ 恢复了却看不见（要重启才出现）。
    await page.evaluate(() => {
      window.location.hash = decodeURIComponent('/files/image/恢复集/主图')
    })
    await page.waitForTimeout(1200)
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.seg-item')).map((b) => b.textContent?.trim()))
    expect(tabs, `恢复后子文件夹标签没回来（渲染层 workspaceConfig 未同步）：当前 tabs=${JSON.stringify(tabs)}`).toContain('恢复验证类')
  })
})
