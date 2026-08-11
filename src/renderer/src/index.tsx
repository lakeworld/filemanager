import { render } from "solid-js/web";
import { lazy } from "solid-js";
import { Router, Route } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";
import App from "./App";
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
// v2.4.7：客户 / 发票（PLAN §5.2 / §6.5）
const Clients = lazy(() => import("./pages/Clients"));
const Invoices = lazy(() => import("./pages/Invoices"));

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
      {/* v2.4.7：客户 / 发票 / 客户文件区路由（静态段 customer 优先于通用 :type 通配，参数槽位 :name = 客户名） */}
      <Route path="/clients" component={Clients} />
      <Route path="/clients/:name" component={Clients} />
      <Route path="/invoices" component={Invoices} />
      <Route path="/files/customer/:name/:subFolder" component={FileBrowser} />
      <Route path="/files/:type/:productSet/:subFolder" component={FileBrowser} />
    </Router>
  ),
  document.getElementById("root")!
);
