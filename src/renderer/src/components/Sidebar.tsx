import { Show, For, createSignal, createEffect } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import Logo from "~/components/Logo";
import { currentWorkspace, productSets, selectedProductSet, setSelectedProductSet, loadProductSets } from "~/stores/workspace";

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

  createEffect(() => {
    if (currentWorkspace()) {
      loadProductSets();
    }
  });

  const groups: MenuGroup[] = [
    {
      title: "资料管理",
      items: [
        { icon: "📊", label: "仪表盘", path: "/" },
        { icon: "📁", label: "产品集", path: "/product-sets" },
        { icon: "🖼️", label: "图包库", path: "/images" },
        { icon: "📜", label: "证书库", path: "/certs" },
        // v2.4.7：客户 + 发票入口（PLAN §5.2 / §6.5）
        { icon: "🤝", label: "客户", path: "/clients" },
        { icon: "🧾", label: "发票", path: "/invoices" },
      ],
    },
    {
      title: "工具",
      items: [{ icon: "🔍", label: "搜索", path: "/search" }],
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
                  <div class="text-xs font-medium text-surface-400 uppercase tracking-wider px-2">
                    {group.title}
                  </div>
                </div>
              </Show>
              <Show when={!expanded() && groupIndex() !== 0}>
                <div class="mx-3 my-2 border-t border-surface-200" />
              </Show>
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
            </>
          )}
        </For>

        <Show when={expanded() && currentWorkspace()}>
          <div class="mt-4 px-3 mb-2">
            <div class="text-xs font-medium text-surface-400 uppercase tracking-wider px-2">产品集</div>
          </div>
          <div class="px-3">
            <For each={productSets().slice(0, 5)}>
              {(ps) => (
                <button
                  class="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors hover:bg-surface-100"
                  classList={{
                    "bg-primary-50 text-primary-700": selectedProductSet() === ps.name,
                    "text-surface-600": selectedProductSet() !== ps.name,
                  }}
                  onClick={() => {
                    setSelectedProductSet(ps.name);
                    navigate(`/product-sets/${ps.name}`);
                  }}
                >
                  <div class="flex items-center gap-2">
                    <span>📦</span>
                    <span class="truncate">{ps.name}</span>
                  </div>
                </button>
              )}
            </For>
            <Show when={productSets().length > 5}>
              <button
                class="mt-1 w-full text-left px-3 py-2 rounded-lg text-xs text-surface-400 transition-colors hover:bg-surface-100 hover:text-primary-600"
                onClick={() => navigate("/product-sets")}
              >
                查看全部 ({productSets().length})
              </button>
            </Show>
          </div>
        </Show>
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
