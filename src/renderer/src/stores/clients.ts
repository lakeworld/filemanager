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
// v2.5.3（P2-13）：首载 loading——初值 true 兜住挂载后首个渲染 tick（页面侧自带 loading 信号时也可不用）
export const [customersLoading, setCustomersLoading] = createSignal(true);

// v2.5.3（P2-13）：模块级加载序号——切工作区/并发调用时过期结果丢弃（照 Certs certLoadSeq 先例）
let loadSeq = 0;

export async function loadCustomers(): Promise<void> {
  const s = ++loadSeq;
  setCustomersLoading(true);
  try {
    const result = await api.clients.list();
    if (s !== loadSeq) return;
    if (result.success && result.data) {
      setCustomers(result.data);
    }
  } finally {
    // 仅当前链仍最新时复位（过期链的 finally 不得关闭新链的 loading）
    if (s === loadSeq) setCustomersLoading(false);
  }
}
