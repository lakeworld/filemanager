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
 *
 * **豁免清单（PLAN W6 三分法）**：现存 `keydown` 监听 **14 处** = 本文件单点 1 +
 * 下列 13 处豁免（`ui/layerStack.ts` 保留 1 + 组件内部 12）。`tests/unit/shortcuts.test.ts`
 * 把 14 这个数钉死，计数前先剥掉注释，所以这里只数**现存监听**。
 * 另有 **3 处的组合键语义已收编进本表**，但只有前两处的监听整个消失：
 * `Header`(Ctrl+K) 与 `FileBrowserView`(Ctrl+C) 不再自己挂监听；
 * `NoteEditorModal` 的 **Ctrl+S 存盘语义**收进本表，而它自己的 capture 段监听仍在（= 下面第 7 项，
 * 管的是 Crepe 编辑器内部按键，与快捷键无关，两件事别混）。
 * 以下 13 处监听**只处理本组件自身的 Esc/↑↓/Tab/Enter，不含任何 `Ctrl+<字母>`/`Delete` 全局语义**，
 * 算组件职责、不算散挂，故不进本表（`tests/unit/shortcuts.test.ts` 按此口径把关）：
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
 * （1 保留 + 12 豁免 = 13 条，与上表行数一致；这条等式由单测钉住，防「清单漂移」）
 */

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
  { id: "search.focus", key: "k", ctrl: true, guard: "text", desc: "聚焦全局搜索框" },
  { id: "note.save", key: "s", ctrl: true, guard: "none", desc: "保存当前笔记（仅笔记编辑器打开时有效）" },
  { id: "file.copy", key: "c", ctrl: true, guard: "text", desc: "复制选中的文件路径（正文有选区时让位给浏览器）" },
  {
    id: "list.selectAll",
    key: "a",
    ctrl: true,
    guard: "text",
    desc: "全选当前筛选结果（仅多选浮条出现时有效；输入框内仍是全选文本）",
  },
  {
    id: "list.delete",
    key: "delete",
    ctrl: false,
    guard: "text",
    desc: "删除选中项（走各页既有的二次确认弹窗，不改删除语义；仅浮条出现时有效）",
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

const handlers = new Map<string, Set<Handler>>();

/**
 * 注册某个快捷键的处理器（组件 `onMount` 里调、`onCleanup` 里注销）。
 * 返回注销函数——同一 id 可有多个处理器（如多个编辑器实例），按注册序试，第一个消费即止。
 */
export function registerShortcut(id: string, fn: Handler): () => void {
  let set = handlers.get(id);
  if (!set) {
    set = new Set();
    handlers.set(id, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) handlers.delete(id);
  };
}

/** 是否有任何处理器接管这个键（设置页与测试用） */
export function hasHandler(id: string): boolean {
  return (handlers.get(id)?.size ?? 0) > 0;
}

const dispatch = (e: KeyboardEvent): void => {
  const spec = matchShortcut(e);
  if (!spec) return;
  if (spec.guard === "text" && isTextTarget(e.target)) return;
  const set = handlers.get(spec.id);
  if (!set || set.size === 0) return; // 没人接管 → 原样放行
  for (const fn of set) {
    if (fn(e, spec) === true) {
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
  window.addEventListener("keydown", dispatch);
  return () => {
    installed = false;
    window.removeEventListener("keydown", dispatch);
  };
}

/** 测试辅助：清空全部处理器与安装标记（与 layerStack 的 clearStackForTest 同约定） */
export function resetShortcutsForTest(): void {
  handlers.clear();
  installed = false;
}
