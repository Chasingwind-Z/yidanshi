import { useEffect, useState } from "react";
import { api, type Meal } from "../api";

function WeekReport() {
  const [r, setR] = useState<Awaited<ReturnType<typeof api.weekreport>> | null>(null);
  useEffect(() => { api.weekreport().then(setR).catch(() => {}); }, []);
  if (!r || r.meals === 0) return null;
  return (
    <div className="weekreport">
      {r.kcal_avg != null && <p>平均每餐 <b>≈{r.kcal_avg}</b> kcal <span className="dimtext">（{r.meals} 餐合计 ≈{r.kcal}）</span></p>}
      <p>蛋白质出现在 <b>{r.protein_meals}/{r.meals}</b> 餐 · 蔬菜 <b>{r.veg_kinds.length}</b> 种
        {r.veg_kinds.length > 0 && <span className="dimtext">（{r.veg_kinds.slice(0, 6).join("、")}{r.veg_kinds.length > 6 ? "…" : ""}）</span>}
      </p>
      <p className="dimtext">{Object.entries(r.categories).map(([c, n]) => `${c}×${n}`).join(" · ")}</p>
      {r.tip && <p className="tipline">「{r.tip}」</p>}
      <p className="dimtext">热量为估算值，看趋势就好</p>
    </div>
  );
}

function MealRow({ m, onChanged }: { m: Meal; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(m.rating);
  const [note, setNote] = useState(m.note);
  const [date, setDate] = useState(m.date);

  async function save() {
    await api.updateMeal(m.id, { rating, note, date });
    setOpen(false);
    onChanged();
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
  const load = () => api.meals().then(setMeals);
  useEffect(() => {
    load();
    fetch("/api/config").then(r => r.json())
      .then(c => setGoal(c.goal?.kcal ? Number(c.goal.kcal) : null)).catch(() => {});
  }, []);

  if (meals === null) return <div className="loading">加载中</div>;

  const days = new Map<string, Meal[]>();
  for (const m of meals) (days.get(m.date) ?? days.set(m.date, []).get(m.date)!).push(m);

  const fmt = (d: Date) => d.toLocaleDateString("sv");
  const monday = new Date(Date.now() - ((new Date().getDay() + 6) % 7) * 864e5);
  const weekMeals = meals.filter(m => m.date >= fmt(monday));
  const curMonth = fmt(new Date()).slice(0, 7);
  const todayStr = fmt(new Date());
  const todayKcal = meals.filter(m => m.date === todayStr).reduce((s, m) => s + (m.kcal ?? 0), 0);

  return (
    <>
      <span className="seal">历</span>
      <h1>食历</h1>
      {meals.length > 0 && (
        <div className="weekstrip" onClick={() => setShowReport(v => !v)} style={{ cursor: "pointer" }}>
          <span>本周 <b>{weekMeals.length}</b> 餐
            {todayKcal > 0 && <span className="dimtext">　今日 ≈{todayKcal} kcal{goal ? ` / ${goal}` : ""}</span>}
            {weekMeals.length > 0 && <span className="dimtext">　{showReport ? "收起" : "小结 ›"}</span>}</span>
          {meals.some(m => m.date.startsWith(curMonth)) && (
            <a href={`/api/monthcard/${curMonth}`} target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}>本月食单卡</a>
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
