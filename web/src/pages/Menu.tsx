import { useEffect, useState } from "react";
import { api, type Recipe } from "../api";

export default function Menu() {
  const [cats, setCats] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [cat, setCat] = useState("");

  function load() {
    return api.recipes().then(({ categories, recipes }) => {
      const used = [...new Set(recipes.map(r => r.category))];
      const all = [...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))];
      setCats(all);
      setRecipes(recipes);
      setCat(c => (c && all.includes(c) ? c : all[0] || ""));
    });
  }
  useEffect(() => { load(); }, []);

  if (recipes === null) return <div className="loading">加载中</div>;
  const shown = recipes.filter(r => r.category === cat);

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="brand">YIDANSHI</div>
          <h1>今天吃什么</h1>
        </div>
        <div className="headacts">
          {recipes.length > 0 && (
            <button title="随便来一份" onClick={() =>
              api.random(cat).then(r => (location.hash = `#/recipe/${r.id}`))}>🎲</button>
          )}
          <a href="#/new" title="录一道菜">＋</a>
        </div>
      </div>
      {recipes.length === 0 ? (
        <div className="empty">
          菜单还是空的
          <div className="row" style={{ marginTop: 20, maxWidth: 340, marginInline: "auto" }}>
            <a className="btn" href="#/record">记下第一顿饭</a>
            <button className="btn ghost" onClick={() => api.seedExamples().then(load)}>先看看示例菜单</button>
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
                {r.cover ? <img src={r.cover} alt={r.name} loading="lazy" /> : <div className="noimg">🍚</div>}
                <div className="body">
                  <h3>{r.name}</h3>
                  <div className="chips">
                    <span className="chip">品味 {r.rating?.toFixed(1) ?? "—"}</span>
                    <span className="chip">做过 {r.times} 次</span>
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
