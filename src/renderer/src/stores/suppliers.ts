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

export async function loadSuppliers(): Promise<void> {
  const result = await api.suppliers.list();
  if (result.success && result.data) {
    setSuppliers(result.data);
  }
}
