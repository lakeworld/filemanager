import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useParams } from "@solidjs/router";
import { api } from "~/wails/api";
import { OnFileDrop, OnFileDropOff, EventsOn, EventsOff } from "~/wailsjs/runtime/runtime";
import { currentWorkspace, productSets, loadProductSets, workspaceConfig, setFileBrowserRefreshTrigger } from "~/stores/workspace";
import type { ApiResult, FileEntry } from "~/types";

export default function GlobalDropOverlay() {
  const params = useParams();
  const [isDragOver, setIsDragOver] = createSignal(false);
  const [showDialog, setShowDialog] = createSignal(false);
  const [paths, setPaths] = createSignal<string[]>([]);
  const [selectedProductSet, setSelectedProductSet] = createSignal("");
  const [targetType, setTargetType] = createSignal<"image" | "cert">("image");
  const [subFolder, setSubFolder] = createSignal("");
  const [importStatus, setImportStatus] = createSignal<"idle" | "importing" | "done" | "error">("idle");
  const [importError, setImportError] = createSignal("");

  createEffect(() => {
    if (currentWorkspace()) {
      loadProductSets();
    }
  });

  const imageFolders = () => workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"];
  const certFolders = () => workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"];

  const decodedProductSet = () => {
    try { return decodeURIComponent(params.productSet || ""); } catch { return params.productSet || ""; }
  };
  const decodedSubFolder = () => {
    try { return decodeURIComponent(params.subFolder || ""); } catch { return params.subFolder || ""; }
  };

  const handleDialogImport = async () => {
    const ps = selectedProductSet();
    const type = targetType();
    const folder = subFolder();
    if (!ps || !folder) return;

    setImportError("");
    setImportStatus("importing");
    setShowDialog(false);

    try {
      const result = await api.files.import({
        source_paths: paths(),
        target_product_set: ps,
        target_folder: folder,
        target_type: type,
        sub_folder: folder,
      });
      if (!result.success) {
        setImportError(result.error || "导入失败");
        setImportStatus("error");
      }
    } catch (err) {
      setImportError(String(err));
      setImportStatus("error");
    }

    setPaths([]);
    setSelectedProductSet("");
    setSubFolder("");
  };

  const handleDirectImport = async (dropPaths: string[]) => {
    const ps = decodedProductSet();
    const folder = decodedSubFolder();
    const type = params.type as "image" | "cert";

    console.log("[GlobalDropOverlay] direct import", {
      ps,
      folder,
      type,
      paths: dropPaths,
      rawParams: { ...params },
    });
    if (!ps || !folder) {
      console.warn("[GlobalDropOverlay] missing product set or folder, aborting direct import");
      setImportError("缺少产品集或子文件夹信息");
      setImportStatus("error");
      return;
    }

    setImportError("");
    setImportStatus("importing");

    try {
      const result = await api.files.import({
        source_paths: dropPaths,
        target_product_set: ps,
        target_folder: folder,
        target_type: type,
        sub_folder: folder,
      });
      console.log("[GlobalDropOverlay] import API result", result);
      if (!result.success) {
        console.error("[GlobalDropOverlay] import API error", result.error);
        setImportError(result.error || "导入失败");
        setImportStatus("error");
      }
    } catch (err) {
      console.error("[GlobalDropOverlay] import exception", err);
      setImportError(String(err));
      setImportStatus("error");
    }
  };

  // Listen for import completion events from Go
  onMount(() => {
    EventsOn("import:complete", (data: any) => {
      console.log("[GlobalDropOverlay] import:complete", data);
      if (data && data.success) {
        setImportStatus("done");
        setFileBrowserRefreshTrigger((k) => k + 1);
      } else {
        console.error("[GlobalDropOverlay] import failed", data);
        setImportError(data?.error || "导入失败");
        setImportStatus("error");
      }
      // Clear status after 3 seconds
      setTimeout(() => setImportStatus("idle"), 3000);
    });
  });

  onCleanup(() => {
    EventsOff("import:complete");
  });

  // Attach global drag listeners and OnFileDrop once on mount.
  // Using onMount instead of createEffect avoids re-registering listeners when
  // route params change, which could cause missed drop events.
  onMount(() => {
    let hideTimeout: number | undefined;

    const isFileDrag = (e: DragEvent) =>
      e.dataTransfer?.types.includes("Files") ?? false;

    const clearHideTimeout = () => {
      if (hideTimeout !== undefined) {
        window.clearTimeout(hideTimeout);
        hideTimeout = undefined;
      }
    };

    const showOverlay = () => {
      clearHideTimeout();
      setIsDragOver(true);
      // Safety net: if a drag event sequence gets stuck (e.g. WebView2 doesn't fire drop/leave),
      // auto-hide the overlay after 5 seconds.
      hideTimeout = window.setTimeout(() => {
        setIsDragOver(false);
      }, 5000);
    };

    const hideOverlay = () => {
      clearHideTimeout();
      setIsDragOver(false);
    };

    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      showOverlay();
    };

    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      showOverlay();
    };

    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // relatedTarget === null means the drag is leaving the window entirely.
      if (e.relatedTarget === null) {
        hideOverlay();
      }
    };

    const onDrop = (e: DragEvent) => {
      if (isFileDrag(e)) {
        e.preventDefault();
      }
      hideOverlay();
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    // useDropTarget=false: 在窗口任意位置释放文件都触发回调，不需要特定元素带 --wails-drop-target 样式。
    // 之前传 true 导致没有 drop target 元素时 OnFileDrop 永远不触发，覆盖层就卡住了。
    OnFileDrop((_x, _y, dropPaths) => {
      console.log("[GlobalDropOverlay] OnFileDrop", { paths: dropPaths, params: { ...params } });
      hideOverlay();
      if (dropPaths.length === 0) return;
      // 必须异步触发，避免在 WebView 事件循环中直接调用 Go 绑定导致卡死
      setTimeout(() => {
        if (params.productSet && params.subFolder) {
          console.log("[GlobalDropOverlay] taking direct import path");
          handleDirectImport(dropPaths);
        } else {
          console.log("[GlobalDropOverlay] taking dialog path");
          setPaths(dropPaths);
          setShowDialog(true);
        }
      }, 0);
    }, false);

    onCleanup(() => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      clearHideTimeout();
      OnFileDropOff();
    });
  });

  return (
    <>
      <Show when={isDragOver()}>
        <div class="fixed inset-0 bg-primary-500/10 backdrop-blur-sm z-40 flex items-center justify-center border-4 border-primary-500 border-dashed m-4 rounded-3xl">
          <div class="text-center">
            <div class="text-6xl mb-4">📥</div>
            <h2 class="text-2xl font-bold text-primary-700">释放以导入文件</h2>
            <p class="text-surface-500 mt-2">将文件拖放到产品集文件浏览器中可快速导入</p>
          </div>
        </div>
      </Show>

      <Show when={importStatus() === "importing"}>
        <div class="fixed bottom-4 right-4 z-50 bg-primary-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
          <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          <span>正在导入...</span>
        </div>
      </Show>

      <Show when={importStatus() === "done"}>
        <div class="fixed bottom-4 right-4 z-50 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg">
          导入完成
        </div>
      </Show>

      <Show when={importStatus() === "error"}>
        <div class="fixed bottom-4 right-4 z-50 bg-red-600 text-white px-4 py-2 rounded-lg shadow-lg max-w-md">
          <div class="font-medium">导入失败</div>
          <Show when={importError()}>
            <div class="text-xs mt-1 opacity-90">{importError()}</div>
          </Show>
        </div>
      </Show>

      <Show when={showDialog()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDialog(false)}>
          <div class="bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 class="text-xl font-bold mb-4">选择导入目标</h2>

            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">产品集</label>
                <select
                  class="w-full px-3 py-2 border border-surface-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  value={selectedProductSet()}
                  onChange={(e) => {
                    setSelectedProductSet(e.currentTarget.value);
                  }}
                >
                  <option value="">选择产品集</option>
                  <For each={productSets()}>
                    {(ps) => <option value={ps.name}>{ps.name}</option>}
                  </For>
                </select>
              </div>

              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">目标类型</label>
                <div class="flex bg-surface-100 rounded-lg p-1">
                  <button
                    class={`flex-1 py-2 text-sm rounded-md transition-colors ${targetType() === "image" ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500"}`}
                    onClick={() => {
                      setTargetType("image");
                      setSubFolder(imageFolders()[0]);
                    }}
                  >
                    🖼️ 图包
                  </button>
                  <button
                    class={`flex-1 py-2 text-sm rounded-md transition-colors ${targetType() === "cert" ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500"}`}
                    onClick={() => {
                      setTargetType("cert");
                      setSubFolder(certFolders()[0]);
                    }}
                  >
                    📜 证书
                  </button>
                </div>
              </div>

              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">子文件夹</label>
                <div class="flex bg-surface-100 rounded-lg p-1 flex-wrap gap-1">
                  <For each={targetType() === "image" ? imageFolders() : certFolders()}>
                    {(folder) => (
                      <button
                        class={`px-4 py-2 text-sm rounded-md transition-colors ${subFolder() === folder ? "bg-white shadow-sm text-surface-900 font-medium" : "text-surface-500"}`}
                        onClick={() => setSubFolder(folder)}
                      >
                        {folder}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>

            <div class="flex gap-3 justify-end mt-6">
              <button class="btn-secondary" onClick={() => setShowDialog(false)}>
                取消
              </button>
              <button
                class="btn-primary"
                onClick={handleDialogImport}
                disabled={!selectedProductSet() || !subFolder()}
              >
                导入 {paths().length} 个文件
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
