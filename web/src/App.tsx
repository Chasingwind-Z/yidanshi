import { useEffect, useState } from "react";
import Menu from "./pages/Menu";
import RecipePage from "./pages/Recipe";
import Record from "./pages/Record";
import Timeline from "./pages/Timeline";

function useRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "");
}

export default function App() {
  const route = useRoute();
  let page = <Menu />;
  if (route.startsWith("/recipe/")) page = <RecipePage id={decodeURIComponent(route.slice(8))} />;
  else if (route === "/record") page = <Record />;
  else if (route === "/timeline") page = <Timeline />;

  const tab = route.startsWith("/recipe/") ? "/" : route;
  return (
    <div className="app">
      <div className="page">{page}</div>
      <nav className="tabbar">
        {[["/", "菜单"], ["/record", "记一餐"], ["/timeline", "时间线"]].map(([to, label]) => (
          <a key={to} href={`#${to}`} className={tab === to ? "on" : ""}>{label}</a>
        ))}
      </nav>
    </div>
  );
}
