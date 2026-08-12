import { Show, For, createSignal } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import Logo from "~/components/Logo";
import { currentWorkspace } from "~/stores/workspace";

interface MenuItem {
  icon: string;
  label: string;
  path: string;
}

interface MenuGroup {
  title: string;
  items: MenuItem[];
}

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [expanded, setExpanded] = createSignal(true);
  // v2.4.9 M7：分组折叠——默认全展开；点组标题收起/展开；会话内不持久化（与 expanded 内存信号一致）
  const [collapsedGroups, setCollapsedGroups] = createSignal<string[]>([]);

  const toggleGroup = (title: string) =>
    setCollapsedGroups((prev) =>
      prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title],
    );

  const groups: MenuGroup[] = [
    {
      title: "概览",
      items: [
        { icon: "📊", label: "仪表盘", path: "/" },
      ],
    },
    {
      title: "资料-产品",
      items: [
        { icon: "📁", label: "产品集", path: "/product-sets" },
        { icon: "🖼️", label: "图包库", path: "/images" },
        { icon: "📜", label: "证书库", path: "/certs" },
      ],
    },
    {
      title: "资料-业务",
      items: [
        // v2.4.7：客户 + 发票入口（PLAN §5.2 / §6.5）
        { icon: "🤝", label: "客户", path: "/clients" },
        // v2.4.9 S2：供应商入口
        { icon: "🏭", label: "供应商", path: "/suppliers" },
        // v2.4.9 S3：报价单入口
        { icon: "📄", label: "报价", path: "/quotes" },
        { icon: "🧾", label: "发票", path: "/invoices" },
      ],
    },
    {
      title: "工具",
      items: [
        { icon: "🔍", label: "搜索", path: "/search" },
        // v2.4.8：导出区入口（压缩分享产物）
        { icon: "📤", label: "导出", path: "/exports" },
      ],
    },
    {
      title: "系统",
      items: [
        { icon: "👤", label: "我的", path: "/profile" },
        { icon: "⚙️", label: "设置", path: "/settings" },
        { icon: "🗑️", label: "回收站", path: "/trash" },
      ],
    },
  ];

  const isActive = (path: string) => {
    if (path === "/") {
      return location.pathname === "/";
    }
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  return (
    <aside
      class="h-full flex flex-col border-r border-surface-200 bg-surface-0"
      style={{ width: expanded() ? "260px" : "64px", transition: "width 0.2s" }}
    >
      <div class="h-14 flex items-center px-4 border-b border-surface-200">
        <Show when={expanded()}>
          <div class="flex items-center gap-2">
            <Logo class="w-6 h-6" />
            <span class="font-semibold text-lg text-primary-700">启禾文件管理</span>
          </div>
        </Show>
        <button
          class="ml-auto p-1.5 rounded-lg hover:bg-surface-100 transition-colors"
          onClick={() => setExpanded(!expanded())}
        >
          {expanded() ? "◀" : "▶"}
        </button>
      </div>

      <div class="flex-1 overflow-y-auto py-2">
        <For each={groups}>
          {(group, groupIndex) => (
            <>
              <Show when={expanded()}>
                <div class={`px-3 mb-2 ${groupIndex() === 0 ? "" : "mt-4"}`}>
                  {/* v2.4.9 M7：组标题可折叠（title 供 e2e 定位；折叠后整组隐藏、标题保留） */}
                  <button
                    type="button"
                    class="w-full flex items-center justify-between gap-1 text-xs font-medium text-surface-400 uppercase tracking-wider px-2 py-1 rounded-lg hover:bg-surface-100 hover:text-surface-600 transition-colors cursor-pointer"
                    title={`展开/收起${group.title}`}
                    onClick={() => toggleGroup(group.title)}
                  >
                    <span>{group.title}</span>
                    <span class="text-[10px] leading-none text-surface-300">
                      {collapsedGroups().includes(group.title) ? "▶" : "▼"}
                    </span>
                  </button>
                </div>
              </Show>
              <Show when={!expanded() && groupIndex() !== 0}>
                <div class="mx-3 my-2 border-t border-surface-200" />
              </Show>
              {/* 64px 整体折叠态忽略分组折叠：组内条目全显（组标题本就不渲染，无恢复入口） */}
              <Show when={!expanded() || !collapsedGroups().includes(group.title)}>
                <For each={group.items}>
                  {(item) => (
                    <button
                      class="w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface-100"
                      classList={{
                        "text-primary-700 bg-primary-50 border-r-2 border-primary-600": isActive(item.path),
                        "text-surface-600": !isActive(item.path),
                      }}
                      title={!expanded() ? item.label : undefined}
                      onClick={() => navigate(item.path)}
                    >
                      <span class="text-base">{item.icon}</span>
                      <Show when={expanded()}>
                        <span class="font-medium">{item.label}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>
            </>
          )}
        </For>
      </div>

      <Show when={expanded()}>
        <div class="p-3 border-t border-surface-200">
          <div class="text-xs text-surface-400 truncate">
            <Show when={currentWorkspace()} fallback={<span>未选择工作区</span>}>
              <span>📂 {currentWorkspace()?.name}</span>
            </Show>
          </div>
        </div>
      </Show>
    </aside>
  );
}
