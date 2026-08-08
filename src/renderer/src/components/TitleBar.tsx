import { createSignal, onMount } from "solid-js";
import { api } from "~/wails/api";
import Logo from "./Logo";

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = createSignal(false);

  onMount(async () => {
    try {
      setIsMaximized(await api.window.isMaximised());
    } catch {
      // ignore
    }
  });

  const handleMinimize = () => api.window.minimize();
  const handleToggleMaximize = async () => {
    await api.window.toggleMaximize();
    try {
      setIsMaximized(await api.window.isMaximised());
    } catch {
      // ignore
    }
  };
  const handleClose = () => api.window.hideToTray();

  return (
    <div
      class="h-9 flex items-center justify-between select-none bg-surface-0/90 backdrop-blur border-b border-surface-200"
      style={{ "-webkit-app-region": "drag" } as any}
    >
      {/* Draggable title region */}
      <div class="flex-1 h-full flex items-center gap-2 px-3">
        <Logo class="w-5 h-5 pointer-events-none" />
        <span class="text-sm font-medium text-surface-700 pointer-events-none">
          启禾文件管理
        </span>
      </div>

      {/* Window controls - no drag */}
      <div class="flex items-center h-full" style={{ "-webkit-app-region": "no-drag" } as any}>
        <button
          class="h-full w-11 flex items-center justify-center text-surface-500 hover:bg-surface-200 transition-colors"
          onClick={handleMinimize}
          title="最小化"
          style={{ "-webkit-app-region": "no-drag" } as any}
        >
          <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="currentColor">
            <rect x="2" y="11" width="20" height="2" rx="1" />
          </svg>
        </button>
        <button
          class="h-full w-11 flex items-center justify-center text-surface-500 hover:bg-surface-200 transition-colors"
          onClick={handleToggleMaximize}
          title={isMaximized() ? "还原" : "最大化"}
          style={{ "-webkit-app-region": "no-drag" } as any}
        >
          <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            {isMaximized() ? (
              <>
                <rect x="5" y="9" width="10" height="10" rx="1" />
                <path d="M19 5H9v10" />
              </>
            ) : (
              <rect x="3" y="3" width="18" height="18" rx="1" />
            )}
          </svg>
        </button>
        <button
          class="h-full w-11 flex items-center justify-center text-surface-500 hover:bg-red-500 hover:text-white transition-colors"
          onClick={handleClose}
          title="关闭到托盘"
          style={{ "-webkit-app-region": "no-drag" } as any}
        >
          <svg class="w-3.5 h-3.5 pointer-events-none" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 1 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
