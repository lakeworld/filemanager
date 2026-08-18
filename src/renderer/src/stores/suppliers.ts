/**
 * 供应商 store（v2.4.9 S2）：供应商/ 目录 × suppliers.json 档案合并结果的信号与加载。
 * 变更操作（create/update/rename/delete）由页面直调 api.suppliers.*（服务端名称校验 /
 * 建固定子文件夹集 / 回收站编排），成功后在页面侧调用 loadSuppliers() 刷新——
 * 仿 stores/clients.ts（客户范式）。
 */
import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import type { SupplierInfo } from "~/types";

/** 供应商列表（按名称排序；目录扫描为实、JSON 为档案） */
export const [suppliers, setSuppliers] = createSignal<SupplierInfo[]>([]);
// v2.5.3（P2-5/P2-13）：首载 loading——列表页空态不闪现；初值 true 兜住挂载后首个渲染 tick
export const [suppliersLoading, setSuppliersLoading] = createSignal(true);

// v2.5.3（P2-13）：模块级加载序号——切工作区/并发调用时过期结果丢弃（照 Certs certLoadSeq 先例）
let loadSeq = 0;

export async function loadSuppliers(): Promise<void> {
  const s = ++loadSeq;
  setSuppliersLoading(true);
  try {
    const result = await api.suppliers.list();
    if (s !== loadSeq) return;
    if (result.success && result.data) {
      setSuppliers(result.data);
    }
  } finally {
    // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
    if (s === loadSeq) setSuppliersLoading(false);
  }
}
