import { toPng } from "html-to-image";
import { useEffect, useRef, useState } from "react";
import { api, type Recipe } from "../api";

const EMOJI: [RegExp, string][] = [
  [/蛋/, "🥚"], [/玉米/, "🌽"], [/番茄|西红柿/, "🍅"], [/土豆|红薯|薯/, "🥔"], [/萝卜/, "🥕"],
  [/牛/, "🥩"], [/猪|排骨|培根|火腿/, "🥓"], [/鸡|鸭|鹅/, "🍗"], [/鱼/, "🐟"], [/虾/, "🦐"],
  [/豆腐|豆/, "🧊"], [/蒜/, "🧄"], [/姜/, "🫚"], [/葱/, "🌱"], [/辣椒|花椒|胡椒|椒/, "🌶️"],
  [/油|生抽|老抽|酱|醋|料酒|盐|糖|淀粉/, "🧂"], [/米|饭|粥/, "🍚"], [/面|粉/, "🍜"],
  [/芦笋|菜|瓜|笋|菇|芹|蒿|苗|叶/, "🥬"],
];
const icon = (name: string) => EMOJI.find(([re]) => re.test(name))?.[1] ?? name.slice(0, 1);

interface IngInfo {
  name: string; kcal_per_100g: number | null; protein_g: number | null;
  fat_g: number | null; carb_g: number | null; benefits: string[]; tips: string[];
}

/** 食材小百科：点食材弹出，AI 生成一次全食单缓存复用 */
function IngredientSheet({ name, amount, iconUrl, onClose }: { name: string; amount?: string; iconUrl?: string; onClose: () => void }) {
  const [info, setInfo] = useState<IngInfo | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setInfo(null);
    setErr("");
    fetch(`/api/ingredient/${encodeURIComponent(name)}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json()).detail); return r.json(); })
      .then(setInfo)
      .catch(e => setErr(e.message));
  }, [name]);

  return (
    <div className="sheetscrim" onClick={onClose}>
      <div className="ingsheet" onClick={e => e.stopPropagation()}>
        <div className="ingsheet-head">
          <div className="icon">{iconUrl ? <img src={iconUrl} alt={name} /> : icon(name)}</div>
          <div>
            <b>{name}</b>
            {amount && <div className="dimtext">本菜用量：{amount}</div>}
          </div>
          <button className="more" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        {err && <div className="err">{err}</div>}
        {!info && !err && <div className="loading" style={{ padding: "28px 0" }}>翻小百科中</div>}
        {info && (
          <>
            {info.kcal_per_100g != null && (
              <div className="ingsheet-nums">
                <div><b>{info.kcal_per_100g}</b><span>kcal/100g</span></div>
                {info.protein_g != null && <div><b>{info.protein_g}g</b><span>蛋白质</span></div>}
                {info.fat_g != null && <div><b>{info.fat_g}g</b><span>脂肪</span></div>}
                {info.carb_g != null && <div><b>{info.carb_g}g</b><span>碳水</span></div>}
              </div>
            )}
            {info.benefits.length > 0 && info.benefits.map((b, i) => <p className="ingsheet-line" key={i}>· {b}</p>)}
            {info.tips.length > 0 && (
              <div className="tips" style={{ marginTop: 10 }}>
                <b>小贴士：</b>
                {info.tips.map((t, i) => <p key={i}>{t}</p>)}
              </div>
            )}
            <div className="dimtext" style={{ marginTop: 10 }}>* 每100克常见参考值（据《中国食物成分表》口径估算），仅供参考</div>
          </>
        )}
      </div>
    </div>
  );
}

export default function RecipePage({ id }: { id: string }) {
  const [r, setR] = useState<Recipe | null>(null);
  const [missing404, setMissing404] = useState(false);
  const [editing, setEditing] = useState(false);
  const [canIllust, setCanIllust] = useState(false);
  const [gen, setGen] = useState<{ running: boolean; msg: string }>({ running: false, msg: "" });
  const cardRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [ingSheet, setIngSheet] = useState<{ name: string; amount?: string; iconUrl?: string } | null>(null);

  async function exportCard() {
    if (!cardRef.current) return;
    setExporting(true);
    try {
      const url = await toPng(cardRef.current, { pixelRatio: 2, backgroundColor: "#fdfaf3" });
      const a = document.createElement("a");
      a.href = url;
      a.download = `${r?.name ?? "教程卡"}.png`;
      a.click();
    } finally {
      setExporting(false);
    }
  }
  useEffect(() => { api.recipe(id).then(setR).catch(() => setMissing404(true)); }, [id]);
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

  if (missing404) {
    return (
      <div className="empty">
        这道菜不在食单里了（可能被删除或改了名）
        <div style={{ marginTop: 16, maxWidth: 260, marginInline: "auto" }}>
          <a className="btn ghost" href="#/">回食单</a>
        </div>
      </div>
    );
  }
  if (!r) return <div className="loading">加载中</div>;
  if (editing) return <Editor r={r} onDone={nr => { setR(nr); setEditing(false); }} />;

  const hasTutorial = r.ingredients.length > 0 || r.steps.length > 0;
  return (
    <>
      <a className="back" onClick={e => { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = "#/"); }} href="#/">‹ 菜单</a>
      <div className="hero">{r.cover && <img src={r.cover} alt={r.name} />}</div>
      <h2 className="rtitle">{r.name}</h2>
      <div className="stats">★ {r.rating?.toFixed(1) ?? "—"}　做过 {r.times} 回　{r.category}{r.difficulty && `　${r.difficulty}`}{r.minutes != null && `　⏱${r.minutes}分钟`}{r.kcal != null && `　≈${r.kcal}kcal`}</div>

      {hasTutorial ? (
        <div className="tcard" ref={cardRef}>
          <div className="tname">{r.name}</div>
          <div className="tby">by zzf</div>
          <div className="tgrid">
            <div className="tcol">
              <h4>食材准备</h4>
              {r.ingredients.map((ing, i) => (
                <button className="ing" key={i} onClick={() =>
                  setIngSheet({ name: ing.name, amount: ing.amount, iconUrl: r.illust?.ingredients[i] || undefined })}>
                  <div className="icon">
                    {r.illust?.ingredients[i]
                      ? <img src={r.illust.ingredients[i]} alt={ing.name} />
                      : icon(ing.name)}
                  </div>
                  <div className="n">{ing.name}</div>
                  {ing.amount && <div className="a">{ing.amount}</div>}
                </button>
              ))}
              <div className="dimtext" style={{ textAlign: "center", marginTop: 4 }}>点食材看小百科</div>
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
          {(r.annotations?.length ?? 0) > 0 && (
            <div className="zhupi">
              <b>朱批</b>
              {r.annotations!.map((a, i) => (
                <p key={i}><span>{a.date.slice(5).replace("-", "/")}</span>{a.note}</p>
              ))}
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
      <div className="row" style={{ marginTop: 16 }}>
        {hasTutorial && (
          <button className="btn ghost" disabled={exporting} onClick={exportCard}>
            {exporting ? "导出中…" : "导出长图"}
          </button>
        )}
        <button className="btn ghost" onClick={() => setEditing(true)}>编辑做法</button>
      </div>
      {ingSheet && <IngredientSheet {...ingSheet} onClose={() => setIngSheet(null)} />}
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
  const [kcal, setKcal] = useState(r.kcal != null ? String(r.kcal) : "");
  const [difficulty, setDifficulty] = useState(r.difficulty ?? "");
  const [minutes, setMinutes] = useState(r.minutes != null ? String(r.minutes) : "");
  const [err, setErr] = useState("");

  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState<{ backend: string; available: boolean } | null>(null);
  useEffect(() => { api.aiStatus().then(setAi).catch(() => setAi(null)); }, []);

  async function aiFill() {
    setErr("");
    setAiBusy(true);
    try {
      // 粘的是分享链接（抖音口令等）→ 服务端抓文案；纯文字 → 直接整理
      const link = aiText.match(/https?:\/\/\S+/)?.[0];
      const isLinkMode = !!link && aiText.replace(/https?:\/\/\S+/, "").trim().length < 80;
      const x = await api.aiExtract(isLinkMode ? "" : aiText, source, isLinkMode ? link : undefined);
      if (x.name) setName(x.name);
      if (x.category) setCategory(x.category);
      setIngs(x.ingredients.map(i => i.amount ? `${i.name} | ${i.amount}` : i.name).join("\n"));
      setSteps(x.steps.join("\n"));
      setTips(x.tips.join("\n"));
      if (x.kcal != null) setKcal(String(x.kcal));
      if ((x as { difficulty?: string }).difficulty) setDifficulty((x as { difficulty?: string }).difficulty!);
      if (x.minutes != null) setMinutes(String(x.minutes));
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
        kcal: kcal.trim() ? Number(kcal) : null,
        minutes: minutes.trim() ? Number(minutes) : null,
        difficulty: difficulty || null,
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

  const DEFAULT_CATS = ["饭粥", "面点", "羹汤", "小炒", "甜点"];
  const cats = DEFAULT_CATS.includes(category) || !category ? DEFAULT_CATS : [category, ...DEFAULT_CATS];
  const [customCat, setCustomCat] = useState(false);

  return (
    <>
      <span className="seal">录</span>
      <h1>{r.id ? "编辑做法" : "录一道菜"}</h1>

      {ai?.available && (
        <div className="aibox">
          <div className="t">粘教程文案、抖音分享链接（口令直接粘），或随口描述做法——AI 帮你整理成菜谱</div>
          <textarea value={aiText} onChange={e => setAiText(e.target.value)}
            placeholder={"例：先把牛排切条腌10分钟，芦笋焯水40秒…\n或直接粘：7.88 复制打开抖音 https://v.douyin.com/xxxx/"} />
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
          {customCat ? (
            <input autoFocus placeholder="自定义分类名" value={category}
              onChange={e => setCategory(e.target.value)} />
          ) : (
            <select value={category} onChange={e => {
              if (e.target.value === "__custom") { setCustomCat(true); setCategory(""); }
              else setCategory(e.target.value);
            }}>
              {cats.map(c => <option key={c}>{c}</option>)}
              <option value="__custom">自定义…</option>
            </select>
          )}
        </div>
        <div>
          <label className="f">教程来源（链接，可空）</label>
          <input value={source} onChange={e => setSource(e.target.value)} placeholder="https://…" />
        </div>
      </div>
      <label className="f">食材（一行一个，「名称 | 用量」）</label>
      <textarea value={ings} onChange={e => setIngs(e.target.value)} placeholder={"芦笋 | 一把\n牛排 | 1块"} />
      <label className="f">步骤（一行一步）</label>
      <textarea value={steps} onChange={e => setSteps(e.target.value)} style={{ minHeight: 140 }}
        placeholder={"牛排切条腌10分钟\n芦笋焯水40秒\n热锅煎牛排，加芦笋合炒调味出锅"} />
      <label className="f">贴士（一行一条，可空）</label>
      <textarea value={tips} onChange={e => setTips(e.target.value)} />
      <div className="row">
        <div>
          <label className="f">热量（千卡/份）</label>
          <input type="number" value={kcal} onChange={e => setKcal(e.target.value)} placeholder="472" />
        </div>
        <div>
          <label className="f">耗时（分钟）</label>
          <input type="number" value={minutes} onChange={e => setMinutes(e.target.value)} placeholder="25" />
        </div>
        <div>
          <label className="f">难度</label>
          <select value={difficulty} onChange={e => setDifficulty(e.target.value)}>
            <option value="">未定</option>
            {["简单", "中等", "硬菜"].map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn ghost" onClick={() => onDone(r)}>取消</button>
        <button className="btn" onClick={save}>保存</button>
      </div>
      {r.id && (
        <div style={{ marginTop: 24 }}>
          <button className="btn ghost danger" onClick={async () => {
            if (!confirm(`删除「${r.name}」？食历里的记录会保留（仍显示菜名），插画和照片不会删。`)) return;
            await fetch(`/api/recipes/${r.id}`, { method: "DELETE" });
            location.hash = "#/";
          }}>删除这道菜</button>
        </div>
      )}
    </>
  );
}
