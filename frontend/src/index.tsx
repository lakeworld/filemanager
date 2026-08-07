import { render } from "solid-js/web";
import { Router, Route } from "@solidjs/router";
import type { RouteSectionProps } from "@solidjs/router";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import ProductSets from "./pages/ProductSets";
import FileBrowser from "./pages/FileBrowser";
import Search from "./pages/Search";
import Images from "./pages/Images";
import Certs from "./pages/Certs";
import Settings from "./pages/Settings";
import Profile from "./pages/Profile";
import "./index.css";

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
      <Route path="/files/:type/:productSet/:subFolder" component={FileBrowser} />
    </Router>
  ),
  document.getElementById("root")!
);
