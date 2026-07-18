import { useEffect, useState } from "react";
import { api, type Recipe } from "../api";

const EMOJI: [RegExp, string][] = [
  [/牛/, "🥩"], [/猪|排骨|培根|火腿/, "🥓"], [/鸡/, "🍗"], [/鱼/, "🐟"], [/虾/, "🦐"],
  [/蛋/, "🥚"], [/豆腐|豆/, "🧊"], [/葱/, "🌱"], [/蒜/, "🧄"], [/姜/, "🫚"],
  [/辣椒|椒/, "🌶️"], [/番茄|西红柿/, "🍅"], [/土豆|薯/, "🥔"], [/萝卜/, "🥕"],
  [/芦笋|菜|瓜|笋|菇|芹|蒿|苗/, "🥬"], [/米|饭/, "🍚"], [/面|粉/, "🍜"], [/玉米/, "🌽"],
];
const icon = (name: string) => EMOJI.find(([re]) => re.test(name))?.[1] ?? name.slice(0, 1);

export default function RecipePage({ id }: { id: string }) {
  const [r, setR] = useState<Recipe | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { api.recipe(id).then(setR).catch(() => setR(null)); }, [id]);

  if (!r) return <div className="loading">加载中…</div>;
  if (editing) return <Editor r={r} onDone={nr => { setR(nr); setEditing(false); }} />;

  const hasTutorial = r.ingredients.length > 0 || r.steps.length > 0;
  return (
    <>
      <div className="hero">{r.cover && <img src={r.cover} alt={r.name} />}</div>
      <h2 className="rtitle">{r.name}</h2>
      <div className="stats">品味 {r.rating?.toFixed(1) ?? "—"}　被做过 {r.times} 次　{r.category}</div>

      {hasTutorial ? (
        <div className="tcard">
          <div className="tname">{r.name}</div>
          <div className="tby">by zzf</div>
          <div className="tgrid">
            <div className="tcol">
              <h4>食材准备</h4>
              {r.ingredients.map((ing, i) => (
                <div className="ing" key={i}>
                  <div className="icon">
                    {r.illust?.ingredients[i]
                      ? <img src={r.illust.ingredients[i]} alt={ing.name} />
                      : icon(ing.name)}
                  </div>
                  <div className="n">{ing.name}</div>
                  {ing.amount && <div className="a">{ing.amount}</div>}
                </div>
              ))}
            </div>
            <div className="tcol">
              <h4>做法步骤</h4>
              {r.steps.map((s, i) => (
                <div className="step" key={i}>
                  <div className="num">{i + 1}</div>
                  <div style={{ minWidth: 0 }}>
                    <p>{s}</p>
                    {r.illust?.steps[i] && <img src={r.illust.steps[i]} alt="" />}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {r.tips.length > 0 && (
            <div className="tips">
              <b>小贴士：</b>
              {r.tips.map((t, i) => <p key={i}>{t}</p>)}
            </div>
          )}
        </div>
      ) : (
        <div className="empty">还没录做法——点下面「编辑做法」，或把教程丢给 AI 助手帮你整理进来</div>
      )}

      {r.source && <div className="source">教程来源：<a href={r.source} target="_blank" rel="noreferrer">{r.source}</a></div>}
      <div style={{ marginTop: 16 }}>
        <button className="btn ghost" onClick={() => setEditing(true)}>编辑做法</button>
      </div>
    </>
  );
}

function Editor({ r, onDone }: { r: Recipe; onDone: (r: Recipe) => void }) {
  const [name, setName] = useState(r.name);
  const [category, setCategory] = useState(r.category);
  const [source, setSource] = useState(r.source);
  const [ings, setIngs] = useState(r.ingredients.map(i => i.amount ? `${i.name} | ${i.amount}` : i.name).join("\n"));
  const [steps, setSteps] = useState(r.steps.join("\n"));
  const [tips, setTips] = useState(r.tips.join("\n"));
  const [err, setErr] = useState("");

  async function save() {
    try {
      const nr = await api.saveRecipe({
        ...r, name, category, source,
        ingredients: ings.split("\n").filter(s => s.trim()).map(line => {
          const [n, a] = line.split("|").map(s => s.trim());
          return { name: n, amount: a || "" };
        }),
        steps: steps.split("\n").map(s => s.trim()).filter(Boolean),
        tips: tips.split("\n").map(s => s.trim()).filter(Boolean),
      });
      onDone(await api.recipe(nr.id));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <div className="brand">EDIT</div>
      <h1>编辑做法</h1>
      <label className="f">菜名</label>
      <input value={name} onChange={e => setName(e.target.value)} />
      <div className="row">
        <div>
          <label className="f">分类</label>
          <select value={category} onChange={e => setCategory(e.target.value)}>
            {["一碗饭", "一碗面", "一碗汤", "一碗菜", "一碗甜"].map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="f">教程来源（链接，可空）</label>
          <input value={source} onChange={e => setSource(e.target.value)} placeholder="https://…" />
        </div>
      </div>
      <label className="f">食材（一行一个，「名称 | 用量」）</label>
      <textarea value={ings} onChange={e => setIngs(e.target.value)} placeholder={"芦笋 | 一把\n牛排 | 1块"} />
      <label className="f">步骤（一行一步）</label>
      <textarea value={steps} onChange={e => setSteps(e.target.value)} style={{ minHeight: 140 }} />
      <label className="f">贴士（一行一条，可空）</label>
      <textarea value={tips} onChange={e => setTips(e.target.value)} />
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn ghost" onClick={() => onDone(r)}>取消</button>
        <button className="btn" onClick={save}>保存</button>
      </div>
    </>
  );
}
