import { useEffect, useState } from "react";
import { api, type Meal } from "../api";
import { getToken } from "../token";

function WeekReport() {
  const [r, setR] = useState<Awaited<ReturnType<typeof api.weekreport>> | null>(null);
  useEffect(() => { api.weekreport().then(setR).catch(() => {}); }, []);
  if (!r) return null;
  // 空周不摆一排 0，只留服务端给的那一句
  if (r.empty) return <div className="weekreport"><p>{r.line}</p></div>;
  return (
    <div className="weekreport">
      <p>开火 <b>{r.meals}</b> 次 · <b>{r.days}</b> 天
        {r.delta_meals != null && (
          <span className="dimtext">（{r.delta_meals === 0 ? "和上周持平" : `比上周${r.delta_meals > 0 ? "+" : ""}${r.delta_meals}`}）</span>
        )}
      </p>
      {r.new_dishes.length > 0 && (
        <p>新面孔 <b>{r.new_dishes.length}</b> 道
          <span className="dimtext">（{r.new_dishes.slice(0, 6).join("、")}{r.new_dishes.length > 6 ? "…" : ""}）</span>
        </p>
      )}
      {r.repeat_top && <p>回锅之王：<b>{r.repeat_top.name}</b>，做了 {r.repeat_top.times} 回</p>}
      {r.streak_weeks >= 2 && <p>连续开火 <b>{r.streak_weeks}</b> 周了</p>}
      {/* orders_done=家人点的菜做掉数；别写「翻牌子」——那是随机抽菜功能，撞名会把两件事搅一起 */}
      {r.orders_done && r.orders_done.count > 0 && (
        <p>家里点的菜做掉 <b>{r.orders_done.count}</b> 道
          {r.orders_done.froms.length > 0 && <span className="dimtext">（{r.orders_done.froms.join("、")} 点的）</span>}
        </p>
      )}
      {r.five_star.length > 0 && (
        <p>五星高光：<b>{r.five_star.slice(0, 3).join("、")}</b>
          {r.five_star.length > 3 && <span className="dimtext">　等 {r.five_star.length} 道</span>}
        </p>
      )}
      {r.photos > 0 && <p>带图 <b>{r.photos}</b> 张</p>}
      {r.nutri_note && <p className="dimtext">{r.nutri_note}</p>}
      {r.tip && <p className="tipline">「{r.tip}」</p>}
    </div>
  );
}

function MealRow({ m, onChanged }: { m: Meal; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(m.rating);
  const [note, setNote] = useState(m.note);
  const [date, setDate] = useState(m.date);

  const [saveErr, setSaveErr] = useState("");
  async function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setSaveErr("日期不能为空，格式 YYYY-MM-DD"); return; }
    try {
      await api.updateMeal(m.id, { rating, note, date });
      setSaveErr("");
      setOpen(false);
      onChanged();
    } catch (e) {
      setSaveErr((e as Error).message);
    }
  }
  async function del() {
    if (!confirm(`删除这条「${m.recipe_name}」记录？照片不会删，菜谱做过次数会减 1。`)) return;
    await api.deleteMeal(m.id);
    onChanged();
  }

  return (
    <div className="mealwrap">
      <div className="mealrow">
        <a href={`#/recipe/${m.recipe_id}`} style={{ display: "flex", gap: 12, alignItems: "center", flex: 1, minWidth: 0 }}>
          {m.photo_card ? <img src={m.photo_card} alt="" loading="lazy" /> : <div className="noimg">🍚</div>}
          <div className="mi">
            <b>{m.recipe_name}</b>
            <span className="chip" style={{ marginLeft: 8 }}>{"★".repeat(m.rating ?? 0) || "—"}</span>
            {m.note && <div className="note">{m.note}</div>}
          </div>
        </a>
        <button className="more" onClick={() => setOpen(o => !o)}>⋯</button>
      </div>
      {open && (
        <div className="mealedit">
          <div className="stars">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} className={rating !== null && n <= rating ? "on" : ""}
                onClick={() => setRating(n)}>{n <= (rating ?? 0) ? "★" : "☆"}</button>
            ))}
          </div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ marginTop: 8 }} />
          <textarea value={note} onChange={e => setNote(e.target.value)} style={{ marginTop: 8, minHeight: 60 }} />
          {saveErr && <div className="err">{saveErr}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost danger" onClick={del}>删除</button>
            <button className="btn" onClick={save}>保存</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Timeline() {
  const [meals, setMeals] = useState<Meal[] | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [goal, setGoal] = useState<number | null>(null);
  const [err, setErr] = useState("");
  // 不 catch 的话，meals 接口一旦 5xx 就永久停在「加载中」，连报错都看不到
  const load = () => api.meals().then(ms => { setMeals(ms); setErr(""); })
    .catch(e => setErr((e as Error).message));
  useEffect(() => {
    load();
    fetch("/api/config").then(r => r.json())
      .then(c => setGoal(c.goal?.kcal ? Number(c.goal.kcal) : null)).catch(() => {});
  }, []);

  if (meals === null) {
    return err
      ? <div className="empty">食历没能读出来<div className="dimtext" style={{ margin: "8px 0 16px" }}>{err}</div>
          <button className="btn" onClick={load}>重试</button></div>
      : <div className="loading">加载中</div>;
  }

  const days = new Map<string, Meal[]>();
  for (const m of meals) (days.get(m.date) ?? days.set(m.date, []).get(m.date)!).push(m);

  const fmt = (d: Date) => d.toLocaleDateString("sv");
  const monday = new Date(Date.now() - ((new Date().getDay() + 6) % 7) * 864e5);
  const weekMeals = meals.filter(m => m.date >= fmt(monday));
  const curMonth = fmt(new Date()).slice(0, 7);
  const todayStr = fmt(new Date());
  const todayMeals = meals.filter(m => m.date === todayStr);
  const todayKcal = todayMeals.reduce((s, m) => s + (m.kcal ?? 0), 0);
  const todayUncounted = todayMeals.filter(m => m.kcal == null).length;  // 没热量的餐不进合计，得说明一声
  const overGoal = goal != null && todayKcal > goal;

  return (
    <>
      <span className="seal">历</span>
      <h1>食历</h1>
      {meals.length > 0 && (
        <div className="weekstrip" onClick={() => setShowReport(v => !v)} style={{ cursor: "pointer" }}>
          <span>本周 <b>{weekMeals.length}</b> 餐
            {todayKcal > 0 && (
              <span className="dimtext">　今日 ≈<span style={overGoal ? { color: "var(--accent)", fontWeight: 600 } : undefined}>{todayKcal}</span> kcal{goal ? ` / ${goal}` : ""}{overGoal ? " 超了" : ""}</span>
            )}
            {todayUncounted > 0 && <span className="dimtext">　{todayUncounted} 餐没热量未计入</span>}
            {/* 空周也能点开小结——周报契约的 empty 态会给一句话，不再藏死 */}
            <span className="dimtext">　{showReport ? "收起" : "小结 ›"}</span></span>
          {/* 裸 <a> 不经 fetch 包装，开了主人令牌后点开会是 401 JSON —— 带上令牌 */}
          {meals.some(m => m.date.startsWith(curMonth)) && (
            <a href={`/api/monthcard/${curMonth}${getToken() ? `?token=${encodeURIComponent(getToken())}` : ""}`}
              target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>本月食单卡</a>
          )}
        </div>
      )}
      {showReport && <WeekReport />}
      {meals.length === 0 && (
        <div className="empty">
          还没有记录
          <div style={{ marginTop: 16, maxWidth: 300, marginInline: "auto" }}>
            <a className="btn" href="#/record">记下第一顿饭</a>
          </div>
        </div>
      )}
      {[...days.entries()].map(([date, ms]) => (
        <div className="day" key={date}>
          <h4>{date}</h4>
          {ms.map(m => <MealRow key={m.id} m={m} onChanged={load} />)}
        </div>
      ))}
    </>
  );
}
