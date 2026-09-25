/**
 * v2.5.9（A9 刀1b）：子文件夹那一排 tab **以盘为准** 的端到端判据
 *
 * 钉的是用户报的原始症状（设计 `内部 A9 设计（不进公开仓）` §一）：
 *  ① 手工在盘上建的目录（全局表里没登记过）——**旧行为下永远看不见**，现在必须出现；
 *  ② 在 A 集删一个类型，**B 集的 tab 不得跟着消失**（旧行为：那张表全站一份，删名字＝全站没）；
 *  ③ 空目录要**看得见**（淡一档 + 悬停有解释），不是"没文件就当它不存在"。
 *
 * 三条都是"改回旧实现就必红"的反证（不靠 `--list` 那种存在性自证）。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test.describe('A9 · 子文件夹 tab 以盘为准', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string

  /** 导航只能改 hash：渲染层不是 http 服务（`page.goto('http://localhost/…')` 会连接被拒） */
  const gotoFolder = async (set: string, sub: string) => {
    await page.evaluate((h) => {
      window.location.hash = h
    }, `#/files/image/${encodeURIComponent(set)}/${encodeURIComponent(sub)}`)
  }

  const segText = () =>
    page.locator('.seg-item').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))
  /** v2.6.1 B16：读某个 tab 的**计算色**（真读数；判"淡一档"必须比色，token 命中 ≠ 与相邻档有色差） */
  const segColor = (name: string) =>
    page
      .locator('.seg-item')
      .filter({ hasText: new RegExp(`^${name}$`) })
      .evaluate((el) => getComputedStyle(el).color)
  /** 'rgb(r, g, b)' → [r, g, b]（读不出来即红） */
  const parseRgb = (s: string): [number, number, number] => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s)
    expect(m, `计算色读不出来：${s}`).not.toBeNull()
    return [Number(m![1]), Number(m![2]), Number(m![3])]
  }
  /** 相对亮度（"淡" = 更浅 ⇒ 亮度更高） */
  const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('a9-subfolders') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // 桥没通之前不要 evaluate（否则会拿到 undefined）
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-subfolders-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => {
      await (window as any).qihebox.productSets.create({ name: '甲集' })
      await (window as any).qihebox.productSets.create({ name: '乙集' })
    })
  })

  test.afterAll(async () => {
    await app?.close()
    if (wsDir) await fsp.rm(wsDir, { recursive: true, force: true })
  })

  test('① 盘上新建的目录不用重启、不用登记就出现在 tab 里（P2 根治）', async () => {
    await gotoFolder('甲集', '主图')
    await expect(page.locator('.seg-item').first()).toBeVisible({ timeout: 15000 })

    // 绕过应用，直接在硬盘上建目录（模拟手工建 / 坚果云同步进来）
    await fsp.mkdir(path.join(wsDir, '产品集', '甲集', '图包', '场景实拍'), { recursive: true })

    // 不重载页面：切一次 tab 就会重新拉名单（同一实体内导航即触发刷新）
    await page.locator('.seg-item', { hasText: '详情页' }).first().click()
    await expect.poll(segText, { timeout: 10000, intervals: [300, 300, 300] }).toContain('场景实拍')
    // 且它真能被点开（不是个死标签）
    await page.locator('.seg-item', { hasText: '场景实拍' }).first().click()
    await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toContain('场景实拍')
  })

  test('② 在甲集删掉一个文件夹，乙集的同名文件夹不受影响（P1 根治）', async () => {
    const imgs = (set: string) => path.join(wsDir, '产品集', set, '图包')
    for (const set of ['甲集', '乙集']) {
      await fsp.mkdir(path.join(imgs(set), '共同目录'), { recursive: true })
    }

    // 在甲集用应用自己的删除动作（走 files.deleteSubfolder）
    await gotoFolder('甲集', '共同目录')
    await expect(page.locator('.seg-item', { hasText: '共同目录' }).first()).toBeVisible({ timeout: 15000 })
    // v2.6.1 B16：删除入口必须是**用户真点得到的那个按钮**——找不到即红。
    // 旧写法 `if (await count) {点它} else {直接调 IPC}` 在按钮整个消失时静默走兜底、本条仍绿；
    // 实测旧选择器恒 0（工具栏按钮文案是「🗑️ 删除当前图包类型」，title 也没有"删除"）⇒ 从没点过按钮。
    const del = page.getByRole('button', { name: /删除当前.*类型/ })
    await expect(del).toBeVisible({ timeout: 15000 })
    await del.click()
    // 删除在确认弹窗之后才发生：弹窗与确认按钮也真点（少一道即红）
    const confirm = page
      .getByRole('dialog', { name: '删除子文件夹' })
      .getByRole('button', { name: '删除', exact: true })
    await expect(confirm).toBeVisible({ timeout: 10000 })
    await confirm.click()

    // 甲集：那个 tab 消失
    await gotoFolder('甲集', '主图')
    await expect.poll(segText, { timeout: 10000, intervals: [300, 300, 300] }).not.toContain('共同目录')
    // 乙集：**同名 tab 必须在**（旧实现里那张全局表被划掉名字 ⇒ 这里也会没，就是用户报的病）
    await gotoFolder('乙集', '主图')
    await expect.poll(segText, { timeout: 10000, intervals: [300, 300, 300] }).toContain('共同目录')
    // 且乙集那个目录盘上还在（删除只动了甲集）
    await expect(fsp.stat(path.join(imgs('乙集'), '共同目录'))).resolves.toBeTruthy()
  })

  test('③ 空目录看得见但淡一档，并给一句解释（用户拍板"空的要显示并且淡一点"）', async () => {
    await fsp.mkdir(path.join(wsDir, '产品集', '甲集', '图包', '空壳壳'), { recursive: true })
    await gotoFolder('甲集', '主图')
    await expect.poll(segText, { timeout: 10000, intervals: [300, 300, 300] }).toContain('空壳壳')

    // v2.6.1 B16：读**计算色**真读数与相邻基线档断言有色差（且更浅）。
    // 只判 class 含 text-surface-400 是 token 命中——两档被调成同色（色差静默失效）时照样绿。
    const title = await page
      .locator('.seg-item')
      .filter({ hasText: /^空壳壳$/ })
      .getAttribute('title')
    expect(title).toContain('还没有文件')

    // 对照：有文件的目录不走淡档（证明淡的是"空"，不是"新"）
    const full = path.join(wsDir, '产品集', '甲集', '图包', '有货货')
    await fsp.mkdir(full, { recursive: true })
    await fsp.writeFile(path.join(full, 'a.png'), 'x')
    await page.locator('.seg-item').first().click()
    await expect.poll(segText, { timeout: 10000, intervals: [300, 300, 300] }).toContain('有货货')
    await page.locator('.seg-item', { hasText: '主图' }).first().click()
    await expect.poll(segText, { timeout: 10000, intervals: [300, 300, 300] }).toContain('有货货')

    const emptyColor = await segColor('空壳壳')
    const baseColor = await segColor('有货货')
    expect(emptyColor).not.toBe(baseColor) // 与相邻档有色差（读到同色即红）
    expect(luma(parseRgb(emptyColor))).toBeGreaterThan(luma(parseRgb(baseColor))) // 淡 = 更浅
  })
})
