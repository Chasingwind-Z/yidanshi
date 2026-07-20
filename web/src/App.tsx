import { useEffect, useState } from "react";
import Guest from "./pages/Guest";
import Menu from "./pages/Menu";
import NewRecipe from "./pages/NewRecipe";
import RecipePage from "./pages/Recipe";
import Record from "./pages/Record";
import Settings from "./pages/Settings";
import Shopping from "./pages/Shopping";
import Timeline from "./pages/Timeline";
import { getToken, setToken } from "./token";

function useRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "");
}

/** 后端开了主人令牌、但本机没存对令牌时，任一 /api/ 请求 401 会弹这个门 */
function TokenGate() {
  const [t, setT] = useState(getToken());
  return (
    <div className="app">
      <div className="page" style={{ paddingTop: 80, maxWidth: 360, marginInline: "auto" }}>
        <span className="seal">箪</span>
        <h1>主人令牌</h1>
        <p className="dimtext" style={{ marginBottom: 16 }}>
          这台服务开了访问口令。输入令牌进入（就是 data/secrets.env 里的 YIDANSHI_TOKEN）。
        </p>
        <input value={t} onChange={e => setT(e.target.value)} placeholder="粘贴令牌" autoFocus
          onKeyDown={e => { if (e.key === "Enter" && t.trim()) { setToken(t); location.reload(); } }} />
        <button className="btn" style={{ marginTop: 14 }} disabled={!t.trim()}
          onClick={() => { setToken(t); location.reload(); }}>进入</button>
      </div>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const on = () => setLocked(true);
    addEventListener("yidanshi-auth-required", on);
    return () => removeEventListener("yidanshi-auth-required", on);
  }, []);
  if (locked) return <TokenGate />;

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
  else if (route.startsWith("/record/")) page = <Record presetId={decodeURIComponent(route.slice(8))} />;
  else if (route === "/timeline") page = <Timeline />;
  else if (route === "/new") page = <NewRecipe />;
  else if (route === "/settings") page = <Settings />;
  else if (route === "/shopping") page = <Shopping />;

  const tab = route.startsWith("/recipe/") ? "/" : route.startsWith("/record/") ? "/record" : route;
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
