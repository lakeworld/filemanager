import { useParams, useLocation } from "@solidjs/router";
import FileBrowserView from "~/components/FileBrowserView";

/** URL 参数解码（decodeURIComponent 容错：畸形编码回退原文） */
function decodeParam(v: string | undefined): string {
  if (!v) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * 文件管理路由页（v2.4.7 起为 FileBrowserView 的薄包装，PLAN §5.2）：
 * - /files/:type/:productSet/:subFolder → scope=productSet（产品集文件区，type = image | cert）
 * - /files/customer/:name/:subFolder → scope=customer（客户文件区，静态段 customer 不通配 :type，
 *   参数槽位 :name = 客户名）
 * - /files/supplier/:name/:subFolder → scope=supplier（供应商文件区，v2.4.9 S2，同 customer 形态）
 * 判别：customer/supplier 两静态段路由的 params 形态相同（只有 name/subFolder，无 type/productSet），
 * 只能靠 pathname 第二段区分（params.type 有无无法区分两者）。
 */
export default function FileBrowser() {
  const params = useParams();
  const location = useLocation();
  const seg = () => location.pathname.split("/")[2] || "";
  const isCustomer = () => seg() === "customer";
  const isSupplier = () => seg() === "supplier";
  const isEntityScope = () => isCustomer() || isSupplier();
  const entity = () => decodeParam(isEntityScope() ? params.name : params.productSet);
  const subFolder = () => decodeParam(params.subFolder);
  // v2.5.7（A2 笔记）：深链 ?note=<文件名>——/files/.../笔记?note=xx → 命中即开 NoteEditorModal
  const noteFile = () => decodeParam(new URLSearchParams(location.search).get("note") || undefined);

  return (
    <FileBrowserView
      scope={isCustomer() ? "customer" : isSupplier() ? "supplier" : "productSet"}
      entity={entity()}
      subFolder={subFolder()}
      fileType={params.type === "cert" ? "cert" : params.type === "doc" ? "doc" : "image"}
      deepLinkNote={noteFile() || undefined}
    />
  );
}
