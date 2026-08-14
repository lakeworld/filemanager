import { render } from "solid-js/web";
import { lazy } from "solid-js";
import { Router, Route } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";
import App from "./App";
import { PluginRoutes } from "./plugins/routes";
import "./index.css";

// 路由级懒加载：首屏只加载仪表盘，其余页面按需分包（性能优化）
const Dashboard = lazy(() => import("./pages/Dashboard"));
const ProductSets = lazy(() => import("./pages/ProductSets"));
const FileBrowser = lazy(() => import("./pages/FileBrowser"));
const Search = lazy(() => import("./pages/Search"));
const Images = lazy(() => import("./pages/Images"));
const Certs = lazy(() => import("./pages/Certs"));
const Settings = lazy(() => import("./pages/Settings"));
const Profile = lazy(() => import("./pages/Profile"));
const Help = lazy(() => import("./pages/Help"));
const Trash = lazy(() => import("./pages/Trash"));
// v2.4.8：导出区（压缩分享产物）
const Exports = lazy(() => import("./pages/Exports"));
// v2.4.7：客户 / 发票（PLAN §5.2 / §6.5）
const Clients = lazy(() => import("./pages/Clients"));
const Invoices = lazy(() => import("./pages/Invoices"));
// v2.4.9 S2：供应商（列表 + 详情，均为独立懒加载页面）
const Suppliers = lazy(() => import("./pages/Suppliers"));
const SupplierDetail = lazy(() => import("./pages/SupplierDetail"));
// v2.4.9 S3：报价单（列表 + 详情/编辑，均为独立懒加载页面）
const Quotes = lazy(() => import("./pages/Quotes"));
const QuoteDetail = lazy(() => import("./pages/QuoteDetail"));

function RootApp(props: RouteSectionProps) {
  return <App {...props} />;
}

render(
  () => (
    <Router root={RootApp}>
      <Route path="/" component={Dashboard} />
      <Route path="/product-sets" component={ProductSets} />
      <Route path="/product-sets/:name" component={ProductSets} />
      <Route path="/images" component={Images} />
      <Route path="/certs" component={Certs} />
      <Route path="/search" component={Search} />
      <Route path="/settings" component={Settings} />
      <Route path="/profile" component={Profile} />
      <Route path="/help" component={Help} />
      <Route path="/trash" component={Trash} />
      <Route path="/exports" component={Exports} />
      {/* v2.4.7：客户 / 发票 / 客户文件区路由（静态段 customer 优先于通用 :type 通配，参数槽位 :name = 客户名） */}
      <Route path="/clients" component={Clients} />
      <Route path="/clients/:name" component={Clients} />
      {/* v2.4.9 S2：供应商列表 / 详情 / 供应商文件区路由（静态段 supplier 同 customer 优先于 :type 通配） */}
      <Route path="/suppliers" component={Suppliers} />
      <Route path="/suppliers/:name" component={SupplierDetail} />
      {/* v2.4.9 S3：报价单列表 / 详情·编辑 */}
      <Route path="/quotes" component={Quotes} />
      <Route path="/quotes/:no" component={QuoteDetail} />
      <Route path="/invoices" component={Invoices} />
      <Route path="/files/customer/:name/:subFolder" component={FileBrowser} />
      <Route path="/files/supplier/:name/:subFolder" component={FileBrowser} />
      <Route path="/files/:type/:productSet/:subFolder" component={FileBrowser} />
      {/* v2.5：插件管理页 + 启用插件的动态页面路由（随插件清单响应式增减，启停即时生效） */}
      <PluginRoutes />
    </Router>
  ),
  document.getElementById("root")!
);
