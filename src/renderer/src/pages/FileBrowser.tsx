import { useParams } from "@solidjs/router";
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
 *   参数槽位 :name = 客户名；以 params.type 有无判别两种路由）
 */
export default function FileBrowser() {
  const params = useParams();
  const isCustomer = () => !params.type;
  const entity = () => decodeParam(isCustomer() ? params.name : params.productSet);
  const subFolder = () => decodeParam(params.subFolder);

  return (
    <FileBrowserView
      scope={isCustomer() ? "customer" : "productSet"}
      entity={entity()}
      subFolder={subFolder()}
      fileType={params.type === "cert" ? "cert" : "image"}
    />
  );
}
