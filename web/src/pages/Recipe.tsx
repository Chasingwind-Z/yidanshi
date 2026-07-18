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
  const [canIllust, setCanIllust] = useState(false);
  const [gen, setGen] = useState<{ running: boolean; msg: string }>({ running: false, msg: "" });
  useEffect(() => { api.recipe(id).then(setR).catch(() => setR(null)); }, [id]);
  useEffect(() => { api.aiStatus().then(s => setCanIllust(!!s.imagegen?.available)).catch(() => {}); }, []);

  const missing = !r?.illust ? [] : [
    ...r.illust.ingredients.map((u, i) => (!u && r.ingredients[i] ? { kind: "ing" as const, index: i + 1, label: r.ingredients[i].name } : null)),
    ...r.illust.steps.map((u, i) => (!u ? { kind: "step" as const, index: i + 1, label: `步骤 ${i + 1}` } : null)),
  ].filter((x): x is { kind: "ing" | "step"; index: number; label: string } => x !== null);

  async function genAll() {
    setGen({ running: true, msg: "" });
    for (let k = 0; k < missing.length; k++) {
      const it = missing[k];
      setGen({ running: true, msg: `正在画「${it.label}」（${k + 1}/${missing.length}），每张几十秒…` });
      try {
        await api.aiIllustrate(id, it.kind, it.index);
        setR(await api.recipe(id));
      } catch (e) {
        setGen({ running: false, msg: `画到「${it.label}」时失败：${(e as Error).message}` });
        return;
      }
    }
    setGen({ running: false, msg: "" });
  }

  if (!r) return <div className="loading">加载中</div>;
  if (editing) return <Editor r={r} onDone={nr => { setR(nr); setEditing(false); }} />;

  const hasTutorial = r.ingredients.length > 0 || r.steps.length > 0;
  return (
    <>
      <a className="back" onClick={e => { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = "#/"); }} href="#/">‹ 菜单</a>
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
          {canIllust && missing.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button className="btn ghost" disabled={gen.running} onClick={genAll}>
                {gen.running ? gen.msg : `✨ 生成插画教程卡（${missing.length} 张）`}
              </button>
              {!gen.running && gen.msg && <div className="err">{gen.msg}</div>}
            </div>
          )}
        </div>
      ) : (
        <div className="empty">
          还没录做法
          <div style={{ marginTop: 16, maxWidth: 300, marginInline: "auto" }}>
            <button className="btn" onClick={() => setEditing(true)}>录入做法（可粘教程让 AI 整理）</button>
          </div>
        </div>
      )}

      {r.source && <div className="source">教程来源：<a href={r.source} target="_blank" rel="noreferrer">{r.source}</a></div>}
      <div style={{ marginTop: 16 }}>
        <button className="btn ghost" onClick={() => setEditing(true)}>编辑做法</button>
      </div>
    </>
  );
}

export function Editor({ r, onDone }: { r: Recipe; onDone: (r: Recipe) => void }) {
  const [name, setName] = useState(r.name);
  const [category, setCategory] = useState(r.category);
  const [source, setSource] = useState(r.source);
  const [ings, setIngs] = useState(r.ingredients.map(i => i.amount ? `${i.name} | ${i.amount}` : i.name).join("\n"));
  const [steps, setSteps] = useState(r.steps.join("\n"));
  const [tips, setTips] = useState(r.tips.join("\n"));
  const [err, setErr] = useState("");

  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState<{ backend: string; available: boolean } | null>(null);
  useEffect(() => { api.aiStatus().then(setAi).catch(() => setAi(null)); }, []);

  async function aiFill() {
    setErr("");
    setAiBusy(true);
    try {
      const x = await api.aiExtract(aiText, source);
      if (x.name) setName(x.name);
      if (x.category) setCategory(x.category);
      setIngs(x.ingredients.map(i => i.amount ? `${i.name} | ${i.amount}` : i.name).join("\n"));
      setSteps(x.steps.join("\n"));
      setTips(x.tips.join("\n"));
      setAiText("");
    } catch (e) {
      setErr(`AI 整理失败：${(e as Error).message}`);
    } finally {
      setAiBusy(false);
    }
  }

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
      <h1>{r.id ? "编辑做法" : "录一道菜"}</h1>

      {ai?.available && (
        <div className="aibox">
          <div className="t">把教程原文粘进来（抖音/小红书文案、随手记的做法都行），AI 帮你整理成菜谱</div>
          <textarea value={aiText} onChange={e => setAiText(e.target.value)}
            placeholder="例：先把牛排切条腌10分钟，芦笋焯水40秒…（长按抖音文案可复制）" />
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost" disabled={aiBusy || !aiText.trim()} onClick={aiFill}>
              {aiBusy ? "AI 整理中，可能要十几秒…" : `AI 整理（${ai.backend}）`}
            </button>
          </div>
        </div>
      )}

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
