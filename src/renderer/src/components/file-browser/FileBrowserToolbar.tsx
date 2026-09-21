import { For, Show, createSignal } from "solid-js";
import { useContextMenu } from "~/hooks/useContextMenu";
import ContextMenu from "~/components/ContextMenu";
import Input from "~/components/ui/Input";
import { BUILTIN_NOTES_FOLDER } from "../../constants/notes";

/**
 * 文件管理视图子文件夹工具栏（v2.5.1 T3 波2 拆分）：
 * 子文件夹 tab 切换 + 删除当前类型/新建子文件夹（v2.5.5 起客户/供应商均开放操作，产品集区按类型显示）。
 * 语义色已收敛（T1：danger）。
 * v2.5.7（A2 笔记）：内建「笔记」子文件夹不显示删除按钮（core 双守卫：deleteSubfolder/renameSubfolder 拒绝）。
 */
export default function FileBrowserToolbar(props: {
  subFolders: string[];
  /** v2.5.9（A9 刀1b）：盘上尚无文件的子文件夹名 → 淡一档（用户拍板「空的要显示并且淡一点」） */
  emptySubs?: Set<string>;
  /** v2.5.9（悬案·就地改名）：右键 tab 触发；本组件内出内联输入框，提交时回调页面级 */
  onRenameSubfolder?: (name: string) => void;
  /** 就地改名提交（oldName → newName）；Promise 结束后本组件收起输入框 */
  onRenameSubfolderCommit?: (oldName: string, newName: string) => Promise<void> | void;
  currentSub: string;
  typeLabel: string;
  isCustomer: boolean;
  isSupplier: boolean;
  /** v2.5.5（对齐）：客户/供应商文件区显示「选择文件并添加」按钮（产品集区拖出拖入，红线不显示） */
  showImport: boolean;
  onImportFiles: () => void;
  onNavigate: (sub: string) => void;
  onDeleteSubfolder: () => void;
  onNewSubfolder: () => void;
  /** v2.5.7（A2 笔记）：内建「笔记」子文件夹视图的新建笔记按钮（其他子文件夹不显示） */
  onNewNote?: () => void;
}) {
  const menu = useContextMenu<string>();
  /** v2.5.9（悬案·就地改名）：正在改名的 tab 名；非空时 tab 条换成输入框——就地改、不弹窗，
      也不用 ✓/✕ 两个按钮（Enter 提交 / Esc 取消，写在 placeholder 里）：
      这样整站只多**一个**控件（右键菜单那一项），按钮基线只 +1（用户 2026-09-21 点头）。 */
  const [renaming, setRenaming] = createSignal<string | null>(null);
  /** 输入框登场时刻：菜单关闭会把焦点从菜单行挪走，顺带 blur 掉刚出生的输入框
   *  ⇒ 开盒 300ms 内的 blur 一律忽略（否则"点菜单→输入框一闪就没"）。 */
  const [renameOpenedAt, setRenameOpenedAt] = createSignal(0);
  /** 右键点中的那个 tab 名。⚠ 不从 `menu.payload()` 读：`items={...}` 这个属性只在组件
   *  创建时求值一次，payload 后到也不会重算 ⇒ action 里现读必然拿到 null
   *  （2026-09-21 实测：菜单点得动、输入框就是不出现）。右键时手里就有 sub，直接存。 */
  const [renameTarget, setRenameTarget] = createSignal<string | null>(null);
  /**
   * ⚠ payload 必须在**开菜单时**就捕获，不能在 action 里现读：
   * `useContextMenu.close()` 会把 payload 清空，而菜单项的点击链路是先触发
   * 文档级关闭（payload 归 null）再派发 action ⇒ 现读必然拿到 null。
   * （2026-09-21 实测：这么写时菜单点得动、输入框就是不出现。）
   * 把 payload 读进 items 的构造过程 ⇒ 它变成响应依赖，开菜单即重算并捕获。
   */
  const renameMenuItems = () => {
    const target = renameTarget();
    return [
      {
        label: "重命名这一个目录…",
        action: () => {
          if (!target) return;
          setRenaming(target);
          setRenameOpenedAt(Date.now());
          queueMicrotask(() =>
            document.querySelector<HTMLInputElement>('input[aria-label="子文件夹新名称"]')?.focus(),
          );
        },
      },
    ];
  };

  const submitRename = async (): Promise<void> => {
    const old = renaming();
    const el = document.querySelector<HTMLInputElement>('input[aria-label="子文件夹新名称"]');
    const next = el?.value?.trim() ?? "";
    if (!old) return;
    if (!next || next === old) {
      setRenaming(null); // 空名 / 没改名 = 取消（不拿空名去打 IPC）
      return;
    }
    await props.onRenameSubfolderCommit?.(old, next);
    setRenaming(null);
  };
  return (
    <div class="flex items-center justify-between mb-6">
      {/* v2.5.8 精致化 D6 批 2：分段切换器收进 .seg-* 单点口径（材质见 index.css，刻意不用玻璃） */}
      <div class="seg-track">
        <Show when={renaming()} fallback={
          <For each={props.subFolders}>
          {(sub) => (
            <button
              // ⚠ class 必须排在第一个属性：uiScan 的 naive 扫描器按标签内第一个 `>` 截断，
              //    任何写在 class 之前的箭头函数（`=>` 里的 `>`）都会让它误判成"没有 class"
              //    （2026-09-21 实测踩过：onContextMenu 前置 ⇒ 全站 noclass 从 1 处变 2 处）。
              class={`seg-item ${
                props.currentSub === sub
                  ? "seg-item-on"
                  : props.emptySubs?.has(sub)
                    ? // A9：空目录不藏，只淡一档（看得见的空结构比藏�
                      "text-surface-400 hover:text-surface-700"
                    : "text-surface-500 hover:text-surface-700"
              }`}
              title={
                props.currentSub !== sub && props.emptySubs?.has(sub)
                  ? "还没有文件；放进去就会出现在这里"
                  : undefined
              }
              onClick={() => props.onNavigate(sub)}
              // v2.5.9 返工（2026-09-22）：**右键 mousedown 必须 preventDefault**。不给这一步，
              // 按钮会拿到焦点，而焦点落在「被视口下沿切到一半」的 tab 上时，浏览器会把它滚进视野
              // ⇒ MAIN 容器冒出一个 scroll 事件；`useContextMenu` 的「滚动即关」是刻意设计（防菜单漂走）
              // ⇒ 菜单开完 ~7ms 就被自己这脚滚动关掉（真机表现 = 菜单闪一下就没）。
              // 旧代码看不出来：那时菜单关闭也照渲染在 DOM 里，靠这个 bug 掩盖了那个 bug。
              // 只拦右键；左键导航与键盘可达性不受影响。
              onMouseDown={(e) => {
                if (e.button === 2) e.preventDefault();
              }}
              // v2.5.9（悬案·就地改名）：右键某个 tab = 只改**这个实体下**的这一个目录
              // （不碰模板、不碰其他实体）。入口只有这一个菜单项——按钮基线 +1 是用户点头的。
              onContextMenu={(e) => {
                if (sub === BUILTIN_NOTES_FOLDER) return; // 内建「笔记」不可改
                e.preventDefault();
                setRenameTarget(sub);
                menu.open(e, sub);
              }}
            >
              {sub}
            </button>
          )}
          </For>
        }>
          <Input
            class="min-w-[10rem]"
            ariaLabel="子文件夹新名称"
            placeholder="新名称（Enter 确认 / Esc 取消）"
            value={renaming() ?? ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={() => {
              if (Date.now() - renameOpenedAt() > 300) setRenaming(null);
            }}
          />
        </Show>
      </div>
      <div class="flex gap-2">
        {/* v2.5.5（对齐）：按钮导入入口——客户/供应商文件区专属（台账/业务层不用拖拽；产品集区拖出拖入是红线，不显示） */}
        <Show when={props.showImport}>
          <button class="btn-secondary text-sm" onClick={props.onImportFiles}>
            📂 选择文件并添加
          </button>
        </Show>
        {/* v2.5.5（对齐客户）：供应商子文件夹从固定集改可配置——客户/供应商均显示删除/新建（产品集区按类型文案）。
            v2.5.7（A2 笔记）：内建「笔记」不可删——按钮隐藏（core 兜底拒绝） */}
        <Show when={props.currentSub !== BUILTIN_NOTES_FOLDER}>
          <button
            class="btn-secondary text-sm text-danger-600 hover:bg-danger-50 hover:border-danger-200"
            onClick={props.onDeleteSubfolder}
          >
            🗑️ 删除当前{props.isCustomer || props.isSupplier ? "子文件夹" : `${props.typeLabel}类型`}
          </button>
        </Show>
        {/* v2.5.7（A2 笔记）：内建「笔记」视图显示新建笔记（工作台/文件区两入口之一） */}
        <Show when={props.currentSub === BUILTIN_NOTES_FOLDER && props.onNewNote}>
          <button class="btn-secondary text-sm" onClick={() => props.onNewNote?.()}>
            📝 新建笔记
          </button>
        </Show>
        <button class="btn-secondary text-sm" onClick={props.onNewSubfolder}>
          ➕ 新建{props.isCustomer || props.isSupplier ? "子文件夹" : `${props.typeLabel}类型`}
        </button>
      </div>

      {/* v2.5.9（悬案·就地改名）：整站只此一个新菜单项 ⇒ 按钮基线 +1（用户已授权）。
          内建「笔记」在 tab 的 onContextMenu 里就挡掉，这里不重复判。
          ⚠ 必须套 `<Show when={menu.show()}>`（`useContextMenu` 头注的既有契约，全站其余调用点皆如此）：
          `ContextMenu` 自身只按 `items.some(...)` 决定渲染，而本处的 items 是**常量非空**的
          ⇒ 不套这层，菜单在关闭时也常驻 DOM（实测：`#ctx-menu-root` 里永远多一枚隐形
          「重命名这一个目录…」，把 `tests/e2e/rename.spec.ts` 的 /重命名/ 定位打成 strict 冲突）。 */}
      <Show when={menu.show()}>
        <ContextMenu
          x={menu.x()}
          y={menu.y()}
          items={renameMenuItems()}
          onClose={menu.close}
        />
      </Show>
    </div>
  );
}
