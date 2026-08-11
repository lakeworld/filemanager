/**
 * 客户 store（v2.4.7 §5.2）：客户/ 目录 × customers.json 档案合并结果的信号与加载。
 * 变更操作（create/update/rename/delete/link）由页面直调 api.clients.*（服务端名称校验 /
 * 建默认子文件夹 / 回收站编排），成功后在页面侧调用 loadCustomers() 刷新——
 * 仿 stores/workspace.ts 产品集段（loadProductSets 范式）。
 */
import { createSignal } from "solid-js";
import { api } from "~/wails/api";
import type { CustomerInfo } from "~/types";

/** 客户列表（按名称排序；目录扫描为实、JSON 为档案） */
export const [customers, setCustomers] = createSignal<CustomerInfo[]>([]);

export async function loadCustomers(): Promise<void> {
  const result = await api.clients.list();
  if (result.success && result.data) {
    setCustomers(result.data);
  }
}
