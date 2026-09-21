import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * ⚠ v2.5.9（A9 刀2a）判据换过一次：本文件当年钉的是「恢复会把名字**写回 config**，界面要跟上新 config」。
 *   现在删除/恢复都不再碰那张表（表的角色=新建模板），界面看的是盘 ⇒ 同名判据挪到「那一排 tab」上，
 *   并且**反向**断言表没被改写。缺陷本体（恢复了却看不见）仍由第 5 步守着，只是守的是用户看得见的东西。
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

  const imgTabs = () =>
    page.evaluate(() => Array.from(document.querySelectorAll('.seg-item')).map((e) => (e.textContent ?? '').trim()))

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
    // A9 刀2b：新建只落本实体，**不再写**全站模板表（要改默认集去「设置 → 子文件夹」；旧断言钉的正是那个偷偷写表的行为）
    expect(await imgFolders()).not.toContain('恢复验证类')
    // 下面要测的是「删除/恢复不得动模板表」⇒ 前提得**显式**造出来（模拟用户自己去设置页登记过）：
    await page.evaluate(async () => {
      const cur = await (window as any).qihebox.config.get()
      const next = { ...cur.data, image_subfolders: [...new Set([...(cur.data.image_subfolders ?? []), '恢复验证类'])] }
      const r = await (window as any).qihebox.config.update(next) // 面叫 update（我上一版凭印象写成 set ⇒ 直接 not a function）
      if (!r.success) throw new Error(`登记模板失败：${JSON.stringify(r).slice(0, 120)}`)
    })
    expect(await imgFolders(), '前提：已显式登记进模板表').toContain('恢复验证类')

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
    // A9 刀2a 之后的口径：删除**不再**从 config 模板表里划名（那是用户报的「删一个动全身」），
    // 所以这里判的必须是**用户真正看的那排 tab** 消失；表反而要原样留着（它只是新建模板）。
    expect(await imgFolders(), '删除不该再动全站模板表').toContain('恢复验证类')
    // 本步走的是裸 IPC（不是界面上的「删除当前子文件夹」按钮），所以路由不会自动跳走；
    // 而 tab 名单的刷新时机是「进/换文件夹时重拉」（刀1b 定的口径，刻意不做轮询）。
    // ⇒ 先像用户那样跳去「主图」，再判那排 tab 里已经没有它。
    await page.evaluate(() => {
      window.location.hash = decodeURIComponent('/files/image/恢复集/主图')
    })
    await page.waitForTimeout(600)
    await expect.poll(imgTabs, { timeout: 10000, intervals: [300, 300, 300] }).not.toContain('恢复验证类')

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

    // 4) A9 刀2a：表**全程不参与**恢复（既没被删掉，也不需要被回填）⇒ 这里判它仍是原样，
    //    真正的保证挪到第 5 步的「tab 回来了没有」——那才是用户看的东西。
    expect(await imgFolders(), '模板表被恢复动作改写').toContain('恢复验证类')

    // 5) ★ 本缺陷的主判据：进文件页看**子文件夹标签条**——恢复后它应当立刻回来。
    //    去一个**不同**的文件夹：真实用户是从「回收站」那页恢复完再走回文件页，路由必然变；
    //    而 tab 名单的刷新时机就是路由变（刀1b 定的口径，刻意不做轮询）⇒ 若还跳回原文件夹
    //    就是无操作，测出来的「没刷新」会是测试自己的假故障。
    await page.evaluate(() => {
      window.location.hash = decodeURIComponent('/files/image/恢复集/白底图')
    })
    await page.waitForTimeout(1200)
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('.seg-item')).map((b) => b.textContent?.trim()))
    expect(tabs, `恢复后子文件夹标签没回来（tab 名单以盘为准，见 A9 刀1b/2a）：当前 tabs=${JSON.stringify(tabs)}`).toContain('恢复验证类')
  })
})
