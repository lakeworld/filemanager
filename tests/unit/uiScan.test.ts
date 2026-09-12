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
 *   差的是 `components/ui/SearchSelect.tsx:211` 那个 `<button>`：它的 `class` 写在
 *   `ref={(el) => { … }}` 的 `>` **之后**（第 224 行），任何在 `>` 处截断标签的扫描都会把它
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
const { collectUiInventory, blankComments } = (await import(scannerUrl)) as {
  collectUiInventory: (opt?: { root?: string; subdir?: string }) => Inventory;
  blankComments: (src: string) => string;
};

/** 人工实测基准值（2026-09-12，逐处数过；与卡上 146/1 的差异见本文件头注释） */
const BASE = {
  button: { total: 270, unified: 123, handwritten: 147, noclass: 0, tint: 35, press: 0, noTransition: 79 },
  input: { total: 23, checkbox: 12, baseInternal: 3, debt: 7, exempt: 1, other: 0 },
  modal: { total: 21, framed: 6, unframed: 15 },
} as const;

/** 人工点名的 7 处输入框欠账（行号容差 ±3：并行改动会微调行位） */
const DEBT_POINTS: ReadonlyArray<readonly [string, number]> = [
  ['src/renderer/src/pages/Search.tsx', 211],
  ['src/renderer/src/components/PdfPreview.tsx', 210],
  ['src/renderer/src/pages/Clients.tsx', 541],
  ['src/renderer/src/pages/ProductSets.tsx', 505],
  ['src/renderer/src/pages/Settings.tsx', 370],
  ['src/renderer/src/pages/Settings.tsx', 907],
  ['src/renderer/src/pages/Settings.tsx', 1020],
];

/** 底座内部三处：ui/Input + ui/SearchSelect + MoneyInput（点名钉住，防「换个文件名躲门禁」） */
const BASE_INTERNAL_POINTS: ReadonlyArray<readonly [string, number]> = [
  ['src/renderer/src/components/ui/Input.tsx', 53],
  ['src/renderer/src/components/ui/SearchSelect.tsx', 251],
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

  it('按钮附加位：手写档里贴组件档底色 35、带按压 0、完全不含 transition 79', () => {
    const s = inv.summary.buttons;
    expect(s.handwrittenWithTint, 'hasComponentTint 计数漂移（明天门禁的主判据）').toBe(BASE.button.tint);
    expect(s.handwrittenWithPress, '手写按钮里出现 active:scale = 绕过 .btn-* 自带按压自己贴').toBe(BASE.button.press);
    expect(s.handwrittenNoTransition, '手写且完全不含 transition 的按钮数漂移').toBe(BASE.button.noTransition);
    // 附加位只在 handwritten 上取真：unified 的按压与过渡住在 .btn-* 类定义里（index.css 的 @apply）
    for (const b of inv.buttons.filter((x) => x.category !== 'handwritten')) {
      expect(b.hasComponentTint, `hasComponentTint 只该在手写档为真：${b.file}:${b.line}`).toBe(false);
    }
  });

  it('输入框面：真控件 23 = checkbox 12 + 底座内部 3 + 欠账 7 + 豁免 1（other 恒 0）', () => {
    expect(inv.summary.inputs, `输入框计数漂移（现 ${JSON.stringify(inv.summary.inputs)}）`).toEqual(BASE.input);
    expect(
      inv.summary.inputs.checkbox + inv.summary.inputs.baseInternal + inv.summary.inputs.debt + inv.summary.inputs.exempt,
      '四分类必须不重不漏地覆盖全部真控件',
    ).toBe(inv.summary.inputs.total);
  });

  it('注释误命中必须为 0：QuoteFormModal 的 JSDoc 那条 <input> 不算真控件', () => {
    const fromComment = inv.inputs.filter((x) => x.file === 'src/renderer/src/components/QuoteFormModal.tsx');
    expect(fromComment, '该文件的 <input> 只出现在注释里，剥注释后应一个不剩').toEqual([]);
    // 反向守：整站恰为 23 也是「注释已剥掉」的证据（不剥注释会得 24）
    expect(inv.inputs.length, '未剥注释会得到 24——本条同时守住「必须剥注释」').toBe(BASE.input.total);
  });

  it('输入框欠账 7 处的 (file, 行号) 与人工清单逐点一致（±3 容差，双向）', () => {
    const debt = inv.inputs.filter((x) => x.category === 'debt');
    expect(debt.length, 'debt 计数与人工清单不符').toBe(DEBT_POINTS.length);
    for (const [f, line] of DEBT_POINTS) {
      const x = must(findInput(f, line), `人工清单里的 ${f}:${line}`);
      expect(x.category, `${f}:${line} 归类不是 debt`).toBe('debt');
    }
    // 双向守：扫到的每一处 debt 都必须出现在人工清单里（防「多算也绿」）
    const extras = debt.filter((x) => !DEBT_POINTS.some(([f, l]) => x.file === f && Math.abs(x.line - l) <= 3));
    expect(extras, `debt 里出现人工清单之外的点位：${extras.map((x) => x.file + ':' + x.line).join(', ')}`).toEqual([]);
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

  it('Modal 面：业务调用点 21 = framed 6 + 未 framed 15；底座内部那处不算', () => {
    expect(inv.summary.modals, `Modal 计数漂移（现 ${JSON.stringify(inv.summary.modals)}）`).toEqual(BASE.modal);
    expect(
      inv.modals.filter((m) => m.file === 'src/renderer/src/components/ui/Modal.tsx'),
      'ui/Modal.tsx 内部那处 <ModalInner 不是业务调用点',
    ).toEqual([]);
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
        (x) => x.file === 'src/renderer/src/components/ui/SearchSelect.tsx' && Math.abs(x.line - 211) <= 5,
      ),
      'ui/SearchSelect.tsx 里 ~211 行那个触发器 <button>',
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
  it('复现差异来源：朴素 `<button[\\s\\S]*?>` 截断扫描正好得 123 / 146 / 1', () => {
    const naive = naiveCounts();
    expect(naive.cats, `截断式扫描的口径（用来解释卡上 146/1 的来历）：${JSON.stringify(naive.cats)}`).toEqual({
      total: 270,
      unified: 123,
      handwritten: 146,
      noclass: 1,
    });
    // 同上：点位集合按 file 比对（行号 ±5 由下面 truncationSensitive 那条兜），防"为守行号改注释"
    expect(
      naive.noclassPoints.map((p) => p.split(':')[0]),
      '被截断扫描误判成「无 class」的点位，全站有且仅有一处且就在 SearchSelect 里',
    ).toEqual(['src/renderer/src/components/ui/SearchSelect.tsx']);
    // 附加三位在两口径下必然同数（该处不影响 tint/press/notrans）——这也是「只差点位归属、不差点径」的证据
    // 清点器自己标出的「截断敏感」位点 = 差异的那一处（清点表 §六 口径注记的数据来源）
    expect(
      inv.buttons.filter((b) => b.truncationSensitive).map((b) => b.file),
      '「class 写在标签体第一个 > 之后」的点位集合变了——口径注记与差异结论都要重看',
    ).toEqual(['src/renderer/src/components/ui/SearchSelect.tsx']);
    expect(inv.summary.buttons.truncationSensitive).toBe(1);
    expect(naive.tint, '截断口径的 tint 应与本清点器一致').toBe(inv.summary.buttons.handwrittenWithTint);
    expect(naive.noTransition, '截断口径的无 transition 应与本清点器一致').toBe(inv.summary.buttons.handwrittenNoTransition);
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
  const TINT = /\b(?:bg-primary-600|bg-surface-100|bg-danger-600)\b/;
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
        if (TINT.test(val)) tint++;
        if (!/transition/.test(val)) noTransition++;
      }
    }
  }
  return { cats, noclassPoints, tint, noTransition };
}
