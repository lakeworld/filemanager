import type { RouteSectionProps } from "@solidjs/router";
import { useLocation, useNavigate } from "@solidjs/router";
import Sidebar from "~/components/Sidebar";
import Header from "~/components/Header";
import TitleBar from "~/components/TitleBar";
import GlobalDropOverlay from "~/components/GlobalDropOverlay";
import FilePreviewModal from "~/components/FilePreviewModal";
import { loadCurrentWorkspace, loadWorkspaces, setFileBrowserRefreshTrigger } from "~/stores/workspace";
import { loadTagDefs } from "~/stores/tags";
import { loadAccountStatus, subscribeAccountEvents } from "~/stores/account";
import { closePreview } from "~/stores/preview";
import { banner, showCertReminder } from "~/stores/notifyBanner";
import { onMount, createSignal, createEffect, onCleanup, Show } from "solid-js";
import type { WindowPrepareHideMessage } from "../../shared/types";

function FramelessResizer() {
  const [resizing, setResizing] = createSignal(false);
  const [direction, setDirection] = createSignal("");
  const [startX, setStartX] = createSignal(0);
  const [startY, setStartY] = createSignal(0);
  const [startWidth, setStartWidth] = createSignal(0);
  const [startHeight, setStartHeight] = createSignal(0);
  const [startPosX, setStartPosX] = createSignal(0);
  const [startPosY, setStartPosY] = createSignal(0);
  const [pending, setPending] = createSignal(false);

  const minWidth = 1024;
  const minHeight = 720;

  const handleMouseDown = async (e: MouseEvent, dir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    setDirection(dir);
    setStartX(e.clientX);
    setStartY(e.clientY);
    const size = (await window.qihebox.window.getSize()) as { w: number; h: number };
    const pos = (await window.qihebox.window.getPosition()) as { x: number; y: number };
    setStartWidth(size.w);
    setStartHeight(size.h);
    setStartPosX(pos.x);
    setStartPosY(pos.y);
    document.body.style.userSelect = "none";
  };

  const applyResize = (e: MouseEvent) => {
    const dx = e.clientX - startX();
    const dy = e.clientY - startY();
    const dir = direction();

    let targetW = startWidth();
    let targetH = startHeight();
    if (dir.includes("e")) targetW = startWidth() + dx;
    if (dir.includes("w")) targetW = startWidth() - dx;
    if (dir.includes("s")) targetH = startHeight() + dy;
    if (dir.includes("n")) targetH = startHeight() - dy;

    const newWidth = Math.max(minWidth, targetW);
    const newHeight = Math.max(minHeight, targetH);

    // Compute position based on actual clamped size change, not raw mouse delta.
    let newX = startPosX();
    let newY = startPosY();
    if (dir.includes("w")) {
      newX = startPosX() + (startWidth() - newWidth);
    }
    if (dir.includes("n")) {
      newY = startPosY() + (startHeight() - newHeight);
    }

    window.qihebox.window.setSize(newWidth, newHeight);
    if (dir.includes("w") || dir.includes("n")) {
      window.qihebox.window.setPosition(newX, newY);
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!resizing()) return;
    if (pending()) return;
    setPending(true);
    requestAnimationFrame(() => {
      applyResize(e);
      setPending(false);
    });
  };

  const handleMouseUp = () => {
    setResizing(false);
    setDirection("");
    document.body.style.userSelect = "";
  };

  onMount(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  });

  onCleanup(() => {
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
  });

  const edgeClass = (cursor: string, pos: string) =>
    `absolute ${pos} z-50 ${cursor}`;

  return (
    <>
      {/* Top edge - starts below the title bar to avoid drag conflicts */}
      <div
        class={edgeClass("cursor-n-resize", "top-9 left-4 right-4 h-1")}
        style={{ "-webkit-app-region": "no-drag" }}
        onMouseDown={(e) => handleMouseDown(e, "n")}
      />
      {/* Bottom edge */}
      <div
        class={edgeClass("cursor-s-resize", "bottom-0 left-4 right-4 h-1")}
        style={{ "-webkit-app-region": "no-drag" }}
        onMouseDown={(e) => handleMouseDown(e, "s")}
      />
      {/* Left edge */}
      <div
        class={edgeClass("cursor-w-resize", "left-0 top-9 bottom-4 w-1")}
        style={{ "-webkit-app-region": "no-drag" }}
        onMouseDown={(e) => handleMouseDown(e, "w")}
      />
      {/* Right edge */}
      <div
        class={edgeClass("cursor-e-resize", "right-0 top-9 bottom-4 w-1")}
        style={{ "-webkit-app-region": "no-drag" }}
        onMouseDown={(e) => handleMouseDown(e, "e")}
      />
      {/* Top-left corner */}
      <div
        class={edgeClass("cursor-nw-resize", "top-9 left-0 w-4 h-4")}
        style={{ "-webkit-app-region": "no-drag" }}
        onMouseDown={(e) => handleMouseDown(e, "nw")}
      />
      {/* Top-right corner */}
      <div
        class={edgeClass("cursor-ne-resize", "top-9 right-0 w-4 h-4")}
        style={{ "-webkit-app-region": "no-drag" }}
        onMouseDown={(e) => handleMouseDown(e, "ne")}
      />
      {/* Bottom-left corner */}
      <div
        class={edgeClass("cursor-sw-resize", "bottom-0 left-0 w-4 h-4")}
        style={{ "-webkit-app-region": "no-drag" }}
        onMouseDown={(e) => handleMouseDown(e, "sw")}
      />
      {/* Bottom-right corner */}
      <div
        class={edgeClass("cursor-se-resize", "bottom-0 right-0 w-4 h-4")}
        style={{ "-webkit-app-region": "no-drag" }}
        onMouseDown={(e) => handleMouseDown(e, "se")}
      />
    </>
  );
}

export default function App(props: RouteSectionProps) {
  let unsubImport: (() => void) | null = null;
  let unsubCertReminder: (() => void) | null = null;
  let unsubRestored: (() => void) | null = null;
  let unsubSessionExpired: (() => void) | null = null;
  let unsubPrepareHide: (() => void) | null = null;
  // v2.5.3 常驻轻壳：parked=true 时业务层条件卸载（路由/预览/拖放/缩放器），仅保留轻壳骨架
  const [parked, setParked] = createSignal(false);
  const location = useLocation();
  const navigate = useNavigate();

  // v2.3.0：路由持久化——窗口重建（崩溃自愈 reload / 重启）后回到原页面（localStorage 跨会话存活）
  createEffect(() => {
    const path = location.pathname;
    if (path) localStorage.setItem("qihebox:lastRoute", path);
  });

  // v2.5.3（T7）：路由切换时关闭预览——离开文件页后旧预览上下文/闭包不滞留；
  // store 内代际守卫同步递增，未完成的迟到请求也不会再把弹窗拉起
  createEffect(() => {
    void location.pathname;
    closePreview();
  });

  onMount(() => {
    loadCurrentWorkspace();
    loadWorkspaces();
    loadTagDefs(); // 全局加载标签颜色定义
    // v2.5.1 登录增强（T1/D1）：启动恢复登录态（幂等，失败静默；不阻塞关键路径）
    void loadAccountStatus();

    // v2.3.0：恢复上次所在页面（首次启动/窗口重建均生效）
    const last = localStorage.getItem("qihebox:lastRoute");
    if (last && last !== location.pathname) {
      navigate(last, { replace: true });
    }

    // v2.5.3 常驻轻壳：Blink 图像解码缓存清理统一在 prepare-hide（隐藏到托盘时）执行；
    // 原 v2.2.1 隐藏清理 + v2.3.0 失焦 30s / visibilitychange 双旁路删除——三路清缓存
    // 在同一隐藏动作收敛，避免多路径竞态与「失焦即清缓存」的无谓重解码（设计 §4.2）。
    // 冷启动双闸门：首帧渲染后上报 first-frame-ack（generation=1，主进程 starting 态齐备后首次 show）
    // 注：用 setTimeout(0) 而非 rAF——隐藏窗口下 Chromium 按 vsync 节流 rAF（backgroundThrottling(false)
    // 只解定时器），崩溃 reload 后新渲染进程 rAF 几乎不触发 → ACK 永不到达（L2 恢复链死循环，2026-08-18 定案）
    setTimeout(() => {
      setTimeout(() => {
        void window.qihebox.windowLifecycle.firstFrame(1).catch(() => {});
      }, 0);
    }, 0);

    // Listen for import completion events from the main process
    unsubImport = window.qihebox.events.on("import:complete", (data: any) => {
      if (data && data.success) {
        setFileBrowserRefreshTrigger((k: number) => k + 1);
      }
    });

    // v2.4.2（C3）：证书到期提醒降级横幅（系统通知不可用时由主进程发 cert:expiring）
    unsubCertReminder = window.qihebox.events.on("cert:expiring", (data: any) => {
      if (Array.isArray(data) && data.length > 0) showCertReminder(data);
    });

    // v2.4.9（打磨）+ v2.5.3 常驻轻壳：托盘/激活恢复 → 恢复业务层 + 回仪表盘
    // （主进程 show 成功后发 window:restored 带 generation；用户反馈：托盘打开固定看首页）。
    // 注意：navigate('/') 会触发下方 createEffect 把 lastRoute 写成 '/',污染 v2.3.0 的
    // 「冷启动恢复上次页面」——先记住旧路径，导航后写回，托盘恢复只改显示不改持久化。
    unsubRestored = window.qihebox.events.on("window:restored", () => {
      setParked(false); // 恢复业务层（路由/拖放/缩放器/预览异步重挂）
      const prev = localStorage.getItem("qihebox:lastRoute");
      navigate("/", { replace: true });
      if (prev && prev !== "/") localStorage.setItem("qihebox:lastRoute", prev);
    });

    // v2.5.3（P1-6）：心跳 401 会话过期 → 过期态即时传导 UI（Profile 过期横幅无需等重启）
    unsubSessionExpired = subscribeAccountEvents();

    // v2.5.3 常驻轻壳（设计 §4.2）：隐藏卸载重资源（2026-08-19 热修：FrameWitness/prepare-show
    // 随隐藏预检链删除——恢复改主进程直接 show + 显示后白屏自检，渲染层无需配合）
    unsubPrepareHide = window.qihebox.windowLifecycle.onPrepareHide((msg: WindowPrepareHideMessage) => {
      closePreview(); // 卸载预览重资源
      setParked(true); // 卸载业务层（路由/拖放/缩放器/预览），保留轻壳骨架
      window.qihebox.clearCache(); // 清 Blink 图像解码缓存
      // 上报 parked-ack（generation 原样回传，主进程校验归属）
      void window.qihebox.windowLifecycle.parked(msg.generation).catch(() => {});
    });

    onCleanup(() => {
      unsubImport?.();
      unsubCertReminder?.();
      unsubRestored?.();
      unsubSessionExpired?.();
      unsubPrepareHide?.();
    });
  });

  return (
    <div class="h-screen w-screen flex flex-col overflow-hidden bg-surface-50 relative">
      <TitleBar />
      {/* v2.4.2（C3）：证书到期提醒降级横幅；v2.4.3（F8）：通用 toast 按 tone 着色（success 绿 / error 红 / info 蓝），
          证书提醒 tone=error 保持红色 15s 行为不变 */}
      <Show when={banner()}>
        <div
          class={`fixed top-14 left-1/2 -translate-x-1/2 z-[60] rounded-lg px-4 py-3 text-sm shadow-lg max-w-xl ${
            banner()!.tone === "success"
              ? "bg-success-50 border border-success-200 text-success-700"
              : banner()!.tone === "info"
                ? "bg-info-50 border border-info-200 text-info-700"
                : "bg-danger-50 border border-danger-200 text-danger-700"
          }`}
        >
          <div class="font-semibold mb-0.5">{banner()!.title}</div>
          {banner()!.body && <div>{banner()!.body}</div>}
        </div>
      </Show>
      <Header />
      <div class="flex-1 flex overflow-hidden">
        <Sidebar />
        {/* v2.5.3 常驻轻壳：parked（隐藏到托盘）时业务层条件卸载——路由/拖放/缩放器/预览
            全部卸载，仅保留骨架（TitleBar/Header/Sidebar）——重资源（大列表/预览上下文）不滞留。
            恢复（restored）后重新挂载业务路由。 */}
        <Show when={!parked()}>
          <main class="flex-1 overflow-y-auto relative">{props.children}</main>
        </Show>
        <Show when={parked()}>
          <main class="flex-1 overflow-hidden bg-surface-50 relative" />
        </Show>
      </div>
      <Show when={!parked()}>
        <GlobalDropOverlay />
        <FramelessResizer />
        <FilePreviewModal />
      </Show>
    </div>
  );
}
