/**
 * UI 控件清点器自校验门禁（v2.5.8 D13 样式统一收口，2026-09-12）
 *
 * 锁的是 `scripts/scan-ui-inventory.mjs` 这个**清点器本身**：它输出的三面计数必须等于
 * 2026-09-12 人工实测的基准值。清点器一旦解析退化（漏标签、跨行截断、把注释里的 `<input>`
 * 当成真控件），本文件立即红——明天 D13 的「棘轮基线」直接把它当口径守门人用。
 *
 * 为什么非要机器化：本仓的铁教训是「口径数字不能是一条 grep + wc -l」。
 * 实测过的手搓材质文本框真值 7 处，只 grep `type="text"` 也"恰好"得 7——两个反向偏差抵消
 * （漏掉省写 `type` 的 3 处、混进底座内部的 2 处）。所以计数必须来自**标签体解析**，
 * 而这条事实本身也需要回归保护，于是有了本文件。
 *
 * 与卡上基准值的唯一偏差（另有用例专门钉住，交主线程判断，不静默改数）：
 *   卡上写 handwritten 146 / noclass 1，本清点器解析出 **147 / 0**。
 *   差的是 `components/ui/SearchSelect.tsx` 那个触发器 `<button>`（现 :240，D21b 加复算定位后从 211 漂下来）：
 *   它的 `class` 写在 `ref={(el) => { … }}` 的 `>` **之后**，任何在 `>` 处截断标签的扫描都会把它
 *   读成「没有 class 属性」。它确实有 class（`… border border-surface-200 rounded-lg bg-white …`），
 *   按卡上定义（noclass = 没有 class 属性）应归 **handwritten**。
 *   两口径其余四个数（总 270 / unified 123 / 贴档底色 35 / 无 transition 79）完全一致——
 *   该处既不含组件档底色、也不含 `active:scale`，且自带 `transition-colors`。
 *
 * 形态说明：清点器是 `.mjs` 且本任务不许动其他文件（无 `.d.mts`，仓内先例见
 * `scripts/memory-measurement.d.mts`），故走**非字面量 specifier 的动态 import** + 本地类型面，
 * 以免 `tsc -p tsconfig.node.json` 报 TS7016。将来补了 `.d.mts` 可换回字面量 import。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------- 清点器返回值的类型面 ------------------------- */

interface ButtonHit {
  file: string;
  line: number;
  tag: string;
  classText: string | null;
  variants: string[];
  category: 'unified' | 'handwritten' | 'noclass' | 'other';
  /** 挂上的形状具名档（`.link-btn`/`.icon-btn`/`.row-btn`/`.seg-item`/`.chip`） */
  shapeRecipes: string[];
  /** 住在底座目录里（`components/ui/` + `MoneyInput.tsx`）= 实现内部，不算页面欠账 */
  inBase: boolean;
  /** 真欠账 = 页面/业务组件侧手写、没走任何统一档、且不在底座内部（棘轮看这一格） */
  isDebt: boolean;
  /** 已走任一统一档（五档 `btn-*` 或形状档）= 节奏由骨架提供，调用点不必再写 transition */
  usesUnifiedRecipe: boolean;
  hasComponentTint: boolean;
  tintTokens: string[];
  hasPress: boolean;
  hasTransition: boolean;
  /** class 写在标签体内第一个 `>` 之后 = 截断式扫描会误判成 noclass */
  truncationSensitive: boolean;
}
interface InputHit {
  file: string;
  line: number;
  tag: string;
  type: string | null;
  typeId: string | null;
  classText: string | null;
  material: boolean;
  category: 'checkbox' | 'baseInternal' | 'exempt' | 'debt' | 'other';
}
interface ModalHit {
  file: string;
  line: number;
  tag: string;
  framed: boolean;
  framedValue: string | null;
}
interface Inventory {
  root: string;
  files: string[];
  buttons: ButtonHit[];
  inputs: InputHit[];
  modals: ModalHit[];
  summary: {
    buttons: {
      total: number;
      unified: number;
      handwritten: number;
      noclass: number;
      other: number;
      handwrittenWithTint: number;
      /** 真欠账（页面/业务组件侧手写且未走任何统一档）——棘轮与 D14 出口都看这一格 */
      debt: number;
      /** 底座内部手写点位（不计欠账，由 uiInventory 的 BTN_BASE_INTERNAL 逐文件钉死） */
      baseInternal: number;
      handwrittenWithPress: number;
      handwrittenNoTransition: number;
      truncationSensitive: number;
    };
    inputs: { total: number; checkbox: number; baseInternal: number; debt: number; exempt: number; other: number };
    modals: { total: number; framed: number; unframed: number };
  };
}

/** 非字面量 specifier：TS 不去解析模块声明，运行时仍按文件 URL 加载真实清点器 */
const scannerUrl = pathToFileURL(path.join(ROOT, 'scripts', 'scan-ui-inventory.mjs')).href;
const { collectUiInventory, blankComments, SHAPE_RECIPE_CLASS } = (await import(scannerUrl)) as {
  collectUiInventory: (opt?: { root?: string; subdir?: string }) => Inventory;
  blankComments: (src: string) => string;
  SHAPE_RECIPE_CLASS: RegExp;
};

/** 人工实测基准值（逐处数过，与卡上 146/1 的差异见本文件头注释）。
 *  ⚠ **本表纪律**（立项时立的，收口后继续有效）：基准值是**快照**，只在两个时刻动——
 *  ① 产品代码真把某面收干净了 ⇒ 跑 `node scripts/scan-ui-inventory.mjs` 取新数、在此显式更新、
 *    并把 diff 与成因贴进动作文档；② 清点器口径本身变了 ⇒ 同上，且要在成因里写清是哪一条判据。
 *  不许为了让本文件绿而回退产品改动，也不许悄悄改数（悄悄改数 = 门禁形同虚设）。
 *  `debt` 格是棘轮的真正指标（页面侧手写且未挂任何统一档），不是 `handwritten`。 */
/** D14 出口快照（2026-09-12 收口，`node scripts/scan-ui-inventory.mjs` 现算）。
 *  与上面 D13 起点值的逐项差与**成因**（本文件的注释要求"显式更新 + 把 diff 说清楚"，逐条如下）：
 *   - `total 270 → 269`：**唯一的真减法**。`pages/Settings.tsx` 那个没有 `onClick` 的装饰性色点
 *     从 `<button>` 改成 `<span>`——它全站唯一一个"看起来是按钮、点不动、还自带按压反馈位"的语义错误，
 *     留着的代价是「无 onClick 的 button」这一类以后还会再长出来。（`grep -c '<button'` 现数 271
 *     比本数多 2：一处是我写在注释里的 `<button>` 字样——清点器按纪律剥注释；一处是一行里两个标签，
 *     `grep -c` 数行不数出现。）
 *   - `unified 123 → 141`：18 处收进 `.btn-*` 五档。
 *   - `handwritten 147 → 128`：五档 +18；形状具名档在清点器口径里**仍算 handwritten**（它确实不是五档），
 *     所以这一格不是收口指标，`debt` 才是。
 *   - `tint 35 → 0`：主判据清零。同时判据本身改了两条边界（缺一都会留下洗不掉的假欠账）：
 *     只看**基态**底色（`hover:bg-surface-100` 是形状档唯一合法的贴色方式）+ 挂形状档即豁免。
 *   - `debt 141 → 6`：**本卡的主指标**。剩的 6 处全是"形状档装不下"的具名点位（DatePicker 触发器、
 *     Clients 报价整行、Notes 弹窗段选、Quotes 单号链接、PluginManagerPage 两枚 `role="switch"`），
 *     逐处登记在 `__baselines__/ui-button-material.md`，另立下一批（新增 `.switch` 档 / 段选档的判定；
 *     原 D15 与本卡同执行日，名额已用尽，别再挂 D15 名下）。
 *   - `baseInternal 5`：新增格。`ui/Button` `ui/SearchSelect`×2 `ui/SelectionBar`×2 自己就得写材质，
 *     与输入框面 `baseInternal` 同一口径；门禁那边由 `BTN_BASE_INTERNAL` 逐文件点名，不放通配。
 *   - `noTransition 79 → 4`：指标定义同步改了——只数**未走任何统一档**的点位（挂上档后过渡住在类定义里，
 *     读 class 字面会把它算成"没过渡"，于是收口越努力、这个数越红：实测 79→96 的反向告警）。
 *   - `input total 23 → 16` / `debt 7 → 0`：7 处手搓材质文本框全部收进 `ui/Input`
 *     （为此给底座补了 `compact` 与 `autoFocus`），7 个裸 `<input>` 不再是真控件计数。
 *   - `total 269 → 271` / `handwritten 128 → 130`（**v2.5.8 D18 预览连续切换**）：
 *     `FilePreviewModal` 预览画面区新增 ◀ ▶ 两枚导航按钮。走的是**形状具名档 `.icon-btn`**
 *     （AGENTS §二.8 两条合法路之一），所以 `debt` 仍是 6、`tint` 仍是 0、`press` 仍是 0——
 *     清点器口径里形状档仍归 handwritten，这一格本来就不是收口指标（见上条）。
 *     增数是因为**多了两个真按钮**，不是谁各写各的：这也是为什么这两格该动而 `debt` 不该动。
 *   - `total 271 → 272` / `handwritten 130 → 131`（**v2.5.9 A6-2 全局后退钮**）：
 *     `Header` 顶栏新增一枚 «←» 后退（`navigate(-1)`，吃浏览器历史不自己记栈），走**形状具名档 `.icon-btn`**
 *     （AGENTS §一.8 两条合法路之一）⇒ 与上条 D18 同口径：形状档在清点器里归 handwritten，
 *     这一格**本就不是收口指标**；`debt` 仍 6、`tint` 仍 0、`press` 仍 0（增数 = 多了一个真按钮）。
 *   - `total 272 → 274` / `handwritten 131 → 133`（**v2.5.9 A8 账号区三态**）：
 *     `Profile` 账号区新增两枚文字链接钮（「重置密码 →」跳官网、「返回登录 →」回登录态），
 *     走的都是形状具名档 `.link-btn`（AGENTS §一.8 两条合法路之一）⇒ 与 D18 / A6-2 同口径：
 *     形状档归 handwritten 这一格本就不是收口指标（`debt` 仍 6 / `tint` 0 / `press` 0），
 *     增数 = 多了两个真按钮。提交按钮走 `ui/Button` 底座，不进这一格。
 *   - `modal framed 6 → 21`：D14 先按 PLAN 判据推 9 个（15），D16 收尾时**判据的前提被实测推翻**——
 *     原列"不推"的 6 个里有 5 个本来就自绘了标题行与底部按钮行（`ConfirmDialog:23` `MoveDialog:93`
 *     `ArchiveProgressDialog:144` `SupplierDetail` 编辑档弹窗 `Invoice/InboundEditorModal`），套 framed 是
 *     **拆掉重复的标题与页脚**、不是"多空一层头"。用户 09-12 复拍「推平 21 个」⇒ 未迁名额清零。 */
const BASE = {
  button: {
    total: 274, unified: 141, handwritten: 133, noclass: 0,
    tint: 0, debt: 6, baseInternal: 5, press: 0, noTransition: 4,
  },
  input: { total: 16, checkbox: 12, baseInternal: 3, debt: 0, exempt: 1, other: 0 },
  modal: { total: 21, framed: 21, unframed: 0 },
} as const;

/** D16 收口后这张名单**必须为空**：全站 21 个业务调用点一律走 `framed` 骨架。
 *  表留着而不删，是因为它是双向的——往里加一行 = 公开登记一个豁免，必须同时写上理由并同步改
 *  上面 `BASE.modal` 的两个数；谁把某个弹窗改回非 framed，下面那条用例直接红。
 *  （D14 曾在这里点名列过 6 个"本轮不推"的，判据前提被 D16 实测推翻，见上方差值说明。） */
const UNFRAMED_ALLOWED: readonly string[] = [];

/** D13 立项时人工点名的 7 处输入框欠账所在文件。
 *  **D14 收口后 7 处全部消失**（收进 `ui/Input`，为此给底座补了 `compact` 与 `autoFocus`）。
 *  这里不再钉行号——点位已经不存在了，钉行号只会逼后来人"为了让测试绿而保留旧写法"；
 *  留成**文件级回归锚**：这批文件里再冒出一处手搓材质文本框就红。原始 7 处清单见
 *  `docs/INTERNAL/清点-2026-09-12-样式统一收口.md` §四。 */
const DEBT_FILES: ReadonlyArray<string> = [
  'src/renderer/src/pages/Search.tsx',
  'src/renderer/src/components/PdfPreview.tsx',
  'src/renderer/src/pages/Clients.tsx',
  'src/renderer/src/pages/ProductSets.tsx',
  'src/renderer/src/pages/Settings.tsx',
];

/** 底座内部三处：ui/Input + ui/SearchSelect + MoneyInput（点名钉住，防「换个文件名躲门禁」） */
const BASE_INTERNAL_POINTS: ReadonlyArray<readonly [string, number]> = [
  ['src/renderer/src/components/ui/Input.tsx', 66],
  // SearchSelect 的 input 位点：v2.5.8 D21b 在同文件加了 `reposition()`（复算定位），
  // 整段 JSX 下移 30 行 ⇒ 251→281。**只是行号漂移**，四个计数一个没动。
  ['src/renderer/src/components/ui/SearchSelect.tsx', 281],
  ['src/renderer/src/components/MoneyInput.tsx', 30],
];

/** 全站只解析一次（纯函数，但 75 个文件没必要重复 11 遍） */
const inv: Inventory = collectUiInventory({ root: ROOT });

const findInput = (file: string, line: number, tol = 3): InputHit | undefined =>
  inv.inputs.find((x) => x.file === file && Math.abs(x.line - line) <= tol);

/** 先红在「找不到」这一句上，而不是让后面的属性访问塌成 undefined 访问 */
function must<T>(v: T | undefined, what: string): T {
  expect(v, `${what}：没找到`).toBeDefined();
  return v as T;
}

describe('UI 控件清点器：三面计数与人工基准值对齐（D13）', () => {
  it('清点器在读渲染层，且根目录可注入（指向别处得空集，不抛异常）', () => {
    expect(inv.root).toBe(ROOT);
    expect(inv.files.length, '.tsx 文件数').toBeGreaterThan(50);
    expect(inv.files.every((f) => f.startsWith('src/renderer/')), '扫描范围只准在渲染层').toBe(true);
    const empty = collectUiInventory({ root: path.join(ROOT, 'scripts') });
    expect(empty.files, '根目录换成 scripts/ 不该扫到渲染层控件').toEqual([]);
    expect(empty.summary.buttons.total).toBe(0);
  });

  it('按钮面：总数与三分类完全等于基准值，且三分类不重不漏', () => {
    const s = inv.summary.buttons;
    const cats = { total: s.total, unified: s.unified, handwritten: s.handwritten, noclass: s.noclass, other: s.other };
    expect(cats, `按钮分类计数漂移（现 ${JSON.stringify(cats)}）`).toEqual({
      total: BASE.button.total,
      unified: BASE.button.unified,
      handwritten: BASE.button.handwritten,
      noclass: BASE.button.noclass,
      other: 0,
    });
    expect(s.unified + s.handwritten + s.noclass + s.other, '三分类必须不重不漏地覆盖全部 <button>').toBe(s.total);
  });

  it(`按钮附加位：贴档底色 ${BASE.button.tint}、真欠账 ${BASE.button.debt}、带按压 ${BASE.button.press}、无过渡 ${BASE.button.noTransition}（数值以 BASE 快照为准，见其注释）`, () => {
    const s = inv.summary.buttons;
    expect(s.handwrittenWithTint, 'hasComponentTint 计数漂移（明天门禁的主判据）').toBe(BASE.button.tint);
    expect(s.debt, '真欠账（手写且未挂任何统一档）漂移——这才是棘轮看的数').toBe(BASE.button.debt);
    // 真欠账必须 ⊆ 手写档；且挂上形状具名档的必须落在欠账之外（量尺认不出"改好了"就是本条的红）
    for (const b of inv.buttons) {
      if (b.category !== 'handwritten') expect(b.isDebt, `非手写档不该计欠账：${b.file}:${b.line}`).toBe(false);
      if (b.shapeRecipes.length > 0)
        expect(b.isDebt, `挂了形状具名档仍计欠账 = SHAPE_RECIPE_CLASS 没认住：${b.file}:${b.line}`).toBe(false);
    }
    expect(s.unified + s.handwritten + s.noclass, '三分类不重不漏覆盖 total').toBe(s.total);
    expect(s.handwrittenWithPress, '手写按钮里出现 active:scale = 绕过 .btn-* 自带按压自己贴').toBe(BASE.button.press);
    expect(s.handwrittenNoTransition, '手写且完全不含 transition 的按钮数漂移').toBe(BASE.button.noTransition);
    // 附加位只在 handwritten 上取真：unified 的按压与过渡住在 .btn-* 类定义里（index.css 的 @apply）
    for (const b of inv.buttons.filter((x) => x.category !== 'handwritten')) {
      expect(b.hasComponentTint, `hasComponentTint 只该在手写档为真：${b.file}:${b.line}`).toBe(false);
    }
  });

  it(`输入框面：真控件 ${BASE.input.total} = checkbox ${BASE.input.checkbox} + 底座内部 ${BASE.input.baseInternal} + 欠账 ${BASE.input.debt} + 豁免 ${BASE.input.exempt}（other 恒 0）`, () => {
    expect(inv.summary.inputs, `输入框计数漂移（现 ${JSON.stringify(inv.summary.inputs)}）`).toEqual(BASE.input);
    expect(
      inv.summary.inputs.checkbox + inv.summary.inputs.baseInternal + inv.summary.inputs.debt + inv.summary.inputs.exempt,
      '四分类必须不重不漏地覆盖全部真控件',
    ).toBe(inv.summary.inputs.total);
  });

  it('注释误命中必须为 0：QuoteFormModal 的 JSDoc 那条 <input> 不算真控件', () => {
    const fromComment = inv.inputs.filter((x) => x.file === 'src/renderer/src/components/QuoteFormModal.tsx');
    expect(fromComment, '该文件的 <input> 只出现在注释里，剥注释后应一个不剩').toEqual([]);
    // 反向守（D14 改版）：原先钉的是「整站恰 23 ⇒ 注释已剥掉，不剥会得 24」。D14 把 7 处手搓输入框收进
    // 底座后总数已变，那个"恰好 +1"既守不住也讲不清，改成**直接验剥注释这一步**：
    // 注释里的标签必须被抹成等长空白——等长是关键，长度一变全站 file:line 就漂了。
    const raw = '<div>\n  {/* <input class="border border-surface-200 rounded"> */}\n  <input class="w-32">\n</div>';
    const stripped = blankComments(raw);
    expect(stripped.match(/<input/g)?.length ?? 0, '注释里的 <input> 没被抹掉').toBe(1);
    expect(stripped.length, '抹注释必须原位留空白而不是删字符（否则全站行号漂移）').toBe(raw.length);
  });

  it('输入框欠账已清零（D14 出口）：全站 debt 恒 0，且 D13 那批文件不得再冒出手搓材质文本框', () => {
    const debt = inv.inputs.filter((x) => x.category === 'debt');
    expect(
      debt.map((x) => `${x.file}:${x.line} 「${(x.classText ?? '').replace(/\s+/g, ' ').slice(0, 80)}」`).join('\n'),
      '页面/业务组件侧又出现手搓材质文本框（D13 立项 7 处已收进 ui/Input，缺能力请补底座而不是绕开它）',
    ).toBe('');
    // 回归锚：D13 人工点名那 7 处所在的 5 个文件，任何一处回退成手搓写法都会让上面那条红；
    // 这一条额外守住「别的文件冒出来」与「这批文件回退」是两回事，红的时候能直接指出是哪一种。
    const regressed = DEBT_FILES.filter((f) => inv.inputs.some((x) => x.file === f && x.category === 'debt'));
    expect(regressed, `这批文件里又出现手搓输入框：${regressed.join(', ')}`).toEqual([]);
  });

  it('底座内部 3 处点名成立（ui/Input、ui/SearchSelect、MoneyInput）', () => {
    for (const [f, line] of BASE_INTERNAL_POINTS) {
      const x = must(findInput(f, line), `底座点位 ${f}:${line}`);
      expect(x.category, `${f}:${line} 归类不是 baseInternal`).toBe('baseInternal');
    }
  });

  it('唯一显式豁免 = Header 顶栏全局搜索框（判据绑 id=global-search-input）', () => {
    const ex = must(inv.inputs.find((x) => x.category === 'exempt'), '唯一豁免点位');
    expect(ex.file).toBe('src/renderer/src/components/Header.tsx');
    expect(ex.typeId, '豁免判据绑 id：改了 id 就是换了点位，要重新审视').toBe('global-search-input');
    expect(inv.inputs.filter((x) => x.category === 'exempt').length, '豁免点位必须恰好 1 处，多一处就要重开卡').toBe(1);
  });

  it(`Modal 面：业务调用点 ${BASE.modal.total} = framed ${BASE.modal.framed} + 未 framed ${BASE.modal.unframed}；未 framed 必须是空集`, () => {
    expect(inv.summary.modals, `Modal 计数漂移（现 ${JSON.stringify(inv.summary.modals)}）`).toEqual(BASE.modal);
    expect(
      inv.modals.filter((m) => m.file === 'src/renderer/src/components/ui/Modal.tsx'),
      'ui/Modal.tsx 内部那处 <ModalInner 不是业务调用点',
    ).toEqual([]);
    /**
     * 「未 framed」这一面**逐文件点名**而不是只数数：只钉计数的话，「把 CreatePsModal 回退成非
     * framed、同时给 ConfirmDialog 套上 framed」这种一增一减能完全躲过。D16 收口后名单为空 ⇒
     * 本条等价于「21 个全部 framed」，谁新造一个不套骨架的弹窗就会红；要豁免必须往名单里加行 + 写理由。
     */
    expect(
      inv.modals.filter((m) => !m.framed).map((m) => m.file).sort(),
      '冒出了未 framed 的业务弹窗调用点——D16 已把 21 个推平，要豁免请改 UNFRAMED_ALLOWED 并写明理由',
    ).toEqual([...UNFRAMED_ALLOWED].sort());
    // framed 独占一行（bare 属性）也要认出来——卡上点名的写法在这里
    const bare = must(
      inv.modals.find((m) => m.file === 'src/renderer/src/pages/productSets/CreatePsModal.tsx'),
      'CreatePsModal 的 <Modal 调用点',
    );
    expect(bare.framed, 'framed 独占一行的写法没被认出 = 属性 token 化退化').toBe(true);
    expect(bare.framedValue, 'framed 是 bare 写法，值记为 "true"').toBe('true');
  });
});

describe('与卡上基准值的差异：147/0 vs 146/1（交主线程拍板，不静默改数）', () => {
  it('差的那一处就是 ui/SearchSelect.tsx 那个触发器 <button>——它有 class，应归 handwritten', () => {
    // 行号只作辅助锚（±5）：钉精确行号会逼后来的改动人「为了不红而改写无关注释的折行」，
    // 那是让测试反过来牺牲可读性。真正的身份判据是 file + classText 内容 + 全站点位唯一性。
    const b = must(
      inv.buttons.find(
        (x) => x.file === 'src/renderer/src/components/ui/SearchSelect.tsx' && Math.abs(x.line - 240) <= 5,
      ),
      'ui/SearchSelect.tsx 里 ~240 行那个触发器 <button>（D21b 前是 211）',
    );
    expect(b.classText, 'class 写在 ref={(el) => …} 的 > 之后，在 > 处截断的扫描会读成 null').toContain('border-surface-200');
    expect(b.category, '按卡上定义（noclass = 没有 class 属性）它不该是 noclass').toBe('handwritten');
    // 两个口径的可数项在这里必然一致：该处无组件档底色、无 active:scale、自带 transition
    expect(b.hasComponentTint).toBe(false);
    expect(b.hasPress).toBe(false);
    expect(b.hasTransition).toBe(true);
  });

  it('全站不存在「真的没有 class 属性」的 <button>（noclass 恒 0）', () => {
    const noc = inv.buttons.filter((x) => x.category === 'noclass');
    expect(noc, '哪天真出现无 class 的按钮，本条会红——那时把上面的基准值改回 1 并说明').toEqual([]);
  });

  /**
   * 取证：卡上那两个数（146 / 1）**恰好**是「标签体扫到第一个 `>` 就收」的口径产物。
   * 这正是本卡自己点名要防的那类偏差（`uiInventory.test.ts` 里也记着同一条 codemod 教训：
   * `[^>]*?>` 会停在 `onKeyDown={(e) => …}` 的 `>` 上把标签截断）。
   * 本用例不是为了「证明主线程错了」，而是把差异的**唯一来源**钉成机器事实：
   * 若将来有人把基准值改回 146/1，本条仍绿，但上一组用例会立刻红在 SearchSelect:211 上。
   */
  it('复现差异来源：截断扫描与本清点器恰好差那一处（差值口径，不依赖具体总数）', () => {
    const naive = naiveCounts();
    const s = inv.summary.buttons;
    /**
     * **D14 改版**：原先钉的是 123/146/1 三个绝对数。那是 D13 那一刻的快照，D14 一天收了 100 多处按钮，
     * 绝对数必然漂（每收一次口就要来改一遍测试 = 测试在拖产品后腿）；而「截断口径只多判 1 处 noclass、
     * 少判 1 处 handwritten」这条**因果**与树的规模无关，才是本用例真正要守的东西。
     * 红在这里 = 解析器退化，或者又多埋了一处「class 写在标签体内 `>` 之后」。
     */
    expect(naive.cats.total, '截断口径连总数都不该变（变了说明标签识别本身退化）').toBe(s.total);
    expect(naive.cats.unified, '截断口径的 unified 不该变（那处敏感点位不含 btn-* token）').toBe(s.unified);
    expect(
      naive.cats.noclass,
      '被截断误判成 noclass 的点位，必须恰好等于清点器自己标出的 truncationSensitive 数',
    ).toBe(s.truncationSensitive);
    expect(
      naive.cats.handwritten,
      'handwritten 与 noclass 的差必须互相抵消（对不上 = 第二处口径漂移，不是那 1 处的事）',
    ).toBe(s.handwritten - naive.cats.noclass);
    // 点位归属取「最后一个冒号之前」：路径本身不含冒号，而 p.split(':')[0] 在 Windows 盘符/拼接形态下会截错
    expect(
      naive.noclassPoints.map((p) => p.slice(0, p.lastIndexOf(':'))),
      '被截断扫描误判成「无 class」的点位，全站有且仅有一处且就在 SearchSelect 里（多一处 = 又有人把 class 写进标签体）',
    ).toEqual(['src/renderer/src/components/ui/SearchSelect.tsx']);
    // 清点器自己标出的「截断敏感」位点 = 差异的那一处（清点表 §六 口径注记的数据来源）
    expect(
      inv.buttons.filter((b) => b.truncationSensitive).map((b) => b.file),
      '「class 写在标签体第一个 > 之后」的点位集合变了——口径注记与差异结论都要重看',
    ).toEqual(['src/renderer/src/components/ui/SearchSelect.tsx']);
    expect(s.truncationSensitive).toBe(1);
    // 附加三位在两口径下必须同数（该处不影响 tint/press/无过渡）——这也是「只差点位归属、不差点径」的证据
    expect(naive.tint, '截断口径的 tint 应与本清点器一致').toBe(s.handwrittenWithTint);
    expect(naive.noTransition, '截断口径的无 transition 应与本清点器一致').toBe(s.handwrittenNoTransition);
  });
});

/** 故意的错误实现：标签体在第一个 `>` 处截断，用来复现卡上 146/1 的来历（不参与正式断言口径） */
function naiveCounts(): {
  cats: { total: number; unified: number; handwritten: number; noclass: number };
  noclassPoints: string[];
  tint: number;
  noTransition: number;
} {
  const UNIF = /\bbtn-(?:primary|secondary|danger|ghost|ghost-danger)\b/;
  // 判据与清点器**完全同一套**（本函数唯一的变量是「在第一个 > 截断」）：基态底色 + 形状档豁免 +
  // 无过渡只数未走档的点位。不跟着同步的话，下面那两条「两口径同数」的断言就是在比两套口径。
  const TINT = /(?<![:\w-])(?:bg-primary-600|bg-surface-100|bg-danger-600)\b/;
  const SHAPE = /\b(?:link-btn|icon-btn|row-btn|seg-item|seg-item-on|chip)\b/;
  const cats = { total: 0, unified: 0, handwritten: 0, noclass: 0 };
  const noclassPoints: string[] = [];
  let tint = 0;
  let noTransition = 0;
  for (const rel of inv.files) {
    const src = blankComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const m of src.matchAll(/<button[\s\S]*?>/g)) {
      cats.total++;
      const at = /[\s]class\s*=\s*(?:"([^"]*)"|\{([\s\S]*)$)/.exec(m[0]);
      const val = at ? (at[1] ?? at[2]) : null;
      if (val === null) {
        cats.noclass++;
        noclassPoints.push(rel + ':' + src.slice(0, m.index).split('\n').length);
        continue;
      }
      if (UNIF.test(val)) cats.unified++;
      else {
        cats.handwritten++;
        const shaped = SHAPE.test(val);
        if (TINT.test(val) && !shaped) tint++;
        if (!shaped && !/transition/.test(val)) noTransition++;
      }
    }
  }
  return { cats, noclassPoints, tint, noTransition };
}

/**
 * 形状具名档的**存在性**与**识别性**（与全树快照无关，任何时候都该绿）。
 *
 * 为什么单独钉这一组：`.link-btn`/`.icon-btn`/`.row-btn` 是给"形状本就不该套 `ui/Button`"那三类
 * 准备的收口目标。若 CSS 里没有这三档、或名字与量尺的 `SHAPE_RECIPE_CLASS` 对不上，施工的
 * 人就只剩两条坏路：把 141 处硬塞进 `ui/Button`（逼出一次性 props），或挂一个量尺不认识的
 * 名字（棘轮永远降不下来，看起来像没干完）——后者正是 PLAN §七 列过的那个风险。
 */
describe('形状具名档：CSS 里真存在 且 量尺认得这个名字', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/src/index.css'), 'utf8');

  for (const cls of ['link-btn', 'icon-btn', 'row-btn']) {
    it(`.${cls} 在 index.css 里真定义`, () => {
      expect(new RegExp(`\\.${cls}\\s*\\{`).test(css), `index.css 里找不到 .${cls} 定义`).toBe(true);
    });
  }

  it('六个档名逐个认得（拿真实 class 串形态验，不是只验字面）', () => {
    for (const cls of ['link-btn', 'icon-btn', 'row-btn', 'seg-item', 'seg-item-on', 'chip']) {
      const probe = `px-3 ${cls} text-sm`;
      expect(new RegExp(SHAPE_RECIPE_CLASS.source, 'g').test(probe), `认不出 "${probe}"`).toBe(true);
    }
  });

  it(`不误伤无关写法（icon-button / unchipped / btn-primary 都不算"已走统一档"）`, () => {
    // 已知宽松处：`\bchip\b` 会命中 `chip-btn` 这种带连字符后缀的名字。刻意的——
    // 这类名字在 CSS 里不存在，会被 `check:classes` 判红，无需本判据重复把关。
    for (const probe of ['icon-button', 'unchipped', 'btn-primary', 'seg-track', 'link-btns-x2']) {
      expect(new RegExp(SHAPE_RECIPE_CLASS.source, 'g').test(probe), `"${probe}" 不该算命中`).toBe(false);
    }
  });

  it('三档只统一节奏、不统一尺寸（防有人把它们改成定死 h-/w-/px- 造成全站布局位移）', () => {
    for (const cls of ['link-btn', 'icon-btn', 'row-btn']) {
      const body = css.slice(css.indexOf(`.${cls} {`), css.indexOf('}', css.indexOf(`.${cls} {`)));
      // 字重也在禁项里：`.link-btn` 一度挂了 `font-medium`，结果 16 个调用点无声从 400 变 500
      // （三个改动人各自提出、都没硬塞 font-normal 抵消）——节奏档不该管字重，钉进骨架判据。
      for (const forbidden of [
        /transition-all/,
        /\bh-\d/,
        /\bw-\d/,
        /\btext-(xs|sm|base|lg)\b/,
        /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/,
      ]) {
        expect(forbidden.test(body), `.${cls} 里出现了 ${forbidden}：形状档只准管节奏与禁用态`).toBe(false);
      }
    }
  });
});
