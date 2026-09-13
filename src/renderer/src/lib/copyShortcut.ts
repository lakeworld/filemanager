/**
 * 「Ctrl+C 该不该被文件复制接管」的判定单点（v2.5.8 D19 / 体验批 B2）。
 *
 * 为什么把这一步抽成纯函数：这段判定从 v2.5.7（A1 剪贴板劫持根因 1）起就**只有一份**，
 * 且住在一个组件里（`FileBrowserView.tsx:385`）。B2 要把 Ctrl+C 铺到其余六个有选中态的页面
 * （图包库 / 证书库 / 搜索 / 笔记 / 发票 / 报价），如果按「每页抄一遍守卫」的做法,
 * A1 那条修好的语义会在六份拷贝里各漂一次。守卫逻辑搬不进组件（组件不可测），
 * 所以把它压成一个不碰 DOM、不碰 store 的纯谓词，由 `hooks/useCopyShortcut.ts` 喂参数。
 *
 * 三条让位规则按顺序读，**顺序本身是语义**（换序会改行为）：
 * 1. 预览开着 → 让位。底层页面在弹窗下保持挂载、监听仍活，不挡的话「复制正在预览的这张」
 *    会拿到列表里选中的另外几个文件（B2③ 的缺陷原文）。返回 false 后由派发层继续试
 *    预览自己注册的处理器（`FilePreviewModal` 的 `handleCopyFile`）⇒ 交棒而不是吞键。
 *    ⚠ 诚实口径（2026-09-13 变异验证实测）：**当前注册顺序下这条走不到**——预览常驻 `App.tsx:319`、
 *    在应用启动时就注册了 `file.copy`，比任何路由页面都早，而派发按注册序试、第一个消费即止
 *    ⇒ 预览开着时永远是预览侧先赢，页面这条规则被短路。把规则 1 摘掉，e2e 6 条仍全绿，
 *    只有本文件的单测（`tests/unit/copyShortcut.test.ts` 规则 1 那例）会红。
 *    所以它是**二重保险**而不是当前的实际拦截点：守的是「注册顺序变了」（页面比弹窗先挂载、
 *    或将来有别的组件也注册 `file.copy` 且顺序在前）那种情形，别把它当成已被 e2e 证伪的 dead code 删掉。
 * 2. 正文有非折叠选区 **且** 设置「剪贴板让位正文选区」开着（默认开）→ 让位浏览器复制文本。
 *    这一条就是 v2.5.7 A1 的原修复，口径一字未动；设置关掉则回到「文件选中优先」的老口径。
 * 3. 本页没选中任何文件 → 让位。不给 Ctrl+C 抢一个本来无事的按键（与收编前 `return false` 等价）。
 *
 * 输入框 / 文本域 / contenteditable 的豁免**不在这里判**：那是派发层 `shortcuts.ts`
 * 里 `guard: "text"` + `isTextTarget` 的职责，页面再判一次就是双源漂移。
 */
export interface CopyGateInput {
  /** 预览弹窗是否打开（`stores/preview.showPreview()`） */
  previewOpen: boolean;
  /** 设置项「剪贴板让位正文选区」是否为开（由调用方读 `stores/appSettings` 的守卫开关传进来） */
  guardOn: boolean;
  /** 正文当前是否有非折叠选区（有选中的文字） */
  textSelected: boolean;
  /** 本页当前选中的文件数 */
  selectedCount: number;
}

/**
 * 让位规则 2 的**单独可复用形式**：正文有非折叠选区且开关为开 ⇒ 这个 Ctrl+C 归浏览器复制文本。
 * 抽出来是因为预览弹窗自己也要用这一条（规则 1「预览让位」与规则 3「零选中放行」对它都不成立——
 * 它就是预览本身），而这条 A1 判据一旦抄成两份，下次改守卫就会只改一处。
 */
export function yieldsToTextSelection(guardOn: boolean, textSelected: boolean): boolean {
  return guardOn && textSelected;
}

/** 该 Ctrl+C 是否由「复制选中文件」接管；false = 交回浏览器 / 交给预览 */
export function shouldTakeFileCopy(i: CopyGateInput): boolean {
  if (i.previewOpen) return false;
  if (yieldsToTextSelection(i.guardOn, i.textSelected)) return false;
  return i.selectedCount > 0;
}

/**
 * 台账类页面「选中记录 → 可复制的文件路径」的单点（B2②：发票 / 入库 / 报价的批量条补复制）。
 *
 * 为什么不是直接 `ids.map(n => rec.file_path)`：台账一行**可以没有归档文件**
 * （`file_path` 空，界面上那行显示「文件缺失」徽标），把空串塞进路径数组会让主进程
 * PowerShell/xclip 拿到一个空条目 ⇒ 整批复制失败，而用户看到的是「一个没归档的行」。
 * 同一文件被多行引用时再去重（复制出的数量必须和 toast 上说的数量一致，否则反馈在说谎）。
 */
export function ledgerCopyPaths<T>(rows: T[], pickPath: (row: T) => string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const p = pickPath(row);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
