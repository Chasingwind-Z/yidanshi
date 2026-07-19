import { useEffect, useState } from "react";
import Guest from "./pages/Guest";
import Menu from "./pages/Menu";
import NewRecipe from "./pages/NewRecipe";
import RecipePage from "./pages/Recipe";
import Record from "./pages/Record";
import Settings from "./pages/Settings";
import Shopping from "./pages/Shopping";
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

  if (route.startsWith("/guest/")) {
    return (
      <div className="app">
        <div className="page" style={{ paddingBottom: 90 }}>
          <Guest token={decodeURIComponent(route.slice(7))} />
        </div>
      </div>
    );
  }

  let page = <Menu />;
  if (route.startsWith("/recipe/")) page = <RecipePage id={decodeURIComponent(route.slice(8))} />;
  else if (route === "/record") page = <Record />;
  else if (route === "/timeline") page = <Timeline />;
  else if (route === "/new") page = <NewRecipe />;
  else if (route === "/settings") page = <Settings />;
  else if (route === "/shopping") page = <Shopping />;

  const tab = route.startsWith("/recipe/") ? "/" : route;
  return (
    <div className="app">
      <div className="page" key={route}>{page}</div>
      <nav className="tabbar">
        {[["/", "食单"], ["/record", "记一餐"], ["/shopping", "买菜"], ["/timeline", "食历"]].map(([to, label]) => (
          <a key={to} href={`#${to}`} className={tab === to ? "on" : ""}>{label}</a>
        ))}
      </nav>
    </div>
  );
}
