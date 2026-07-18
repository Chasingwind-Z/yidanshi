import { useEffect, useState } from "react";
import { api, type Meal } from "../api";

export default function Timeline() {
  const [meals, setMeals] = useState<Meal[] | null>(null);
  useEffect(() => { api.meals().then(setMeals); }, []);

  if (meals === null) return <div className="loading">加载中…</div>;

  const days = new Map<string, Meal[]>();
  for (const m of meals) (days.get(m.date) ?? days.set(m.date, []).get(m.date)!).push(m);

  return (
    <>
      <div className="brand">TIMELINE</div>
      <h1>吃饭时间线</h1>
      {meals.length === 0 && <div className="empty">还没有记录，去「记一餐」开张吧</div>}
      {[...days.entries()].map(([date, ms]) => (
        <div className="day" key={date}>
          <h4>{date}</h4>
          {ms.map(m => (
            <a className="mealrow" key={m.id} href={`#/recipe/${m.recipe_id}`}>
              {m.photo_card ? <img src={m.photo_card} alt="" loading="lazy" /> : <div className="noimg">🍚</div>}
              <div className="mi">
                <b>{m.recipe_name}</b>
                <span className="chip" style={{ marginLeft: 8 }}>{"★".repeat(m.rating ?? 0) || "—"}</span>
                {m.note && <div className="note">{m.note}</div>}
              </div>
            </a>
          ))}
        </div>
      ))}
    </>
  );
}
