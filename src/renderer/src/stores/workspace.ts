import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import type {
  ApiResult,
  WorkspaceInfo,
  WorkspaceConfig,
  NamingTemplate,
  ProductSetInfo,
} from "~/types";

export const [currentWorkspace, setCurrentWorkspace] = createSignal<WorkspaceInfo | null>(null);
export const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
export const [productSets, setProductSets] = createSignal<ProductSetInfo[]>([]);
// v2.5.3（P2-13）：产品集首载 loading——初值 true 兜住挂载后首个渲染 tick（页面侧自带 loading 信号时也可不用）
export const [productSetsLoading, setProductSetsLoading] = createSignal(true);
export const [selectedProductSet, setSelectedProductSet] = createSignal<string>("");
export const [workspaceConfig, setWorkspaceConfig] = createSignal<WorkspaceConfig | null>(null);
export const [fileBrowserRefreshTrigger, setFileBrowserRefreshTrigger] = createSignal(0);

// v2.5.3（P2-13）：产品集加载序号（模块级）——切工作区/并发调用时过期结果丢弃（照 Certs certLoadSeq 先例）
let productSetsLoadSeq = 0;

export async function loadWorkspaces() {
  const result = await api.workspace.list();
  if (result.success && result.data) {
    setWorkspaces(result.data);
  }
}

export async function loadCurrentWorkspace() {
  const result = await api.workspace.current();
  if (result.success) {
    setCurrentWorkspace(result.data);
    if (result.data) {
      await loadWorkspaceConfig();
    }
  }
}

export async function createWorkspace(path: string) {
  const result = await api.workspace.create(path);
  if (result.success && result.data) {
    setCurrentWorkspace(result.data);
    await loadWorkspaces();
    await loadWorkspaceConfig();
    return true;
  }
  return false;
}

export async function openWorkspace(path: string) {
  const result = await api.workspace.open(path);
  if (result.success && result.data) {
    setCurrentWorkspace(result.data);
    await loadWorkspaces();
    await loadWorkspaceConfig();
    return true;
  }
  return false;
}

export async function switchWorkspace(path: string) {
  const result = await api.workspace.switch(path);
  if (result.success && result.data) {
    setCurrentWorkspace(result.data);
    await loadWorkspaceConfig();
    return true;
  }
  return false;
}

export async function loadProductSets() {
  const s = ++productSetsLoadSeq;
  setProductSetsLoading(true);
  try {
    const result = await api.productSets.list();
    if (s !== productSetsLoadSeq) return;
    if (result.success && result.data) {
      setProductSets(result.data);
    }
  } finally {
    // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
    if (s === productSetsLoadSeq) setProductSetsLoading(false);
  }
}

export async function loadWorkspaceConfig() {
  const result = await api.config.get();
  if (result.success && result.data) {
    setWorkspaceConfig(result.data);
  } else {
    setWorkspaceConfig(null);
  }
}

export async function updateWorkspaceConfig(config: WorkspaceConfig) {
  const result = await api.config.update(config);
  if (result.success && result.data) {
    setWorkspaceConfig(result.data);
    return true;
  }
  return false;
}

export function defaultNamingTemplate(): NamingTemplate {
  return {
    product_set_prefix: "",
    product_set_suffix: "",
    sku_separator: "_",
    // v2.4.9 S5：默认模板 4 字段（sequence 编号槽位；与主进程 paths.ts defaultNamingTemplate 双处一致）
    sku_fields: ["product_set", "sub_folder", "original_name", "sequence"],
    conflict_suffix: "_{n}",
  };
}

export function defaultWorkspaceConfig(): WorkspaceConfig {
  return {
    name: "Workspace",
    naming_template: defaultNamingTemplate(),
    image_subfolders: ["主图", "详情页", "白底图", "素材"],
    cert_subfolders: ["3C", "质检", "专利"],
    // v2.4.7：客户子文件夹默认集（与主进程 loadConfig 兜底默认值对齐，PLAN §3.6）
    customer_subfolders: ["报价", "合同", "沟通", "其他"],
  };
}
