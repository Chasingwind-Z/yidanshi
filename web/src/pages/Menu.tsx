import { useEffect, useState } from "react";
import { api, type Order, type Recipe } from "../api";

export default function Menu() {
  const [cats, setCats] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [cat, setCat] = useState("");
  const [fan, setFan] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [avoid7, setAvoid7] = useState(() => localStorage.getItem("fan_avoid7") !== "0");
  const [quick30, setQuick30] = useState(() => localStorage.getItem("fan_quick30") === "1");
  const [easy, setEasy] = useState(() => localStorage.getItem("fan_easy") === "1");
  const [pantryFirst, setPantryFirst] = useState(() => localStorage.getItem("fan_pantry") === "1");

  function flip() {
    localStorage.setItem("fan_avoid7", avoid7 ? "1" : "0");
    localStorage.setItem("fan_quick30", quick30 ? "1" : "0");
    localStorage.setItem("fan_easy", easy ? "1" : "0");
    localStorage.setItem("fan_pantry", pantryFirst ? "1" : "0");
    api.random(cat, { avoidDays: avoid7 ? 7 : 0, maxMinutes: quick30 ? 30 : 0,
      difficulty: easy ? "简单" : "", usePantry: pantryFirst })
      .then(r => (location.hash = `#/recipe/${r.id}`));
  }

  function load() {
    return api.recipes().then(({ categories, recipes }) => {
      const used = [...new Set(recipes.map(r => r.category))];
      const all = [...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))];
      setCats(all);
      setRecipes(recipes);
      setCat(c => (c && all.includes(c) ? c : all[0] || ""));
    });
  }
  useEffect(() => {
    load();
    api.orders().then(os => setOrders(os.filter(o => !o.done))).catch(() => {});
  }, []);

  if (recipes === null) return <div className="loading">加载中</div>;
  const shown = recipes.filter(r => r.category === cat);

  return (
    <>
      <div className="pagehead">
        <div>
          <span className="seal">箪</span>
          <h1>我的食单</h1>
        </div>
        <div className="headacts">
          {recipes.length > 0 && (
            <button title="翻牌子：随便来一道" onClick={() => setFan(f => !f)}>🎴</button>
          )}
          <a href="#/new" title="录一道菜">＋</a>
          <a href="#/settings" title="设置">⚙</a>
        </div>
      </div>
      {orders.map(o => (
        <div className="ordercard" key={o.id}>
          <div className="t">🍽 {o.from} 点菜啦（{o.date.slice(5).replace("-", "/")}）</div>
          <p>{o.items.map(it => (
            <a key={it.recipe_id} href={`#/recipe/${it.recipe_id}`} style={{ textDecoration: "underline", marginRight: 8 }}>{it.name}</a>
          ))}</p>
          {o.note && <p style={{ color: "var(--dim)" }}>「{o.note}」</p>}
          <button className="done-btn" onClick={() =>
            api.orderDone(o.id).then(() => setOrders(os => os.filter(x => x.id !== o.id)))}>做完了 / 知道了</button>
        </div>
      ))}
      {fan && (
        <div className="fanpanel">
          <label><input type="checkbox" checked={avoid7} onChange={e => setAvoid7(e.target.checked)} />最近 7 天没做过的</label>
          <label><input type="checkbox" checked={quick30} onChange={e => setQuick30(e.target.checked)} />30 分钟内能做的</label>
          <label><input type="checkbox" checked={easy} onChange={e => setEasy(e.target.checked)} />只要简单省事的</label>
          <label><input type="checkbox" checked={pantryFirst} onChange={e => setPantryFirst(e.target.checked)} />优先用冰箱里的食材</label>
          <button className="btn" onClick={flip}>翻牌子！</button>
        </div>
      )}
      {recipes.length === 0 ? (
        <div className="empty">
          食单还空着
          <div className="row" style={{ marginTop: 20, maxWidth: 340, marginInline: "auto" }}>
            <a className="btn" href="#/record">记下第一顿饭</a>
            <button className="btn ghost" onClick={() => api.seedExamples().then(load)}>先看看示例食单</button>
          </div>
        </div>
      ) : (
        <div className="menu">
          <div className="cats">
            {cats.map(c => (
              <button key={c} className={c === cat ? "on" : ""} onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
          <div className="dishes">
            {shown.map(r => (
              <a className="dish" key={r.id} href={`#/recipe/${r.id}`}>
                {r.cover ? <img src={r.cover} alt={r.name} loading="lazy"
                  onError={e => { e.currentTarget.outerHTML = '<div class="noimg">🍚</div>'; }} /> : <div className="noimg">🍚</div>}
                <div className="body">
                  <h3>{r.name}</h3>
                  <div className="chips">
                    <span className="chip">★ {r.rating?.toFixed(1) ?? "—"}</span>
                    <span className="chip">做过 {r.times} 回</span>
                    {r.kcal != null && <span className="chip">≈{r.kcal} kcal</span>}
                  </div>
                  <div className="go"><span>查看做法</span><span>›</span></div>
                </div>
              </a>
            ))}
            {shown.length === 0 && <div className="empty">这个分类还没有菜</div>}
          </div>
        </div>
      )}
    </>
  );
}
