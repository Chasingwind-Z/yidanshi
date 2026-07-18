import { useEffect, useState } from "react";
import { api, type Recipe } from "../api";

export default function Menu() {
  const [cats, setCats] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [cat, setCat] = useState("");

  useEffect(() => {
    api.recipes().then(({ categories, recipes }) => {
      const used = [...new Set(recipes.map(r => r.category))];
      const all = [...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))];
      setCats(all);
      setRecipes(recipes);
      setCat(c => c || all[0] || "");
    });
  }, []);

  if (recipes === null) return <div className="loading">加载中…</div>;
  const shown = recipes.filter(r => r.category === cat);

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="brand">YIDANSHI</div>
          <h1>今天吃什么</h1>
        </div>
      </div>
      {recipes.length === 0 ? (
        <div className="empty">
          菜单还是空的<br />去「记一餐」记下你做的第一顿饭吧
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
              <div className="dish" key={r.id}>
                {r.cover ? <img src={r.cover} alt={r.name} loading="lazy" /> : <div className="noimg">🍚</div>}
                <div className="body">
                  <h3>{r.name}</h3>
                  <div className="chips">
                    <span className="chip">品味 {r.rating?.toFixed(1) ?? "—"}</span>
                    <span className="chip">做过 {r.times} 次</span>
                  </div>
                  <a className="go" href={`#/recipe/${r.id}`}><span>查看做法</span><span>›</span></a>
                </div>
              </div>
            ))}
            {shown.length === 0 && <div className="empty">这个分类还没有菜</div>}
          </div>
        </div>
      )}
      {recipes.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button className="btn ghost" onClick={() => api.random().then(r => (location.hash = `#/recipe/${r.id}`))}>
            随便来一份
          </button>
        </div>
      )}
    </>
  );
}
