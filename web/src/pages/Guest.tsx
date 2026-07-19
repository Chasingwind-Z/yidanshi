import { useEffect, useState } from "react";
import type { Recipe } from "../api";

/** 亲友点菜页：只读食单 + 勾菜下单，无任何编辑入口 */
export default function Guest({ token }: { token: string }) {
  const [cats, setCats] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [cat, setCat] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ordering, setOrdering] = useState(false);
  const [from, setFrom] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"browse" | "sent" | "error">("browse");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/guest/menu?t=${encodeURIComponent(token)}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json()).detail); return r.json(); })
      .then(({ categories, recipes }) => {
        const used = [...new Set((recipes as Recipe[]).map(r => r.category))];
        const all = [...(categories as string[]).filter(c => used.includes(c)), ...used.filter(c => !(categories as string[]).includes(c))];
        setCats(all);
        setRecipes(recipes);
        setCat(all[0] || "");
      })
      .catch(e => { setErr(e.message); setState("error"); });
  }, [token]);

  if (state === "error") return <div className="empty">{err || "链接失效了"}</div>;
  if (recipes === null) return <div className="loading">上菜中</div>;

  if (state === "sent") {
    return (
      <div className="empty" style={{ paddingTop: 140 }}>
        圣旨已送达御膳房 🍳<br />等着开饭吧
        <div style={{ marginTop: 20, maxWidth: 260, marginInline: "auto" }}>
          <button className="btn ghost" onClick={() => { setPicked(new Set()); setState("browse"); setOrdering(false); }}>再点几道</button>
        </div>
      </div>
    );
  }

  function toggle(id: string) {
    setPicked(p => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  async function submit() {
    setErr("");
    try {
      const r = await fetch("/api/guest/order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token, items: [...picked], from, note }),
      });
      if (!r.ok) throw new Error((await r.json()).detail);
      setState("sent");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const shown = recipes.filter(r => r.category === cat);

  return (
    <>
      <span className="seal">箪</span>
      <h1>翻牌子点菜</h1>
      <div className="hint" style={{ marginTop: -12, marginBottom: 16 }}>这是主人家的私房食单，点你想吃的～</div>

      {ordering ? (
        <>
          <div className="hint">已点：{recipes.filter(r => picked.has(r.id)).map(r => r.name).join("、")}</div>
          <label className="f">你的称呼</label>
          <input value={from} onChange={e => setFrom(e.target.value)} placeholder="如：领导 / 妈 / 老王" />
          <label className="f">想说的话（可空）</label>
          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="少辣！多放香菜！" />
          {err && <div className="err">{err}</div>}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setOrdering(false)}>再看看</button>
            <button className="btn" onClick={submit}>下单（{picked.size} 道）</button>
          </div>
        </>
      ) : (
        <>
          <div className="menu">
            <div className="cats">
              {cats.map(c => (
                <button key={c} className={c === cat ? "on" : ""} onClick={() => setCat(c)}>{c}</button>
              ))}
            </div>
            <div className="dishes">
              {shown.map(r => (
                <div className={`dish guestdish ${picked.has(r.id) ? "on" : ""}`} key={r.id} onClick={() => toggle(r.id)}>
                  {r.cover ? <img src={r.cover} alt={r.name} loading="lazy" /> : <div className="noimg">🍚</div>}
                  <div className="body">
                    <h3>{r.name}</h3>
                    <div className="chips">
                      <span className="chip">★ {r.rating?.toFixed(1) ?? "—"}</span>
                      <span className="chip">被点过 {r.times} 回</span>
                      {r.minutes != null && <span className="chip">⏱{r.minutes}min</span>}
                      {r.kcal != null && <span className="chip">≈{r.kcal}kcal</span>}
                    </div>
                    <div className="go"><span>{picked.has(r.id) ? "✓ 已点" : "点这道"}</span><span>{picked.has(r.id) ? "" : "＋"}</span></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {picked.size > 0 && (
            <div className="orderbar">
              <button className="btn" onClick={() => setOrdering(true)}>点好了，传旨（{picked.size} 道）</button>
            </div>
          )}
        </>
      )}
    </>
  );
}
