import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { pushLayer } from "~/components/ui/layerStack";
import { Portal } from "solid-js/web";
import { tagColor, refreshTags, DEFAULT_TAG_COLOR } from "~/stores/tags";
import { showToast } from "~/stores/notifyBanner";
import { api } from "~/wails/api";
import TagChip from "~/components/TagChip";
import type { TagInfo } from "~/types";
import Input from "~/components/ui/Input";

/**
 * 标签输入组件（v2.4.x 增强）：
 * 已选标签 chips（tagChipStyle 背景、可 ✕ 移除）+ 输入框；
 * 输入时下拉过滤候选（名称包含匹配、排除已选），点击候选或回车添加；
 * 自由输入（非候选名）回车不再直接产生孤儿引用：下拉首项「新建标签 "X"」，
 * 点击或键盘选中回车 → api.tags.create 建定义（成功刷新全局标签并应用选中）；
 * 输入含 '/' 按 父/子 语法建子标签（父不存在则 toast 报错不创建）；
 * 精确命中已定义标签（含 父/子 形态）回车直接添加（保留原行为）。
 * 下拉支持 ↑/↓ 移动高亮、Enter 选中高亮项、Esc 关闭；高亮首项默认。
 * 受控：value/onChange；options 为顶层列表（含 children）。
 * 下拉经 Portal 渲染到 body + position:fixed（宿主弹窗 overflow-auto 不会裁剪），
 * 坐标取自输入容器 getBoundingClientRect()，bottom-left 对齐、间隙 6px，z-[70]；
 * 滚动（捕获）/窗口变化/外部点击/ESC 关闭（与 DatePicker 一致）。
 */
export default function TagInput(props: {
  value: string[];
  onChange: (next: string[]) => void;
  options: TagInfo[];
  placeholder?: string;
  /** v2.5.7（A3）：业务域过滤——缺省未传 = 不过滤（零回归）；
   *  传了才按 `!def.scope || def.scope === 'general' || def.scope === prop` 过滤候选；
   *  新建标签时把当前 scope 写入定义（无 prop → general 全域可见） */
  scope?: string;
}) {
  const [input, setInput] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0, width: 0 });
  const [activeIndex, setActiveIndex] = createSignal(0);
  let rootEl: HTMLDivElement | undefined;
  let panelEl: HTMLDivElement | undefined;

  // v2.5.7（A3）：scope 过滤谓词——缺省不过滤；传了才过滤（general 全域可见）
  const scopeMatch = (t: TagInfo) => {
    const s = props.scope;
    if (!s) return true;
    return !t.scope || t.scope === "general" || t.scope === s;
  };

  // 已定义标签名（含子标签）：孤儿标签（未定义）chip 高亮提醒
  const definedNames = () => new Set(props.options.flatMap((t) => [t.name, ...(t.children ?? [])]));

  // 精确命中映射：文本（普通名 + 父/子 形态）→ 规范标签名
  // v2.5.7（A3）：scope 过滤（跨域标签不进精确命中——避免在错误域加跨域标签）
  const exactNames = () => {
    const m = new Map<string, string>();
    for (const t of props.options) {
      if (!scopeMatch(t)) continue;
      m.set(t.name, t.name);
      for (const c of t.children ?? []) {
        if (!scopeMatch({ ...t, name: c } as TagInfo)) continue;
        m.set(c, c);
        m.set(`${t.name}/${c}`, c);
      }
    }
    return m;
  };

  // 下拉候选：名称包含匹配 + 排除已选；输入为空时展示全部未选。
  // 展开子标签（props.options 为顶层列表）：子标签显示 父/子 并缩进
  // v2.5.7（A3）：scope 过滤（scopeMatch 谓词：缺省不过滤）
  const candidates = () => {
    const term = input().trim().toLowerCase();
    const selected = new Set(props.value);
    const match = (name: string) => !term || name.toLowerCase().includes(term);
    const result: TagInfo[] = [];
    for (const t of props.options) {
      if (!scopeMatch(t)) continue;
      if (!selected.has(t.name) && match(t.name)) result.push(t);
      for (const c of t.children ?? []) {
        if (selected.has(c)) continue;
        if (!match(c) && !match(t.name)) continue;
        result.push({
          name: c,
          color: tagColor(c),
          parent: t.name,
          children: [],
          builtin: !!t.builtin,
          defined: true,
          count: 0,
          scope: t.scope,
        });
      }
    }
    return result;
  };

  // 下拉项：新建标签合成项（输入非空且未精确命中）+ 候选
  type DropdownItem = { kind: "new"; term: string } | { kind: "candidate"; tag: TagInfo };
  const items = (): DropdownItem[] => {
    const term = input().trim();
    const list: DropdownItem[] = [];
    if (term && !exactNames().has(term)) list.push({ kind: "new", term });
    for (const c of candidates()) list.push({ kind: "candidate", tag: c });
    return list;
  };

  // 下拉定位：bottom-left 对齐输入容器，间隙 6px，宽度与容器一致
  const updatePos = () => {
    const rect = rootEl?.getBoundingClientRect();
    if (rect) setPos({ left: rect.left, top: rect.bottom + 6, width: rect.width });
  };

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (!props.value.includes(t)) props.onChange([...props.value, t]);
    setInput("");
  };

  const removeTag = (index: number) => {
    props.onChange(props.value.filter((_, i) => i !== index));
  };

  /** 新建标签：父/子 语法解析（parentName/name）→ create → refreshTags → 应用选中 */
  const createTag = async (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    let parentName: string | null = null;
    let name = t;
    const slash = t.indexOf("/");
    if (slash >= 0) {
      parentName = t.slice(0, slash).trim() || null;
      name = t.slice(slash + 1).trim();
    }
    if (!name) return;
    if (parentName && !definedNames().has(parentName)) {
      showToast("error", "父标签不存在", `未找到父标签「${parentName}」，请先在设置中创建`);
      return;
    }
    const r = await api.tags.create(name, DEFAULT_TAG_COLOR, parentName, props.scope);
    if (!r.success) {
      showToast("error", "新建标签失败", r.error || "未知错误");
      return;
    }
    refreshTags();
    if (!props.value.includes(name)) props.onChange([...props.value, name]);
    setInput("");
    setOpen(false);
  };

  /** 回车：精确命中已定义标签直接添加（保留原行为）；否则选中高亮项（首项默认「新建标签 X」） */
  const onEnter = async () => {
    const t = input().trim();
    if (!t) return;
    const exact = exactNames().get(t);
    if (exact) {
      addTag(exact);
      return;
    }
    const list = items();
    if (open() && list.length > 0) {
      const item = list[Math.min(activeIndex(), list.length - 1)];
      if (item.kind === "new") await createTag(item.term);
      else addTag(item.tag.name);
    } else {
      // 下拉未开（如 Esc 后回车）→ 走新建流程
      await createTag(t);
    }
  };

  // 打开下拉时重算定位；已选 chips 增删会改变容器高度，依赖 value.length 同步刷新
  createEffect(() => {
    void props.value.length;
    if (open()) updatePos();
  });

  // 高亮越界收敛（候选/新建项增删后）
  createEffect(() => {
    const n = items().length;
    if (n > 0) setActiveIndex((i) => Math.min(i, n - 1));
  });

  // 键盘 ↑/↓ 时把高亮行拉回视野：面板 max-h-48 只装得下约 7 行，而 items() 可达数十条——
  // 不做这件事，"选不到尾部标签"只修了一半（鼠标能滚了，键盘 ↓ 到底仍在一屏之外瞎选）。
  // block:'nearest' 而不是 'end'：已在视野内时**一动不动**，不会为了看高亮行把整屏顶偏。
  createEffect(() => {
    if (!open()) return;
    const idx = activeIndex();
    queueMicrotask(() => {
      panelEl?.querySelectorAll<HTMLButtonElement>("button")[idx]?.scrollIntoView({ block: "nearest" });
    });
  });

  // v2.5.1（T3 波3，D2）：弹出层入层栈（Esc 归属栈顶：弹出层 > 弹窗）
  createEffect(() => {
    if (!open()) return;
    const layer = pushLayer({ onEscape: () => setOpen(false) });
    onCleanup(() => layer.remove());
  });

  // 点击外部 / ESC / 滚动（捕获）/ 窗口变化 → 关闭
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return; // 层栈已消费
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelEl && panelEl.contains(target)) return;
      if (rootEl && rootEl.contains(target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    /*
     * 滚动关闭只认「**会让输入框移位**」的滚动：document/window，或输入框的祖先滚动容器。
     * 口径照抄 ui/SearchSelect.tsx 的 onScroll——那边 v2.5.8 已实测并修过同一处自杀（其注释原话：
     * "选项 >7 条时面板内 .vscroll 一翻页就把自己关掉（探针实验：面板数 1→0）"）。本组件当时
     * **没跟着改**，于是留着无条件 close()：面板自身是 `max-h-48 overflow-y-auto`（第 273 行），
     * 标签一多（实测 30 个 = scrollHeight 968 vs clientHeight 190）用户想在面板里滚到尾部，
     * 第一格滚动就把整个下拉关掉 ⇒ **尾部标签永远选不到**，重开又从头（用户读作"跳顶/空白/错位"）。
     * 事件目标类型是 EventTarget（document 滚动的 target 就是 document），不能用 Node 收窄，
     * 否则与 window 的比较在 tsc 下是 TS2367 无重叠比较（SearchSelect 同注）。
     */
    const onScroll = (e: Event) => {
      const t = e.target as EventTarget | null;
      if (t && t !== document) {
        if (!rootEl || !(t as Element).contains?.(rootEl)) return; // 面板内滚动 / 无关容器 ⇒ 保持打开
      }
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    });
  });

  return (
    <div ref={rootEl} class="relative">
      <Show when={props.value.length > 0}>
        <div class="flex flex-wrap gap-1.5 mb-2">
          <For each={props.value}>
            {(tag, index) => (
              <TagChip
                name={tag}
                warn={!definedNames().has(tag)}
                title={definedNames().has(tag) ? undefined : "未在设置中定义，可在设置中转为正式标签"}
                onRemove={() => removeTag(index())}
              />
            )}
          </For>
        </div>
      </Show>
      <Input
        type="text"
        class="w-full"
        placeholder={props.placeholder ?? "输入标签按回车"}
        value={input()}
        onInput={(e) => {
          setInput(e.currentTarget.value);
          setActiveIndex(0);
          updatePos();
          setOpen(true);
        }}
        onFocus={() => {
          setActiveIndex(0);
          updatePos();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void onEnter();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const n = items().length;
            if (n > 0) {
              setActiveIndex((i) => (i + 1) % n);
              setOpen(true);
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const n = items().length;
            if (n > 0) {
              setActiveIndex((i) => (i - 1 + n) % n);
              setOpen(true);
            }
          }
        }}
      />
      <Portal>
        <Show when={open() && items().length > 0}>
          <div
            ref={panelEl}
            class="fixed z-[70] max-h-48 overflow-y-auto bg-white border border-surface-200 rounded-lg shadow-lg py-1"
            style={{ left: `${pos().left}px`, top: `${pos().top}px`, width: `${pos().width}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <For each={items()}>
              {(item, index) =>
                item.kind === "new" ? (
                  // v2.5.8 D14（样式统一收口）：下拉候选行是「整行可点项」→ 收进 `.row-btn` 节奏档
                  // （块级满行 + 精确属性过渡 + active 按压 + 禁用态，此前完全没有过渡）。
                  // `gap-2 px-3 py-1.5` 把档内尺寸钉回迁移前实测值（档默认 gap-3 px-4 py-2.5），
                  // 高亮/悬停底色（bg-surface-100）与首项分隔线属语义色与版式，一律留调用方。
                  <button
                    class={`row-btn gap-2 px-3 py-1.5 text-sm border-b border-surface-100 ${activeIndex() === index() ? "bg-surface-100" : "hover:bg-surface-100"}`}
                    onMouseEnter={() => setActiveIndex(index())}
                    onClick={() => void createTag(item.term)}
                  >
                    <span class="w-2.5 h-2.5 rounded-full shrink-0" style={{ "background-color": DEFAULT_TAG_COLOR }} />
                    <span class="truncate">
                      新建标签 <span class="font-medium">{item.term}</span>
                    </span>
                  </button>
                ) : (
                  // v2.5.8 D14：同「新建标签」行——收进 `.row-btn`，尺寸钉回实测值；
                  // 子标签缩进 `pl-7` 与高亮底色留调用方（pl-* 在 utilities 层，仍压得过档的 px-*）
                  <button
                    class={`row-btn gap-2 px-3 py-1.5 text-sm ${item.tag.parent ? "pl-7" : ""} ${activeIndex() === index() ? "bg-surface-100" : "hover:bg-surface-100"}`}
                    onMouseEnter={() => setActiveIndex(index())}
                    onClick={() => addTag(item.tag.name)}
                  >
                    <span class="w-2.5 h-2.5 rounded-full shrink-0" style={{ "background-color": tagColor(item.tag.name) }} />
                    <span class="truncate">
                      {item.tag.parent ? <span class="text-surface-400">{item.tag.parent}/</span> : null}
                      {item.tag.name}
                    </span>
                  </button>
                )
              }
            </For>
          </div>
        </Show>
      </Portal>
    </div>
  );
}
