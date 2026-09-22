/**
 * UI 控件清点器（v2.5.8 D13 样式统一收口）
 *
 * 为什么不是 grep：本仓的铁教训是「口径数字绝不能是一条 grep + wc -l」。
 * 实测证据——全站手搓材质文本框真值 7 处，但只 grep `type="text"` 也「恰好」得 7，
 * 因为两个反向偏差互相抵消（漏掉 3 处省写 `type` 的、混进 2 个底座内部的）。
 * 所以本脚本**解析 JSX 标签体**（`<input` 到配对的 `>`，跨行、引号与花括号感知），
 * 并且**先原位剥离注释**（注释里出现的 `<input>` 不是真控件，
 * 已知 `src/renderer/src/components/QuoteFormModal.tsx` 的 JSDoc 里就有一处）。
 *
 * 用法：
 *   node scripts/scan-ui-inventory.mjs            # 打印人类可读汇总 + markdown 到 stdout
 *   node scripts/scan-ui-inventory.mjs --write    # 另外把 markdown 落盘到内部文档目录（不进公开仓）
 *
 * 作为库使用（主线程的门禁 tests/unit/uiScan.test.ts 走这条路）：
 *   import { collectUiInventory } from '../../scripts/scan-ui-inventory.mjs'
 * 纯函数、无副作用、根目录可注入；只有 main() 才读 process.argv / 写文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本脚本住在 <root>/scripts/） */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

/** 清点表落盘位置 */
export const REPORT_REL = 'docs/INTERNAL/清点-2026-09-12-样式统一收口.md';

/** 扫描根：渲染层 */
export const SCAN_SUBDIR = 'src/renderer';

/**
 * `.btn-*` 五档（唯一真相 = index.css 的 @layer components）。
 * 边界用 \b 而不是空格切词：class 常写成 `hover:btn-ghost`、模板串拼接 `{x ? "btn-primary" : ""}`，
 * 变体前缀与引号/花括号都要能命中，而 `btn-primary-foo` 这种不存在的档不该算。
 */
export const UNIFIED_BTN_CLASS = /\bbtn-(?:primary|secondary|danger|ghost|ghost-danger)\b/g;

/**
 * 组件档底色：手写但在贴这三档 = 绕开 .btn-* 自己粘组件色，明天门禁的主判据。
 *
 * **只看基态底色**：前置 `(?<![:\w-])` 把 `hover:` / `focus:` / `active:` 等变体前缀挡在外面
 * （`\b` 在 `:` 与 `b` 之间同样成立，所以旧写法会把 `hover:bg-surface-100` 算成违规）。
 * 为什么必须排除：形状具名档（下面的 `SHAPE_RECIPE_CLASS`）按设计**只管节奏、颜色留给调用点**，
 * 而"平时透明、悬停才上色"正是 `.row-btn` / `.link-btn` 唯一合法的贴色方式——挂在形状档上的
 * `hover:bg-*` 不是绕开统一档，而是在用统一档。两条放宽必须同时生效，缺一条就有约 16 处
 * 永远洗不干净（D14 实测：ContextMenu:110、Settings:963、DatePicker 5 处、Sidebar 5 处等）。
 * 漏判会不会变松？不会：这类点位仍被 `isDebt`（未走任何统一档）与逐文件手写基线两处抓住。
 * 边界用 \b 而不是空格切词：`btn-primary-foo` 这种不存在的档不该算。
 */
export const COMPONENT_TINT_CLASS = /(?<![:\w-])(?:bg-primary-600|bg-surface-100|bg-danger-600)\b/g;

/**
 * 形状具名档：三种**本就不该套 `ui/Button`** 的形状（文字链接式 / 纯图标 / 整行可点）与两个
 * D6 已有的档（分段项 / 药丸）。挂上它们算「已走统一清单」（`AGENTS.md` §一.8 的两条合法路径之一），
 * 因此**不计入欠账**。定义见 `index.css` 的 `.link-btn`/`.icon-btn`/`.row-btn` 注释。
 * 为什么必须让量尺认识这些名字：否则把 142 处收进具名类之后，`handwritten` 计数纹丝不动，
 * 棘轮看起来"永远做不完"——量尺不认改好的样子，改的人就只能硬塞组件（PLAN §七 列过的风险）。
 */
export const SHAPE_RECIPE_CLASS = /\b(?:link-btn|icon-btn|row-btn|seg-item|seg-item-on|chip)\b/g;

/**
 * 「手搓材质」判据 = 同一条 class 里既重述了**描边色**又重述了**圆角**（= `.input` 骨架被手抄一份）。
 *
 * 两处放宽（卡上原话是「`border-surface-` 与 `rounded-`」，按字面写会漏，实测口径如下）：
 *  - 描边色放宽到调色板全家：`pages/Settings.tsx:370` 的内联重命名框写的是 `border-primary-300`，
 *    同样是手写材质，按字面只认 surface 会把它漏成「其他」。
 *  - 圆角认裸 `rounded`：小筛选/内联框普遍写 `px-2 py-1 border border-surface-200 rounded text-sm`
 *    （裸 rounded，没有 `-` 后缀），按字面 `rounded-` 会漏掉 5 处。
 */
const MATERIAL_TOKENS = [/\bborder-(?:surface|primary|danger|warning|success)-\d+(?:\/\d+)?\b/, /\brounded(?:-[a-z0-9]+)?\b/];

/** 唯一显式豁免：顶栏全局搜索框（`pl-9` 给绝对定位图标让位、底色嵌在顶栏里，换 ui/Input 属改版式） */
const EXEMPT_HEADER = { file: 'src/renderer/src/components/Header.tsx', id: 'global-search-input' };

/** 底座目录 + 金额底座：它们身上的 <input>/<button> 属「实现内部」，不算页面欠账 */
const BASE_INTERNAL_DIRS = ['src/renderer/src/components/ui/'];
const BASE_INTERNAL_FILES = ['src/renderer/src/components/MoneyInput.tsx'];
/** 同一判据供两面共用（按钮面见 classifyButton 的 inBase；口径分两处写必然漂移） */
const isBaseInternal = (rel) => BASE_INTERNAL_DIRS.some((d) => rel.startsWith(d)) || BASE_INTERNAL_FILES.includes(rel);

/** Modal 底座自身：内部那处 <ModalInner 不算业务调用点 */
const MODAL_BASE_FILE = 'src/renderer/src/components/ui/Modal.tsx';

/* ------------------------------------------------------------------ *
 * 词法小工具：原位去注释 + 字符串/花括号配平 + 标签与属性解析
 * ------------------------------------------------------------------ */

/**
 * 把注释原位替换成等长空白：保留换行与字符偏移，行号口径仍是原文件。
 * 字符串/模板字面量内部不判注释起始（`https://…` 不会被吃掉）。
 */
export function blankComments(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const j = endOfStringLiteral(src, i);
      out.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out.push(' '.repeat(j - i));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      out.push(src.slice(i, j).replace(/[^\n]/g, ' '));
      i = j;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** 从引号起始下标扫到该字符串字面量结束（含引号）；模板串里的 ${ … } 递归配平 */
function endOfStringLiteral(s, i) {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (quote === '`' && c === '$' && s[j + 1] === '{') {
      j = endOfBraces(s, j + 1);
      continue;
    }
    j++;
  }
  return j;
}

/** 从 `{` 扫到配对 `}` 之后（字符串感知）；未闭合则返回串尾 */
function endOfBraces(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') {
      j = endOfStringLiteral(s, j);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

/**
 * 从 `<name` 起点扫到该 JSX 标签结束下标（不含）。
 * 必须引号 + 花括号感知：`[^>]*?>` 会停在 `onKeyDown={(e) => ...}` 的 `>` 上把标签截断
 * （本仓 codemod 首跑实测踩过，同 uiInventory.test.ts 的 scanTag 注释）。
 */
export function scanTag(s, i, name) {
  let j = i + name.length + 1; // 跳过 "<name"
  let depth = 0;
  let q = null;
  while (j < s.length) {
    const c = s[j];
    if (q) {
      if (c === '\\') j += 2;
      else if (c === q) q = null;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '/' && s[j + 1] === '>') return j + 2;
    else if (depth === 0 && c === '>') return j + 1;
    j++;
  }
  return -1;
}

/**
 * 把标签体拆成属性列表（只在花括号外切分，所以跨行与模板串拼接都拿得全）。
 * @returns {{name:string, value:string|null, form:'bare'|'string'|'expr'|'other', valueStart:number}[]}
 *   下标为**去注释后整文件**的偏移，可直接换算行号。
 */
export function parseAttributes(s, tagStart, tagEnd) {
  const attrs = [];
  let i = tagStart + 1;
  while (i < tagEnd && /[\w$.]/.test(s[i])) i++; // 跳过标签名
  while (i < tagEnd) {
    const c = s[i];
    if (/\s/.test(c) || (c === '/' && i + 1 < tagEnd)) {
      i++;
      continue;
    }
    if (c === '>') break;
    const nameStart = i;
    while (i < tagEnd && !/[\s=/{]/.test(s[i])) i++;
    const name = s.slice(nameStart, i).trim();
    if (!name) {
      i++;
      continue;
    }
    // 属性名起始偏移一并记下：口径注记要用它判断「class 是否写在标签体内第一个 > 之后」
    const attrStart = nameStart;
    while (i < tagEnd && /\s/.test(s[i])) i++;
    if (s[i] !== '=') {
      attrs.push({ name, value: null, form: 'bare', valueStart: i, start: attrStart });
      continue;
    }
    i++; // 吃掉 '='
    while (i < tagEnd && /\s/.test(s[i])) i++;
    if (s[i] === '{') {
      const close = endOfBraces(s, i);
      const raw = s.slice(i + 1, Math.max(i + 1, close - 1));
      attrs.push({ name, value: raw, form: /^\s*(['"]).*\1\s*$/s.test(raw) ? 'string' : 'expr', valueStart: i + 1, start: attrStart });
      i = close;
      continue;
    }
    if (s[i] === '"' || s[i] === "'") {
      const close = endOfStringLiteral(s, i);
      attrs.push({
        name,
        value: s.slice(i + 1, Math.max(i + 1, close - 1)),
        form: 'string',
        valueStart: i + 1,
        start: attrStart,
      });
      i = close;
      continue;
    }
    let j = i; // 裸词值（JSX 里非法，防御性收下，别让解析塌掉）
    while (j < tagEnd && !/[\s/{>]/.test(s[j])) j++;
    attrs.push({ name, value: s.slice(i, j), form: 'other', valueStart: i, start: attrStart });
    i = j;
  }
  return attrs;
}

/** 取某个属性的原文（用于换算偏移） */
function attrOf(attrs, name) {
  for (const a of attrs) if (a.name === name) return a;
  return null;
}

/**
 * 「截断敏感」= 该标签的 class 写在标签体内**第一个 `>` 之后**。
 * 任何在 `>` 处收口的扫描（`<button[^>]*?>`、按行匹配、`indexOf('>')`）都会把它读成「没有 class」。
 * 这不是学术问题：卡上按钮口径 handwritten 146 / noclass 1 与本表 147 / 0 差的那 1，
 * 全部来源就是这一处（class 在 `ref={(el) => …}` 的箭头 `>` 之后），见清点表 §六。
 */
function losesClassIfTruncated(s, tagStart, tagEnd, attrs) {
  const a = attrOf(attrs, 'class') ?? attrOf(attrs, 'className');
  if (!a) return false;
  const firstGt = s.indexOf('>', tagStart + 1);
  return firstGt >= 0 && firstGt < tagEnd - 1 && a.start > firstGt;
}

/** 静态 class 文本：字符串型取内容，表达式型取整段源码（btn-* 写在哪一种拼法里都算命中） */
function classTextOf(attrs) {
  const a = attrOf(attrs, 'class') ?? attrOf(attrs, 'className');
  if (!a) return null;
  return (a.value ?? '').trim(); // bare 写法（只有 class 没有值）视作空串
}

/** 由偏移换算 1 起始行号（掩码串与原文件等长等行，所以行号可信） */
function lineOf(maskedSrc, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (maskedSrc[i] === '\n') line++;
  return line;
}

function matchesOf(re, text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(re.source, 'g'))) out.push(m[0]);
  return out;
}

/* ------------------------------------------------------------------ *
 * 主清点函数
 * ------------------------------------------------------------------ */

function walkTsx(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out; // 根目录可注入 = 也允许指向别处；扫不到就是空集，不抛
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTsx(p));
    else if (/\.tsx$/.test(ent.name)) out.push(p);
  }
  return out.sort();
}

/**
 * 清点一个根目录下的渲染层全部 .tsx（递归扫描根 = root/src/renderer）。
 * @param {{root?:string, subdir?:string}} [opt] 根目录可注入，便于 fixture 测试
 * @returns {{root:string, files:string[], buttons:object[], inputs:object[], modals:object[], summary:object}}
 */
export function collectUiInventory(opt = {}) {
  const root = path.resolve(opt.root ?? DEFAULT_ROOT);
  const scanRoot = path.join(root, opt.subdir ?? SCAN_SUBDIR);
  const files = walkTsx(scanRoot).map((f) => path.relative(root, f).split(path.sep).join('/'));

  const buttons = [];
  const inputs = [];
  const modals = [];

  for (const rel of files) {
    const src = blankComments(fs.readFileSync(path.join(root, rel), 'utf8'));
    const hitsOf = (tagName) => {
      const out = [];
      for (const m of src.matchAll(new RegExp('<' + tagName + '(?![\\w$-])', 'g'))) {
        const start = m.index ?? 0;
        const end = scanTag(src, start, tagName);
        const tagEnd = end < 0 ? src.length : end;
        const attrs = parseAttributes(src, start, tagEnd);
        out.push({ start, attrs, truncationSensitive: losesClassIfTruncated(src, start, tagEnd, attrs) });
      }
      return out;
    };
    for (const h of hitsOf('button')) buttons.push(classifyButton(rel, lineOf(src, h.start), h));
    for (const h of hitsOf('input')) inputs.push(classifyInput(rel, lineOf(src, h.start), h));
    for (const h of hitsOf('Modal')) {
      if (rel === MODAL_BASE_FILE) continue; // 底座内部不算业务调用点
      modals.push(classifyModal(rel, lineOf(src, h.start), h));
    }
  }

  return { root, files, buttons, inputs, modals, summary: summarize(buttons, inputs, modals) };
}

/* ---------------------------- 归类规则 ---------------------------- */

function classifyButton(rel, line, h) {
  const classText = classTextOf(h.attrs);
  const variants = classText === null ? [] : matchesOf(UNIFIED_BTN_CLASS, classText);
  const tints = classText === null ? [] : matchesOf(COMPONENT_TINT_CLASS, classText);
  const shapes = classText === null ? [] : matchesOf(SHAPE_RECIPE_CLASS, classText);
  const category = classText === null ? 'noclass' : variants.length > 0 ? 'unified' : 'handwritten';
  return {
    file: rel,
    line,
    tag: 'button',
    classText,
    variants,
    category,
    /** 挂上的形状具名档（`.link-btn`/`.icon-btn`/`.row-btn`/`.seg-item`/`.chip`） */
    shapeRecipes: shapes,
    /** 住在底座目录里（`components/ui/` + `MoneyInput.tsx`）= 实现内部，与输入框面同一判据、同一目录表 */
    inBase: isBaseInternal(rel),
    /** **真欠账** = 页面/业务组件侧手写且没走任何统一档。棘轮基线数的是这个数，不是 `handwritten`——
     *  收进形状具名类的点位从此不再计入，量尺才认得出"改好了"。
     *  底座内部一并排除：`ui/Button` 自己就得写材质（`:33` 那处 `${VARIANT_MAP[...]}` 是映射表本体），
     *  把它算成欠账会让"欠账 0"这个出口永远达不成——与输入框面 `baseInternal` 同一口径。
     *  ⚠ 放宽的同时门禁那边必须逐文件点名（`BTN_BASE_INTERNAL`），否则整个 `components/ui/` 成了空白支票。 */
    isDebt: category === 'handwritten' && shapes.length === 0 && !isBaseInternal(rel),
    /** 手写但在贴组件档底色 —— 明天门禁的主判据。
     *  挂上形状具名档即豁免：那三档按设计不管颜色，颜色只能在调用点给（见 COMPONENT_TINT_CLASS 注释）。
     *  底座内部同样不计（与 isDebt 一条口径）：`ui/*` 里那几处底色属实现内部，改由 `BTN_BASE_INTERNAL` 逐文件钉死。 */
    hasComponentTint: category === 'handwritten' && tints.length > 0 && shapes.length === 0 && !isBaseInternal(rel),
    /** 已走任一统一档（五档 `btn-*` 或形状具名档）= 节奏由骨架提供，调用点不再重复要求写 transition */
    usesUnifiedRecipe: variants.length > 0 || shapes.length > 0,
    tintTokens: tints,
    hasPress: classText !== null && /active:scale/.test(classText),
    hasTransition: classText !== null && /transition/.test(classText),
    /** class 写在标签体内第一个 `>` 之后 = 截断式扫描会误判成 noclass（口径注记用） */
    truncationSensitive: h.truncationSensitive === true,
  };
}

function classifyInput(rel, line, h) {
  const classText = classTextOf(h.attrs);
  const typeAttr = attrOf(h.attrs, 'type');
  const idAttr = attrOf(h.attrs, 'id');
  const type = typeAttr ? (typeAttr.value ?? '').trim() : null;
  const bareType = (type ?? '').replace(/^['"]|['"]$/g, '');
  const material = classText !== null && MATERIAL_TOKENS.every((re) => re.test(classText));
  const isBase = BASE_INTERNAL_DIRS.some((d) => rel.startsWith(d)) || BASE_INTERNAL_FILES.includes(rel);
  const isExempt = rel === EXEMPT_HEADER.file && (idAttr ? (idAttr.value ?? '').trim() : '') === EXEMPT_HEADER.id;

  let category;
  if (bareType === 'checkbox') category = 'checkbox';
  else if (isBase) category = 'baseInternal';
  else if (isExempt) category = 'exempt';
  else if (material) category = 'debt';
  else category = 'other';

  return {
    file: rel,
    line,
    tag: 'input',
    type: bareType || null,
    typeId: idAttr ? (idAttr.value ?? '').trim() : null,
    classText,
    material,
    category,
  };
}

function classifyModal(rel, line, h) {
  const framed = attrOf(h.attrs, 'framed');
  return {
    file: rel,
    line,
    tag: 'Modal',
    framed: framed !== null,
    /** framed 独占一行（bare）或写成 framed={…} 都算开；表达式原文一并记下 */
    framedValue: framed ? (framed.value ?? 'true').trim() : null,
  };
}

function countBy(arr, keyFn) {
  const acc = {};
  for (const x of arr) {
    const k = keyFn(x);
    acc[k] = (acc[k] ?? 0) + 1;
  }
  return acc;
}

function summarize(buttons, inputs, modals) {
  const bc = countBy(buttons, (b) => b.category);
  const ic = countBy(inputs, (x) => x.category);
  return {
    buttons: {
      total: buttons.length,
      unified: bc.unified ?? 0,
      handwritten: bc.handwritten ?? 0,
      noclass: bc.noclass ?? 0,
      other: bc.other ?? 0,
      handwrittenWithTint: buttons.filter((b) => b.hasComponentTint).length,
      /** 真欠账（页面/业务组件侧手写且未走任何统一档）——棘轮基线与 D14 出口指标都看这一格 */
      debt: buttons.filter((b) => b.isDebt).length,
      /** 底座内部（`components/ui/` + `MoneyInput.tsx`）的手写点位：不计欠账，但门禁要逐文件点名 */
      baseInternal: buttons.filter((b) => b.inBase && b.category === 'handwritten' && b.shapeRecipes.length === 0).length,
      truncationSensitive: buttons.filter((b) => b.truncationSensitive).length,
      handwrittenWithPress: buttons.filter((b) => b.category === 'handwritten' && b.hasPress).length,
      /** 「完全不含过渡」只统计**未走任何统一档**的点位：挂上 `btn-*`/形状档后，过渡住在类定义里，
       *  读 class 字面的判据会把它算成"没过渡"，于是收口越努力、这个数越红（实测 79→96 的反向告警）。 */
      handwrittenNoTransition: buttons.filter((b) => b.category === 'handwritten' && !b.usesUnifiedRecipe && !b.hasTransition).length,
    },
    inputs: {
      total: inputs.length,
      checkbox: ic.checkbox ?? 0,
      baseInternal: ic.baseInternal ?? 0,
      debt: ic.debt ?? 0,
      exempt: ic.exempt ?? 0,
      other: ic.other ?? 0,
    },
    modals: {
      total: modals.length,
      framed: modals.filter((m) => m.framed).length,
      unframed: modals.filter((m) => !m.framed).length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 报告渲染 + CLI
 * ------------------------------------------------------------------ */

/** markdown 行内代码（用拼接而非模板串：报告正文里大量反引号） */
const code = (s) => '`' + String(s) + '`';
const short = (f) => f.replace('src/renderer/src/', '');
const cell = (s, n) => (String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|') || '—').slice(0, n);

export function renderMarkdown(inv) {
  const s = inv.summary;
  const L = [];
  L.push('# 清点表 · UI 控件统一收口（按钮 / 输入框 / 弹窗）');
  L.push('');
  L.push(
    '@回答: 全站 ' +
      code('<button>') + ' ' + s.buttons.total + ' / ' + code('<input>') + ' ' + s.inputs.total + ' / ' + code('<Modal>') + ' ' + s.modals.total +
      ' 三面清点的起点数字与逐处清单（手写 ' + s.buttons.handwritten + ' · 贴档底色 ' + s.buttons.handwrittenWithTint + ' · 输入框欠账 ' + s.inputs.debt + ' · framed ' + s.modals.framed + '），D13 棘轮基线的依据。',
  );
  L.push('@类型: 事实（清点表）');
  L.push('@权威: 本表权威 = ' + code('scripts/scan-ui-inventory.mjs') + ' 现算产物，重跑即刷新（' + code('node scripts/scan-ui-inventory.mjs --write') + '）');
  L.push('@窗口: v2.5.8 / D13');
  L.push('');
  L.push('口径说明：解析 JSX 标签体（跨行、引号与花括号感知），**先原位剥离注释**——注释里的 ' + code('<input>') + ' 不算真控件');
  L.push('（' + code('components/QuoteFormModal.tsx') + ' 的 JSDoc 里有一处，本表已排除）。自校验 = ' + code('tests/unit/uiScan.test.ts'));
  L.push('（人工实测基准值与本脚本现算双向对齐）。');
  L.push('');
  L.push('## 一、三面汇总');
  L.push('');
  L.push('| 面 | 计数 |');
  L.push('|---|---:|');
  L.push('| 按钮总数 | ' + s.buttons.total + ' |');
  L.push('| ├ 走 ' + code('.btn-*') + ' 五档（unified） | ' + s.buttons.unified + ' |');
  L.push('| ├ 手写（handwritten） | ' + s.buttons.handwritten + ' |');
  L.push('| └ 无 class 属性（noclass） | ' + s.buttons.noclass + ' |');
  L.push('| 手写中贴组件档底色（' + code('hasComponentTint') + '） | **' + s.buttons.handwrittenWithTint + '** |');
  L.push('| 手写中带 ' + code('active:scale') + '（按压） | ' + s.buttons.handwrittenWithPress + ' |');
  L.push('| 手写中完全不含 ' + code('transition') + '（且未走任何统一档） | ' + s.buttons.handwrittenNoTransition + ' |');
  L.push('| ├ 其中住在底座目录（' + code('components/ui/') + ' + ' + code('MoneyInput.tsx') + '，不计欠账、门禁逐文件点名） | ' + s.buttons.baseInternal + ' |');
  L.push('| 输入框真控件 | ' + s.inputs.total + ' |');
  L.push('| ├ ' + code('checkbox') + ' | ' + s.inputs.checkbox + ' |');
  L.push('| ├ 底座内部（' + code('components/ui/') + ' + ' + code('MoneyInput.tsx') + '） | ' + s.inputs.baseInternal + ' |');
  L.push('| ├ 欠账（页面/业务组件侧手搓材质文本框） | ' + s.inputs.debt + ' |');
  L.push('| └ 显式豁免（Header 全局搜索框） | ' + s.inputs.exempt + ' |');
  L.push('| Modal 业务调用点 | ' + s.modals.total + ' |');
  L.push('| ├ 带 ' + code('framed') + ' | ' + s.modals.framed + ' |');
  L.push('| └ 不带 ' + code('framed') + ' | ' + s.modals.unframed + ' |');
  if (s.buttons.other || s.inputs.other) {
    L.push('');
    L.push('⚠ 口径外未归类：按钮 ' + s.buttons.other + ' / 输入框 ' + s.inputs.other + '——先补判据再收口，别当 0 处理。');
  }
  L.push('');

  L.push('## 二、真欠账按文件计数（降序，未走任何统一档 · 已排除底座内部；逐档下调棘轮基线用）');
  L.push('');
  const byFile = {};
  for (const b of inv.buttons) {
    if (b.category !== 'handwritten' || b.inBase) continue;
    const e = (byFile[b.file] ??= { hand: 0, tint: 0, press: 0, notrans: 0 });
    e.hand++;
    if (b.hasComponentTint) e.tint++;
    if (b.hasPress) e.press++;
    if (!b.usesUnifiedRecipe && !b.hasTransition) e.notrans++;
  }
  const rows = Object.entries(byFile).sort((a, b) => b[1].hand - a[1].hand || a[0].localeCompare(b[0]));
  L.push('| 手写数 | 贴档底色（基态·未走档） | 带按压 | 无过渡（未走档） | 文件 |');
  L.push('|---:|---:|---:|---:|---|');
  for (const [f, e] of rows) L.push('| ' + e.hand + ' | ' + e.tint + ' | ' + e.press + ' | ' + e.notrans + ' | ' + code(short(f)) + ' |');
  const sum = rows.reduce((n, [, e]) => n + e.hand, 0);
  L.push(
    '| **' + sum + '** | ' + rows.reduce((n, [, e]) => n + e.tint, 0) + ' | ' + rows.reduce((n, [, e]) => n + e.press, 0) +
      ' | ' + rows.reduce((n, [, e]) => n + e.notrans, 0) + ' | 合计（' + rows.length + ' 个文件） |',
  );
  L.push('');

  L.push('## 三、手写按钮里贴组件档**基态**底色的 ' + s.buttons.handwrittenWithTint + ' 处（未走形状档，明天门禁主判据逐处清单）');
  L.push('');
  L.push('| # | 位置 | 命中 token | class 片段 |');
  L.push('|---:|---|---|---|');
  let n = 0;
  for (const b of inv.buttons) {
    if (!b.hasComponentTint) continue;
    n++;
    L.push('| ' + n + ' | ' + code(short(b.file) + ':' + b.line) + ' | ' + b.tintTokens.map(code).join(' ') + ' | ' + cell(b.classText, 150) + ' |');
  }
  L.push('');

  L.push('## 四、输入框欠账 ' + s.inputs.debt + ' 处逐处清单（页面/业务组件侧手搓材质文本框）');
  L.push('');
  L.push('| # | 位置 | ' + code('type') + ' 属性 | class |');
  L.push('|---:|---|---|---|');
  n = 0;
  for (const x of inv.inputs) {
    if (x.category !== 'debt') continue;
    n++;
    L.push('| ' + n + ' | ' + code(short(x.file) + ':' + x.line) + ' | ' + (x.type ? code(x.type) : '（省写）') + ' | ' + cell(x.classText, 150) + ' |');
  }
  L.push('');
  const exempt = inv.inputs.filter((x) => x.category === 'exempt');
  if (exempt.length) {
    L.push('显式豁免（唯一一处，理由见 ' + code('tests/unit/uiInventory.test.ts') + ' 的 ' + code('INPUT_GEOMETRY_EXEMPT') + '）：');
    for (const x of exempt) L.push('- ' + code(short(x.file) + ':' + x.line) + ' ' + code('id=' + x.typeId));
    L.push('');
  }

  L.push('## 五、Modal 业务调用点 ' + s.modals.total + ' 个的 framed 状态');
  L.push('');
  L.push('| # | 调用点 | ' + code('framed') + ' | 写法 |');
  L.push('|---:|---|:--:|---|');
  inv.modals.forEach((m, i) => {
    L.push('| ' + (i + 1) + ' | ' + code(short(m.file) + ':' + m.line) + ' | ' + (m.framed ? '是' : '否') + ' | ' + (m.framed ? cell(m.framedValue, 40) : '—') + ' |');
  });
  L.push('');
  L.push('> 底座 ' + code('components/ui/Modal.tsx') + ' 内部那处 ' + code('<ModalInner') + ' 不算业务调用点，已排除。');
  L.push('');

  const sens = inv.buttons.filter((b) => b.truncationSensitive);
  L.push('## 六、口径注记：与人工基准值差 1 的唯一来源');
  L.push('');
  L.push('本卡立项时人工数出的按钮口径是 ' + code('unified 123 / handwritten 146 / noclass 1') + '；本表按标签体解析得 ' + code('unified ' + s.buttons.unified + ' / handwritten ' + s.buttons.handwritten + ' / noclass ' + s.buttons.noclass) + '。');
  L.push('差的 1 处**不是**漏扫，而是「class 写在标签体内第一个 ' + code('>') + ' 之后」——按行匹配或在 ' + code('>') + ' 处截断的扫描会把这类标签读成「没有 class 属性」。');
  L.push('这类点位全站共 **' + sens.length + '** 处：');
  L.push('');
  L.push('| 位置 | class 头部 | 该处 class 里是否含 ' + code('transition') + ' |');
  L.push('|---|---|:--:|');
  for (const b of sens) L.push('| ' + code(short(b.file) + ':' + b.line) + ' | ' + cell((b.classText ?? '').slice(0, 60), 60) + ' | ' + (b.hasTransition ? '是' : '否') + ' |');
  L.push('');
  L.push(
    '这些点位若被误判成 noclass，' + code('unified') + ' / ' + code('hasComponentTint') + ' / ' + code('active:scale') +
      ' / ' + code('无 transition') + ' 四个数都不受影响（本例正是如此：123 / 35 / 0 / 79 两口径全等），' +
      '只有 ' + code('handwritten') + ' 与 ' + code('noclass') + ' 的归属差 1 ⇒ 差异极易被当成四舍五入式笔滑漏过去。' +
      '归属以本表（标签体解析）为准，改动需主线程拍板；取证用例见 ' + code('tests/unit/uiScan.test.ts') + ' 的「复现差异来源」。',
  );
  L.push('');
  return L.join('\n');
}

export function renderSummary(inv) {
  const s = inv.summary;
  return [
    'UI 控件清点（' + inv.files.length + ' 个 .tsx）',
    '  按钮   总 ' + s.buttons.total + ' · unified ' + s.buttons.unified + ' · handwritten ' + s.buttons.handwritten + ' · noclass ' + s.buttons.noclass +
      ' · 手写贴档底色 ' + s.buttons.handwrittenWithTint + ' · 真欠账 ' + s.buttons.debt + ' · 底座内 ' + s.buttons.baseInternal + ' · 手写带按压 ' + s.buttons.handwrittenWithPress + ' · 手写无过渡 ' + s.buttons.handwrittenNoTransition,
    '  输入框 真控件 ' + s.inputs.total + ' · checkbox ' + s.inputs.checkbox + ' · baseInternal ' + s.inputs.baseInternal + ' · debt ' + s.inputs.debt + ' · exempt ' + s.inputs.exempt +
      (s.inputs.other ? ' · ⚠ other ' + s.inputs.other : ''),
    '  Modal  业务调用点 ' + s.modals.total + ' · framed ' + s.modals.framed + ' · 未 framed ' + s.modals.unframed,
  ].join('\n');
}

function main() {
  const inv = collectUiInventory();
  console.log(renderSummary(inv));
  if (process.argv.includes('--write')) {
    const target = path.join(inv.root, REPORT_REL);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, renderMarkdown(inv));
    console.log('已写入 ' + path.relative(process.cwd(), target));
  } else {
    console.log('');
    console.log(renderMarkdown(inv));
    console.log('');
    console.log('（未落盘——加 --write 才写 ' + REPORT_REL + '）');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
