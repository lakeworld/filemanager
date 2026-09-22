import { expect, type Locator, type Page } from '@playwright/test'

/**
 * SearchSelect（v2.5.8 W4 起站内唯一的下拉）的 e2e 动作助手。
 *
 * 为什么要有这个文件：D9 控件统一 II 把 34 处原生 select 换成 SearchSelect，
 * 各 spec 原先一行 `selectOption(...)` 变成「点触发器 → 等 Portal 弹层 → 点选项」三步；
 * 16 个调用点各写三遍就会各自漂移（弹层属性名一改全崩），故收此处——与
 * `helpers/launch.ts` 把 userData 命名收成单一真相源同理。
 *
 * 定位口径照 tests/e2e/search-select.spec.ts（本组件首批使用者）：
 * - 触发器 = 挂 `aria-label` 的 button ⇒ 旧代码里的 `page.getByLabel('状态筛选')` **原样可用**；
 * - 弹层 = Portal 到 body 的 `[data-search-select]`，收起时**整个从 DOM 消失**
 *   （原生 option 是常驻 hidden，所以「某选项在不在列表里」这类断言必须先开面板再断言）；
 * - 选项 = `[role="option"][data-option="<值>"]`，按**值**点，与 `selectOption(value)` 一一对应。
 *
 * 纪律：只换定位方式，不改任何断言语义（内部评审守则 §三.3）。
 */

/** 弹层根节点（同时最多开一个：组件里点外/滚动都会先收起） */
export function selectPanel(page: Page): Locator {
  return page.locator('[data-search-select]')
}

/** 打开某个 SearchSelect 的弹层并等它真的挂上 DOM */
export async function openSelect(page: Page, trigger: Locator): Promise<Locator> {
  // 先把**触发器**滚到可视区再点开：弹层是 fixed 定位，组件按设计「触发器所在滚动链一滚就收起」
  // （见 SearchSelect onScroll 注释：滚了面板就会与触发器错位）。若把这一步留给 Playwright 在
  // 点选项时补做，就会出现「为够到选项而滚页 → 面板自收起 → 点击永远追不上」的死循环
  // （2026-09-11 设置页标签父级实测：`element was detached from the DOM, retrying` 30s 超时）。
  await trigger.scrollIntoViewIfNeeded()
  await trigger.click()
  const panel = selectPanel(page)
  await panel.waitFor({ state: 'visible', timeout: 5000 })
  return panel
}

/**
 * 选一项：等价旧的 `selectOption(value)`。
 * @param value 选项的**值**（不是显示文本）；「全部 / 不关联」这类哨兵传 `''`
 */
export async function pickOption(page: Page, trigger: Locator, value: string): Promise<void> {
  const panel = await openSelect(page, trigger)
  if (process.env.QH_SS_DEBUG) {
    const cnt = await optionOf(panel, value).count()
    const txt = await panel.innerText().catch(() => "<<读不到>>")
    console.log(`[ss-debug] 目标值=${value} 命中=${cnt} 面板全文=<<<${txt}>>>`)
  }
  await optionOf(panel, value).click()
  // 选完面板必须收起（组件 pick() 里跟着 close()）；不收起说明接线断了，让它在这里就红
  await selectPanel(page).waitFor({ state: 'detached', timeout: 5000 })
}

/** 断言某值在选项列表里（替代旧的「收起态 option 存在性」断言），断言完 Esc 收起 */
export async function expectOptionExists(page: Page, trigger: Locator, value: string): Promise<void> {
  const panel = await openSelect(page, trigger)
  await expect(optionOf(panel, value)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await selectPanel(page).waitFor({ state: 'detached', timeout: 5000 })
}

/** 断言某值**不在**选项列表里，断言完 Esc 收起 */
export async function expectOptionMissing(page: Page, trigger: Locator, value: string): Promise<void> {
  const panel = await openSelect(page, trigger)
  await expect(optionOf(panel, value)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await selectPanel(page).waitFor({ state: 'detached', timeout: 5000 })
}

/** 按值取选项节点（值里可能带引号/反斜杠：标签名与产品集名是任意字符，先转义再拼选择器） */
function optionOf(panel: Locator, value: string): Locator {
  return panel.locator(`[data-option="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
}
