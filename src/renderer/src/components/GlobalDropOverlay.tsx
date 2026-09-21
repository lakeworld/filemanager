import { Show, For, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useParams } from "@solidjs/router";
import { api } from "~/wails/api";
import { showToast } from "~/stores/notifyBanner";
import SearchSelect from "~/components/ui/SearchSelect";
import { isInternalDragActive, clearInternalDrag, getInternalDragPaths } from "~/utils/dragout";
import { currentWorkspace, productSets, loadProductSets, workspaceConfig, setFileBrowserRefreshTrigger } from "~/stores/workspace";
import type { ApiResult, CustomerInfo, SupplierInfo, FileEntry, DedupItem } from "~/types";

export default function GlobalDropOverlay() {
  const params = useParams();
  const [isDragOver, setIsDragOver] = createSignal(false);
  const [showDialog, setShowDialog] = createSignal(false);
  const [paths, setPaths] = createSignal<string[]>([]);
  const [selectedProductSet, setSelectedProductSet] = createSignal("");
  // v2.4.7：导入目标分组加「客户」（PLAN §5.2）；v2.4.9 S2：加「供应商」（固定子文件夹集）
  const [targetType, setTargetType] = createSignal<"image" | "cert" | "customer" | "supplier">("image");
  const [subFolder, setSubFolder] = createSignal("");
  const [importStatus, setImportStatus] = createSignal<"idle" | "importing" | "done" | "error" | "cancelled">("idle");
  const [importError, setImportError] = createSignal("");
  // v2.3.0：批量导入进度 + 取消
  const [importProgress, setImportProgress] = createSignal<{ done: number; total: number } | null>(null);
  const [cancelToken, setCancelToken] = createSignal<string | null>(null);
  // v2.4.7：客户列表（导入目标选择器「客户」分组用；api.clients 门面由并行 IPC 代理产出）
  const [customers, setCustomers] = createSignal<CustomerInfo[]>([]);
  // v2.4.9 S2：供应商列表（导入目标选择器「供应商」分组用）
  const [suppliers, setSuppliers] = createSignal<SupplierInfo[]>([]);

  const loadCustomers = async () => {
    const result = await api.clients.list();
    if (result.success && result.data) {
      setCustomers(result.data);
    }
  };

  const loadSuppliers = async () => {
    const result = await api.suppliers.list();
    if (result.success && result.data) {
      setSuppliers(result.data);
    }
  };

  createEffect(() => {
    if (currentWorkspace()) {
      loadProductSets();
      loadCustomers();
      loadSuppliers();
    }
  });

  const imageFolders = () => workspaceConfig()?.image_subfolders || ["主图", "详情页", "白底图", "素材"];
  const certFolders = () => workspaceConfig()?.cert_subfolders || ["3C", "质检", "专利"];
  // v2.4.7：客户子文件夹默认集（config.customer_subfolders，旧 config 缺省合并默认值）
  const customerFolders = () => workspaceConfig()?.customer_subfolders || ["报价", "合同", "沟通", "其他"];
  // v2.4.9 S2：供应商子文件夹默认集（v2.5.5 起可配置，config.supplier_subfolders 缺省兜底默认集）
  const supplierFolders = () => workspaceConfig()?.supplier_subfolders || ["合同", "对账单", "往来文件"];

  const decodedProductSet = () => {
    try { return decodeURIComponent(params.productSet || ""); } catch { return params.productSet || ""; }
  };
  const decodedSubFolder = () => {
    try { return decodeURIComponent(params.subFolder || ""); } catch { return params.subFolder || ""; }
  };

  /**
   * v2.5.9（A9 刀1d）：导入目标的子文件夹按**选中实体盘上实际有的**列。
   * 旧行为是拿全站那一张模板表列一遍 ⇒ 用户在某个产品集里手工建的目录，拖进来时根本选不到；
   * 没选实体之前仍显示模板那份（否则下拉是空的，用户不知道该选什么）。
   */
  const [diskTargetFolders, setDiskTargetFolders] = createSignal<string[] | null>(null);
  createEffect(() => {
    const ps = selectedProductSet();
    const type = targetType();
    if (!ps || (type !== "image" && type !== "cert")) {
      setDiskTargetFolders(null);
      return;
    }
    void (async () => {
      const r = await api.files.listSubfolders({
        product_set: ps,
        file_type: type === "image" ? "image" : "cert",
        scope: "productSet",
      });
      setDiskTargetFolders(
        r.success ? (r.data ?? []).map((e) => e.name).sort((a, b) => a.localeCompare(b, "zh")) : [],
      );
    })();
  });
  const targetFolders = (): string[] =>
    diskTargetFolders() ??
    (targetType() === "image"
      ? imageFolders()
      : targetType() === "cert"
        ? certFolders()
        : targetType() === "supplier"
          ? supplierFolders()
          : customerFolders());

  const handleDialogImport = async () => {
    const ps = selectedProductSet();
    const type = targetType();
    const folder = subFolder();
    if (!ps || !folder) return;

    setImportError("");
    setImportStatus("importing");
    setShowDialog(false);
    setImportProgress(null);
    const token = crypto.randomUUID();
    setCancelToken(token);

    try {
      // v2.4.7：客户分组导入走 scope='customer'；v2.4.9 S2：供应商分组走 scope='supplier'
      // （target_product_set 槽位承载实体名，file_type 忽略）
      const result = await api.files.import({
        source_paths: paths(),
        target_product_set: ps,
        target_folder: folder,
        target_type: type,
        sub_folder: folder,
        scope: type === "customer" ? "customer" : type === "supplier" ? "supplier" : "productSet",
        cancelToken: token,
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

    if (!ps || !folder) {
      console.warn("[GlobalDropOverlay] missing product set or folder, aborting direct import");
      setImportError("缺少产品集或子文件夹信息");
      setImportStatus("error");
      return;
    }

    setImportError("");
    setImportStatus("importing");
    setImportProgress(null);
    const token = crypto.randomUUID();
    setCancelToken(token);

    try {
      const result = await api.files.import({
        source_paths: dropPaths,
        target_product_set: ps,
        target_folder: folder,
        target_type: type,
        sub_folder: folder,
        cancelToken: token,
      });
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

  // Listen for import completion events from the main process
  let unsubImport: (() => void) | null = null;
  let unsubProgress: (() => void) | null = null;
  // v2.4.7：import:complete 置 idle 的 3s 定时器句柄——连续投递时旧 timer 不得压掉新 importing 态
  let importIdleTimer: number | undefined;
  onMount(() => {
    // v2.3.0：批量导入进度
    unsubProgress = window.qihebox.events.on("import:progress", (data: any) => {
      if (data && typeof data.done === "number" && typeof data.total === "number") {
        setImportProgress({ done: data.done, total: data.total });
      }
    });
    unsubImport = window.qihebox.events.on("import:complete", (data: any) => {
      setImportProgress(null);
      setCancelToken(null);
      if (data && data.success) {
        setImportStatus("done");
        setFileBrowserRefreshTrigger((k) => k + 1);
        // v2.5.8（D3）：去重结果 toast 汇总（skipped=同位置同内容跳过；linked=硬链接复用）
        const skipped: DedupItem[] = data.skipped ?? [];
        const linked: DedupItem[] = data.linked ?? [];
        if (skipped.length > 0 || linked.length > 0) {
          const parts = [`导入 ${data.count} 个`];
          if (linked.length > 0) parts.push(`复用已有文件 ${linked.length} 个（硬链接，不占额外空间）`);
          if (skipped.length > 0) parts.push(`跳过已存在 ${skipped.length} 个`);
          const names = [...linked, ...skipped]
            .slice(0, 4)
            .map((it) => String(it.path || "").split(/[\\/]/).pop())
            .filter(Boolean)
            .join("、");
          showToast("success", parts.join(" · "), names || undefined);
        }
      } else if (data && data.cancelled) {
        setImportStatus("cancelled");
      } else {
        console.error("[GlobalDropOverlay] import failed", data);
        setImportError(data?.error || "导入失败");
        setImportStatus("error");
      }
      // Clear status after 3 seconds（v2.4.7：句柄化；置 idle 前守卫 cancelToken——
      // 期间新导入已发起（token 被接管）则旧 timer 不再压状态，等新导入自身完成事件接管）
      window.clearTimeout(importIdleTimer);
      importIdleTimer = window.setTimeout(() => {
        if (cancelToken() === null) setImportStatus("idle");
      }, 3000);
    });
  });

  /** v2.3.0：取消导入（置位主进程取消标记，已复制文件保留） */
  const handleCancelImport = async () => {
    const token = cancelToken();
    if (!token) return;
    await api.files.importCancel(token);
    setImportStatus("cancelled");
  };

  // Attach global drag listeners once on mount.
  // Using onMount instead of createEffect avoids re-registering listeners when
  // route params change, which could cause missed drop events.
  onMount(() => {
    let hideTimeout: number | undefined;
    // v2.5.3（P2-4）：onDrop 尾部的 0ms 延迟触发句柄化——与 importIdleTimer 同例，卸载时清除
    let dropAsyncTimer: number | undefined;

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
      // 应用内 startDrag 拖出后回落窗口：不显示导入遮罩
      if (isInternalDragActive()) return;
      e.preventDefault();
      showOverlay();
    };

    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // 应用内 startDrag 拖出后回落窗口：不显示导入遮罩
      if (isInternalDragActive()) return;
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
      if (!isFileDrag(e)) {
        hideOverlay();
        return;
      }
      e.preventDefault();
      hideOverlay();

      // Electron：从 File 对象取真实路径（webUtils.getPathForFile，经 preload 暴露）
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      const dropPaths = files.map((f) => window.qihebox.getPathForFile(f));

      // 应用内 startDrag 拖出后拖回窗口：drop 路径集合与拖出路径完全一致 → 视为取消拖出，
      // 不触发导入、不弹遮罩（先各自排序后逐项比较）
      if (isInternalDragActive()) {
        const internal = getInternalDragPaths();
        const sameSet =
          internal.length === dropPaths.length &&
          [...internal].sort().join("\n") === [...dropPaths].sort().join("\n");
        if (sameSet) {
          clearInternalDrag();
          return;
        }
      }

      // 外部文件 drop 流程：顺手清残留内部标记
      clearInternalDrag();

      // 必须异步触发，避免在事件循环中直接调用导致卡顿
      dropAsyncTimer = window.setTimeout(() => {
        if (params.productSet && params.subFolder) {
          handleDirectImport(dropPaths);
        } else {
          setPaths(dropPaths);
          // v2.4.7：弹窗打开时刷新客户列表（拖入前可能新建过客户）
          void loadCustomers();
          setShowDialog(true);
        }
      }, 0);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    // 收尾轮：Esc 关闭导入目标选择弹窗（选择阶段，导入开始即关闭弹窗，无进行中冲突）
    // v2.5.8 复审 r2 A-6：本弹窗是**手搓 fixed 遮罩、没进层栈**，所以它必须认层栈的
    //   `defaultPrevented`——否则「拖进来 → 目标选择弹窗开着 → 其上再开右键菜单/下拉」时，
    //   一次 Esc 会被菜单与本监听各吃一次，两层同帧齐关。
    //   ⚠ 正解是这个弹窗本身入栈（连 :386-511 那个「选择导入目标」伪弹窗一起），但那属改版式范围，
    //   本轮按卡面只做「不再双消费」，入栈另立一批（PLAN D15）。
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return; // 层栈里的弹窗/菜单/浮层已消费这次 Esc，让位
      setShowDialog(false);
    };
    window.addEventListener("keydown", onKey);

    onCleanup(() => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKey);
      clearHideTimeout();
      window.clearTimeout(dropAsyncTimer); // v2.5.3（P2-4）：卸载时清除延后触发，防触碰已卸载组件
      window.clearTimeout(importIdleTimer);
      unsubImport?.();
      unsubProgress?.();
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
        <div class="fixed bottom-4 right-4 z-50 bg-surface-900 text-white px-4 py-3 rounded-xl shadow-lg flex flex-col gap-2 min-w-[260px]">
          <div class="flex items-center gap-2 text-sm">
            <div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <span>
              {importProgress()
                ? `正在导入... ${importProgress()!.done}/${importProgress()!.total}`
                : "正在导入..."}
            </span>
          </div>
          <div class="h-1.5 w-full bg-white/20 rounded-full overflow-hidden">
            <div
              class="h-full bg-primary-400 rounded-full transition-[width] duration-200"
              style={{
                width: importProgress()
                  ? `${Math.round((importProgress()!.done / Math.max(1, importProgress()!.total)) * 100)}%`
                  : "8%",
              }}
            />
          </div>
          <button
            class="link-btn self-end text-xs text-surface-300 hover:text-white"
            onClick={handleCancelImport}
          >
            取消导入
          </button>
        </div>
      </Show>

      <Show when={importStatus() === "cancelled"}>
        <div class="fixed bottom-4 right-4 z-50 bg-warning-600 text-white px-4 py-2 rounded-lg shadow-lg">
          已取消导入（已复制的文件保留）
        </div>
      </Show>

      <Show when={importStatus() === "done"}>
        <div class="fixed bottom-4 right-4 z-50 bg-success-600 text-white px-4 py-2 rounded-lg shadow-lg">
          导入完成
        </div>
      </Show>

      <Show when={importStatus() === "error"}>
        <div class="fixed bottom-4 right-4 z-50 bg-danger-600 text-white px-4 py-2 rounded-lg shadow-lg max-w-md">
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
                <label class="block text-sm font-medium text-surface-700 mb-1">
                  {targetType() === "customer" ? "客户" : targetType() === "supplier" ? "供应商" : "产品集"}
                </label>
                {/* v2.5.8 D9（W4 控件统一 II）：三态归属下拉（客户/供应商/产品集随 targetType 变）
                    换 SearchSelect——原来用嵌套 Show/fallback 在 option 层做三态分支，现折成
                    一个 options 三元，可读性更好且值口径一字未动（空串 = 未选）。 */}
                <SearchSelect
                  class="w-full"
                  ariaLabel={
                    targetType() === "customer"
                      ? "选择客户"
                      : targetType() === "supplier"
                        ? "选择供应商"
                        : "选择产品集"
                  }
                  options={
                    targetType() === "customer"
                      ? [{ value: "", label: "选择客户" }, ...customers().map((c) => ({ value: c.name, label: c.name }))]
                      : targetType() === "supplier"
                        ? [{ value: "", label: "选择供应商" }, ...suppliers().map((s) => ({ value: s.name, label: s.name }))]
                        : [{ value: "", label: "选择产品集" }, ...productSets().map((ps) => ({ value: ps.name, label: ps.name }))]
                  }
                  value={selectedProductSet()}
                  placeholder={
                    targetType() === "customer"
                      ? "选择客户"
                      : targetType() === "supplier"
                        ? "选择供应商"
                        : "选择产品集"
                  }
                  matchTriggerWidth={false}
                  onChange={(v) => setSelectedProductSet(v)}
                />
              </div>

              <div>
                {/* v2.5.8 D14（样式统一收口）：两组分段/药丸选择器收进 `.seg-item` / `.seg-item-on`
                    单点档（与文件区工具栏同一套材质，见 index.css；容器保留原样，不套 .seg-track——
                    档内多出的 1px 描边会把选择条整体撑高 2px，属尺寸变化）。 */}
                <label class="block text-sm font-medium text-surface-700 mb-1">目标类型</label>
                <div class="flex bg-surface-100 rounded-lg p-1">
                  <button
                    class={`seg-item flex-1 ${targetType() === "image" ? "seg-item-on" : "text-surface-500"}`}
                    onClick={() => {
                      setTargetType("image");
                      // v2.4.7：切回图包/证书时清空残留的客户选择，避免导入到 产品集/<客户名>/ 幽灵目录
                      setSelectedProductSet("");
                      setSubFolder(imageFolders()[0]);
                    }}
                  >
                    🖼️ 图包
                  </button>
                  <button
                    class={`seg-item flex-1 ${targetType() === "cert" ? "seg-item-on" : "text-surface-500"}`}
                    onClick={() => {
                      setTargetType("cert");
                      // v2.4.7：切回图包/证书时清空残留的客户选择，避免导入到 产品集/<客户名>/ 幽灵目录
                      setSelectedProductSet("");
                      setSubFolder(certFolders()[0]);
                    }}
                  >
                    📜 证书
                  </button>
                  {/* v2.4.7：客户导入分组（客户 → 子文件夹两级） */}
                  <button
                    class={`seg-item flex-1 ${targetType() === "customer" ? "seg-item-on" : "text-surface-500"}`}
                    onClick={() => {
                      setTargetType("customer");
                      setSelectedProductSet("");
                      setSubFolder(customerFolders()[0]);
                    }}
                  >
                    🤝 客户
                  </button>
                  {/* v2.4.9 S2：供应商导入分组（固定子文件夹集） */}
                  <button
                    class={`seg-item flex-1 ${targetType() === "supplier" ? "seg-item-on" : "text-surface-500"}`}
                    onClick={() => {
                      setTargetType("supplier");
                      setSelectedProductSet("");
                      setSubFolder(supplierFolders()[0]);
                    }}
                  >
                    🏭 供应商
                  </button>
                </div>
              </div>

              <div>
                <label class="block text-sm font-medium text-surface-700 mb-1">子文件夹</label>
                <div class="flex bg-surface-100 rounded-lg p-1 flex-wrap gap-1">
                  <For each={targetFolders()}>
                    {(folder) => (
                      <button
                        class={`seg-item ${subFolder() === folder ? "seg-item-on" : "text-surface-500"}`}
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
