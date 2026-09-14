/**
 * 应用内快捷键单注册点（v2.5.8 D11 / 精致化 PLAN W6）。
 *
 * **为什么要有这个文件**：此前 `Ctrl+<字母>` 三处各挂各的 `window.addEventListener("keydown")`
 * （`Header` 的 Ctrl+K、`NoteEditorModal` 的 Ctrl+S、`FileBrowserView` 的 Ctrl+C），
 * 三件事各自漂移：① 守卫口径不一致（Ctrl+K 豁免输入框与 contenteditable，Ctrl+S 谁都不豁免），
 * ② 同一个键被两处监听同时消费也没人仲裁，③ 设置页要列快捷键只能靠人肉回忆。
 * 这里收成**一张声明表 + 一个监听**：表是唯一真相，页面只注册处理器、不再自己挂 keydown。
 *
 * **派发规则（与收编前逐条等价，不升级语义）**：
 * - 组合键按表的**声明顺序**匹配，第一个命中且有处理器的生效并 `preventDefault`；
 *   没有任何处理器接管的键**原样放行**给浏览器（否则输入框打字会被吃掉）；
 * - `guard` 是「输入态守卫」：标注 `text` 的条目在 INPUT/TEXTAREA/SELECT/contenteditable
 *   里**不劫持**（Ctrl+K 与 Ctrl+C 收编前都是这个口径，一字未动地搬过来）；
 *   标注 `none` 的条目（Ctrl+S）保持「编辑器里也要能存盘」的原口径；
 * - `when` 只做「本页有没有注册处理器」的门控——不引入路由判断，避免与页面自身条件双源。
 * - **弹窗让位（v2.5.9 修复）**：处理器注册时可标 `pageOnly`，栈里开着弹窗级层（`ui/Modal` 家族
 *   与预览弹窗，判据见 `layerStack.hasModalLayer()`）时**跳过页面级那几条、继续试弹窗自己注册的**。
 *   补这条的原因不是理论，是三条实测：重命名弹窗里把焦点 blur 掉后按 Ctrl+C，底层弹
 *   「已复制 1 个文件到剪贴板」；按 Ctrl+A，底层从 1 个选成 2 个；按 Delete，在重命名弹窗上
 *   又叠一层「删除文件」确认框；预览弹窗里按 Delete 删的是**底层选中的另一个文件**，
 *   而屏幕上显示的是眼前这一张（`tests/e2e/dialog-keys.spec.ts` 已把这些钉成常驻用例）。
 *   `guard: "text"` 管不到这些——它只看焦点在不在输入元素上，弹窗里点一下按钮/空白就离开输入框了。
 *
 * **豁免清单（PLAN W6 三分法）**：现存 `keydown` 监听 **14 处** = 本文件单点 1 +
 * 下列 13 处豁免（`ui/layerStack.ts` 保留 1 + 组件内部 12）。`tests/unit/shortcuts.test.ts`
 * 把 14 这个数钉死，计数前先剥掉注释，所以这里只数**现存监听**。
 * 另有 **3 处的组合键语义已收编进本表**，但只有前两处的监听整个消失：
 * `Header`(Ctrl+K) 与 `FileBrowserView`(Ctrl+C) 不再自己挂监听；
 * `NoteEditorModal` 的 **Ctrl+S 存盘语义**收进本表，而它自己的 capture 段监听仍在（= 下面第 7 项，
 * 管的是 Crepe 编辑器内部按键，与快捷键无关，两件事别混）。
 * 以下 13 处监听**只处理本组件自身的 Esc/↑↓/Tab/Enter，不含任何 `Ctrl+<字母>`/`Delete` 全局语义**，
 * 算组件职责、不算散挂，故不进本表（这条「算不算散挂」的口径目前只有文字约束——单测钉的是**数量**，
 * 不比对下面这份文件清单，见 §末注）：
 *   1. `ui/layerStack.ts` —— Esc 派栈顶，**全站唯一 Esc 入口**（保留，本就是单注册点）
 *   2. `ui/Modal.tsx` —— 焦点困守 Tab/Shift+Tab
 *   3. `ui/SearchSelect.tsx` —— 面板内 ↑↓/Enter/Esc
 *   4. `ContextMenu.tsx` —— 菜单内 Esc（关闭语义已入层栈）
 *   5. `DatePicker.tsx` —— 面板内方向键与 Esc
 *   6. `TagInput.tsx` —— 标签下拉的 ↑↓/Enter/Esc
 *   7. `NoteEditorModal.tsx`(capture 段) —— Crepe 编辑器内的任务键委托
 *   8. `GlobalDropOverlay.tsx` —— 拖拽遮罩的 Esc
 *   9. `ArchiveProgressDialog.tsx` —— 进度弹窗 Esc
 *  10. `BatchRenameDialog.tsx` —— Enter/Esc
 *  11. `BatchTagDialog.tsx` —— Enter/Esc
 *  12. `MoveDialog.tsx` —— Enter/Esc
 *  13. `FilePreviewModal.tsx` —— ←/→/Esc 翻页与关闭
 * （1 保留 + 12 豁免 = 13 条，与本表行数一致。**钉住的只有总数**：`tests/unit/shortcuts.test.ts`
 *  断言的是「现存监听 = 14」这一个数，不逐条比对本表——把某个监听改名或挪进别的文件，
 *  总数不变、单测不红，这张表就会静默过期。所以动到 keydown 监听时，要人工拿单测失败信息里
 *  打印的实际清单与本表逐行对一遍；要加强成「按文件清单钉死」需要改测试断言，属待拍板项。）
 */

// 相对导入而不是 `~/…`：本文件被纯 node 单测直读（`vitest.config.ts` 里没有 `~` alias），
// 写成 alias 会让 `npm test` 直接解析失败。
import { hasModalLayer } from "./components/ui/layerStack";

/** 输入态守卫档位（见文件头说明） */
export type ShortcutGuard = "text" | "none";

export interface ShortcutSpec {
  /** 稳定 id——页面按它注册处理器，设置页按它排序展示 */
  id: string;
  /** 匹配用的键名（已小写；`key.toLowerCase()` 的结果） */
  key: string;
  /** 是否要求 Ctrl/Cmd（mac 上 metaKey 等价 ctrlKey，收编前三处都是这个口径） */
  ctrl?: boolean;
  /** 处理器返回 true 表示已消费 */
  guard: ShortcutGuard;
  /** 设置页「快捷键」卡展示的说明文案 */
  desc: string;
  /** 导航类条目的目标路由——路由只在这里声明一次，App 的处理器与设置页文案共读 */
  path?: string;
}

/**
 * 侧边栏前六项的直跳路由（`Ctrl+1…6`）。
 * 顺序必须与 `components/Sidebar.tsx` 的 `groups` 前六项一致——那边是数组，这里按位对齐；
 * 两处一旦错位，按 `Ctrl+3` 跳不到「图包库」，故由 `tests/unit/shortcuts.test.ts` 钉住。
 */
const NAV_PATHS = ["/", "/product-sets", "/images", "/certs", "/notes", "/clients"] as const;
const NAV_LABELS = ["仪表盘", "产品集", "图包库", "证书库", "笔记库", "客户"] as const;

/**
 * 声明表 = 唯一真相。顺序即派发优先级（越靠前越优先）。
 * 新增条目就加在这里，设置页与派发自动同步（防双源）。
 */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  { id: "search.focus", key: "k", ctrl: true, guard: "text", desc: "聚焦全局搜索框（有弹窗打开时不生效，避免把焦点从弹窗里踢走）" },
  { id: "note.save", key: "s", ctrl: true, guard: "none", desc: "保存当前笔记（仅笔记编辑器打开时有效）" },
  {
    id: "file.copy",
    key: "c",
    ctrl: true,
    guard: "text",
    desc: "复制选中的文件路径（正文有选区时让位给浏览器；预览里复制的是当前这一张；其他弹窗开着时不生效）",
  },
  // v2.5.8 D19（体验批 B3/B7）：粘贴与应用内剪切。两条都标 `guard: "text"`——
  // 输入框里的 Ctrl+V / Ctrl+X 是文本编辑，永远归浏览器（派发层拦，页面不重复判）。
  // v2.5.9 追加：弹窗开着时整条让位（实测原缺陷会在重命名弹窗里按 Ctrl+V 触发底层导入）。
  { id: "file.cut", key: "x", ctrl: true, guard: "text", desc: "剪切选中的文件（应用内 = 移动语义，粘到目标处才落地；弹窗开着时不生效）" },
  {
    id: "file.paste",
    key: "v",
    ctrl: true,
    guard: "text",
    desc: "粘贴到当前文件夹：应用内剪切 → 移动；否则系统剪贴板里有文件 → 导入（弹窗开着时不生效，先在弹窗里粘贴文本请用输入框）",
  },
  {
    id: "list.selectAll",
    key: "a",
    ctrl: true,
    guard: "text",
    desc: "全选当前筛选结果（仅浮条出现时有效；输入框内仍是全选文本；弹窗开着时不生效）",
  },
  {
    id: "list.delete",
    key: "delete",
    ctrl: false,
    guard: "text",
    desc: "删除选中项（走各页既有的二次确认弹窗，不改删除语义；仅浮条出现时有效；预览里删的是当前这一张，其他弹窗开着时不生效）",
  },
  { id: "settings.open", key: ",", ctrl: true, guard: "text", desc: "打开设置页", path: "/settings" },
  ...NAV_PATHS.map((p, i) => ({
    id: `nav.${i + 1}`,
    key: String(i + 1),
    ctrl: true,
    guard: "text" as ShortcutGuard,
    desc: `跳到${NAV_LABELS[i]}`,
    path: p,
  })),
];

/**
 * 组合键的展示写法（设置页「快捷键」卡直读声明表渲染，杜绝「文档一套、代码一套」）。
 * mac 上 metaKey 与 ctrlKey 同权（收编前三处都是这个口径），故统一显示成 `Ctrl+`，
 * 不按平台分化——按平台分化会让人在 mac 上写 Cmd+K 而表里其实匹配的是任一个，反而是双源。
 */
export function comboLabel(spec: ShortcutSpec): string {
  const k = spec.key === "," ? "," : spec.key === "delete" ? "Delete" : spec.key.toUpperCase();
  return spec.ctrl ? `Ctrl+${k}` : k;
}

/** 由 `id` 取声明（派发与设置页共用，避免两处各写一份 find） */
export function findShortcut(id: string): ShortcutSpec | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** 收编前三处各自的「输入元素」判据——原样搬，不扩面 */
export function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el?.isContentEditable === true;
}

/** 组合键匹配（纯函数，可单测）：返回命中的声明或 undefined */
export function matchShortcut(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">,
  specs: readonly ShortcutSpec[] = SHORTCUTS,
): ShortcutSpec | undefined {
  const k = e.key.toLowerCase();
  const wantsMod = e.ctrlKey || e.metaKey;
  // 声明表的顺序即优先级；`ctrl: false` 的裸键（Delete）只在没按修饰键时匹配，
  // 否则 Ctrl+Delete / Shift+Delete 会被误当删除动作
  return specs.find((s) => (s.ctrl ? wantsMod && s.key === k : !wantsMod && s.key === k));
}

type Handler = (e: KeyboardEvent, spec: ShortcutSpec) => boolean | void;

/**
 * 注册选项。`pageOnly: true` = 这条处理器属于**页面**，弹窗开着就该让位（v2.5.9 按键归属修复）。
 *
 * **为什么必须按处理器判、不能按 `id` 判**：同一个 `id` 上会同时挂着页面版与弹窗版两条
 * ——`file.copy` 就是（七个页面各注册一条页面版 + 预览弹窗自己一条）。按 id 一刀切会把
 * 预览自己的那条一起挡掉，等于把 v2.5.8 D19 B2③「预览里按 Ctrl+C 复制正在预览的那一张」改没。
 */
export interface ShortcutHandlerOpts {
  pageOnly?: boolean;
}

/** 一条注册（`pageOnly` 与处理器绑在一起，注销时按对象身份移除） */
interface Registration {
  fn: Handler;
  pageOnly: boolean;
}

const handlers = new Map<string, Set<Registration>>();

/**
 * 注册某个快捷键的处理器（组件 `onMount` 里调、`onCleanup` 里注销）。
 * 返回注销函数——同一 id 可有多个处理器（如多个编辑器实例），按注册序试，第一个消费即止。
 */
export function registerShortcut(id: string, fn: Handler, opts?: ShortcutHandlerOpts): () => void {
  let set = handlers.get(id);
  if (!set) {
    set = new Set();
    handlers.set(id, set);
  }
  const reg: Registration = { fn, pageOnly: opts?.pageOnly === true };
  set.add(reg);
  return () => {
    set.delete(reg);
    if (set.size === 0) handlers.delete(id);
  };
}

/** 是否有任何处理器接管这个键（设置页与测试用） */
export function hasHandler(id: string): boolean {
  return (handlers.get(id)?.size ?? 0) > 0;
}

/**
 * 单次派发的入口（导出只为让纯 node 单测能直接喂一个假事件进来验让位规则，
 * 与 `layerStack.dispatchEscapeForTest` 同一先例——`installShortcutHost` 用的就是它，无第二条实现）。
 */
export const dispatchShortcut = (e: KeyboardEvent): void => {
  const spec = matchShortcut(e);
  if (!spec) return;
  if (spec.guard === "text" && isTextTarget(e.target)) return;
  const set = handlers.get(spec.id);
  if (!set || set.size === 0) return; // 没人接管 → 原样放行
  // v2.5.9 按键归属：栈里开着弹窗级层时，页面级处理器一条都不试（判据是**注册方声明的
  // `pageOnly`**，不是「焦点在不在输入框」——实测：重命名弹窗里把焦点 blur 掉后按 Ctrl+C，
  // 底层直接弹出「已复制 1 个文件到剪贴板」；按 Ctrl+A 把底层从 1 个选成 2 个；按 Delete
  // 在重命名弹窗上又叠一层「删除文件」确认框）。跳过而不是终止：弹窗自己注册的那条
  // （未标 `pageOnly`）仍在同一轮里能被试到，`file.copy` 的页面版/预览版共存就靠这个。
  const yieldToModal = hasModalLayer();
  for (const reg of set) {
    if (yieldToModal && reg.pageOnly) continue;
    if (reg.fn(e, spec) === true) {
      e.preventDefault();
      return;
    }
  }
};

let installed = false;

/**
 * 装全站唯一监听（`App` 挂载时调一次）。
 * 幂等：重复调用不再挂第二份监听——散挂的根因就是「谁都可能再挂一个」。
 */
export function installShortcutHost(): () => void {
  if (installed) return () => undefined;
  installed = true;
  window.addEventListener("keydown", dispatchShortcut);
  return () => {
    installed = false;
    window.removeEventListener("keydown", dispatchShortcut);
  };
}

/** 测试辅助：清空全部处理器与安装标记（与 layerStack 的 clearStackForTest 同约定） */
export function resetShortcutsForTest(): void {
  handlers.clear();
  installed = false;
}
