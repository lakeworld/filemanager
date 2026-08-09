import type { RouteSectionProps } from "@solidjs/router";
import { useLocation, useNavigate } from "@solidjs/router";
import Sidebar from "~/components/Sidebar";
import Header from "~/components/Header";
import TitleBar from "~/components/TitleBar";
import GlobalDropOverlay from "~/components/GlobalDropOverlay";
import FilePreviewModal from "~/components/FilePreviewModal";
import { loadCurrentWorkspace, loadWorkspaces, setFileBrowserRefreshTrigger } from "~/stores/workspace";
import { loadTagDefs } from "~/stores/tags";
import { banner, showCertReminder } from "~/stores/notifyBanner";
import { onMount, createSignal, createEffect, onCleanup, Show } from "solid-js";

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
  const location = useLocation();
  const navigate = useNavigate();

  // v2.3.0：路由持久化——休眠销毁窗口重建后回到原页面（localStorage 跨会话存活）
  createEffect(() => {
    const path = location.pathname;
    if (path) localStorage.setItem("qihebox:lastRoute", path);
  });

  onMount(() => {
    loadCurrentWorkspace();
    loadWorkspaces();
    loadTagDefs(); // 全局加载标签颜色定义

    // v2.3.0：恢复上次所在页面（首次启动/窗口重建均生效）
    const last = localStorage.getItem("qihebox:lastRoute");
    if (last && last !== location.pathname) {
      navigate(last, { replace: true });
    }

    // v2.2.1：窗口隐藏（托盘常驻）时清理 Blink 图像解码缓存，回收内存
    // v2.3.0 第一层：失焦 30 秒后同样清理（用户短暂离开即回收，回来重新解码）
    let blurTimer: number | undefined;
    const onBlur = () => {
      window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(() => {
        window.qihebox.clearCache();
      }, 30_000);
    };
    const onFocus = () => window.clearTimeout(blurTimer);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.qihebox.clearCache();
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

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

    onCleanup(() => {
      window.clearTimeout(blurTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubImport?.();
      unsubCertReminder?.();
    });
  });

  return (
    <div class="h-screen w-screen flex flex-col overflow-hidden bg-surface-50 relative">
      <TitleBar />
      {/* v2.4.2（C3）：证书到期提醒降级横幅（系统通知不可用时；15s 自动消失） */}
      <Show when={banner()}>
        <div class="fixed top-14 left-1/2 -translate-x-1/2 z-[60] bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 shadow-lg max-w-xl">
          <div class="font-semibold mb-0.5">{banner()!.title}</div>
          <div>{banner()!.body}</div>
        </div>
      </Show>
      <Header />
      <div class="flex-1 flex overflow-hidden">
        <Sidebar />
        <main class="flex-1 overflow-y-auto relative">
          {props.children}
        </main>
      </div>
      <GlobalDropOverlay />
      <FramelessResizer />
      <FilePreviewModal />
    </div>
  );
}
