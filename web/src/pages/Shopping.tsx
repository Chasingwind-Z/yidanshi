import { useEffect, useState } from "react";
import { api, type Recipe, type ShopItem } from "../api";

const SEASONING = /油|盐|糖|生抽|老抽|酱|醋|料酒|淀粉|胡椒|花椒|八角|香叶|桂皮|鸡精|味精|蚝油|冰糖|辣椒面|孜然/;

export default function Shopping() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [pantry, setPantry] = useState<string[]>([]);
  const [pantryInput, setPantryInput] = useState("");

  useEffect(() => {
    api.recipes().then(({ recipes }) => setRecipes(recipes));
    api.shopping().then(d => setItems(d.items));
    api.pantry().then(d => setPantry(d.items)).catch(() => {});
  }, []);

  function addPantry() {
    const names = pantryInput.split(/[、,，\s]+/).map(x => x.trim()).filter(Boolean);
    if (names.length === 0) return;
    const next = [...new Set([...pantry, ...names])];
    setPantry(next);
    api.savePantry(next);
    setPantryInput("");
  }

  function removePantry(name: string) {
    const next = pantry.filter(x => x !== name);
    setPantry(next);
    api.savePantry(next);
  }

  function stockBought() {
    const bought = items!.filter(x => x.checked).map(x => x.name);
    const next = [...new Set([...pantry, ...bought])];
    setPantry(next);
    api.savePantry(next);
  }

  if (items === null) return <div className="loading">加载中</div>;

  function toggleSel(id: string) {
    setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function generate() {
    const merged = new Map<string, { amounts: string[]; recipes: string[] }>();
    for (const r of recipes.filter(r => sel.has(r.id))) {
      for (const ing of r.ingredients) {
        const e = merged.get(ing.name) ?? { amounts: [], recipes: [] };
        if (ing.amount) e.amounts.push(ing.amount);
        e.recipes.push(r.name);
        merged.set(ing.name, e);
      }
    }
    const next: ShopItem[] = [...merged.entries()].map(([name, e]) => ({
      name, amounts: e.amounts.join(" + "), recipes: [...new Set(e.recipes)].join("、"),
      checked: false, seasoning: SEASONING.test(name),
    })).sort((a, b) => Number(a.seasoning) - Number(b.seasoning));
    setItems(next);
    api.saveShopping(next);
    setPicking(false);
    setSel(new Set());
  }

  function toggleItem(i: number) {
    setItems(list => {
      if (!list) return list;
      const next = list.map((x, j) => j === i ? { ...x, checked: !x.checked } : x);
      api.saveShopping(next);
      return next;
    });
  }

  function clearAll() {
    if (!confirm("清空买菜清单？")) return;
    setItems([]);
    api.saveShopping([]);
  }

  const fresh = items.filter(x => !x.seasoning);
  const season = items.filter(x => x.seasoning);

  return (
    <>
      <span className="seal">采</span>
      <h1>买菜清单</h1>

      <div className="pantrybox">
        <div className="t">🧊 冰箱里有（翻牌子会优先推能用上的菜）</div>
        <div className="chips">
          {pantry.map(name => (
            <button key={name} className="chip pick" title="点一下移除"
              onClick={() => removePantry(name)}>{name} ✕</button>
          ))}
          {pantry.length === 0 && <span className="hint" style={{ marginTop: 0 }}>还没记，把冰箱里的食材加进来</span>}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="鸡蛋、番茄、五花肉（顿号或空格分隔）" value={pantryInput}
            onChange={e => setPantryInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addPantry()} />
          <button className="btn ghost" style={{ maxWidth: 90 }} onClick={addPantry}>加入</button>
        </div>
      </div>

      {picking ? (
        <>
          <div className="hint" style={{ marginTop: 0 }}>勾选这周想做的菜，食材自动合并成清单：</div>
          <div className="chips" style={{ marginTop: 10 }}>
            {recipes.map(r => (
              <button key={r.id} className={`chip pick ${sel.has(r.id) ? "on" : ""}`} onClick={() => toggleSel(r.id)}>
                {r.name}{r.ingredients.length === 0 && "（没录食材）"}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn ghost" onClick={() => setPicking(false)}>取消</button>
            <button className="btn" disabled={sel.size === 0} onClick={generate}>生成清单（{sel.size} 道菜）</button>
          </div>
        </>
      ) : items.length === 0 ? (
        <div className="empty">
          清单还空着
          <div style={{ marginTop: 16, maxWidth: 300, marginInline: "auto" }}>
            <button className="btn" onClick={() => setPicking(true)}>选这周想做的菜</button>
          </div>
        </div>
      ) : (
        <>
          {fresh.map(x => (
            <label className={`shopitem ${x.checked ? "done" : ""}`} key={x.name}>
              <input type="checkbox" checked={x.checked} onChange={() => toggleItem(items.indexOf(x))} />
              <span className="n">{x.name}</span>
              <span className="a">{x.amounts}</span>
              <span className="r">{x.recipes}</span>
            </label>
          ))}
          {season.length > 0 && (
            <>
              <div className="hint" style={{ margin: "16px 0 8px" }}>调料（家里可能已经有，出门前瞄一眼）</div>
              {season.map(x => (
                <label className={`shopitem ${x.checked ? "done" : ""}`} key={x.name}>
                  <input type="checkbox" checked={x.checked} onChange={() => toggleItem(items.indexOf(x))} />
                  <span className="n">{x.name}</span>
                  <span className="a">{x.amounts}</span>
                  <span className="r">{x.recipes}</span>
                </label>
              ))}
            </>
          )}
          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn ghost danger" onClick={clearAll}>清空</button>
            {items.some(x => x.checked) && (
              <button className="btn ghost" onClick={stockBought}>已买的入冰箱</button>
            )}
            <button className="btn ghost" onClick={() => setPicking(true)}>重新选菜</button>
          </div>
        </>
      )}
    </>
  );
}
