// 食历（移植 web/src/pages/Timeline.tsx；砍掉：本月食单卡长图链接。
// 保留：周条（本周 N 餐/今日 kcal/目标对照+超标红）、周小结、按日分组、行内编辑/删除）
import { useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { Image, Picker, Text, Textarea, View } from "@tarojs/components";
import { api, absUrl, toastErr, type Meal } from "../../api";
import { ErrRetry, Loading } from "../../components/common";
import "./index.scss";

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function WeekReport() {
  const [r, setR] = useState<Awaited<ReturnType<typeof api.weekreport>> | null>(null);
  useDidShow(() => { api.weekreport().then(setR).catch(() => {}); });
  if (!r || r.meals === 0) return null;
  return (
    <View className="papercard weekreport">
      {r.kcal_avg != null && (
        <View className="wr-p">平均每餐 <Text className="wr-b">≈{r.kcal_avg}</Text> kcal
          <Text className="dimtext">（{r.meals - (r.uncounted ?? 0)} 餐合计 ≈{r.kcal}{r.uncounted ? `，另 ${r.uncounted} 餐无热量未计入` : ""}）</Text>
        </View>
      )}
      {r.kcal_avg == null && (r.uncounted ?? 0) > 0 && (
        <View className="wr-p dimtext">本周 {r.uncounted} 餐都没热量，无法给出均值</View>
      )}
      <View className="wr-p">蛋白质出现在 <Text className="wr-b">{r.protein_meals}/{r.meals}</Text> 餐 · 蔬菜 <Text className="wr-b">{r.veg_kinds.length}</Text> 种
        {r.veg_kinds.length > 0 && (
          <Text className="dimtext">（{r.veg_kinds.slice(0, 6).join("、")}{r.veg_kinds.length > 6 ? "…" : ""}）</Text>
        )}
      </View>
      <View className="wr-p dimtext">{Object.entries(r.categories).map(([c, n]) => `${c}×${n}`).join(" · ")}</View>
      {r.tip !== "" && <View className="wr-p tipline">「{r.tip}」</View>}
      <View className="wr-p dimtext">热量为估算值，看趋势就好</View>
    </View>
  );
}

function MealRow({ m, onChanged }: { m: Meal; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(m.rating);
  const [note, setNote] = useState(m.note);
  const [date, setDate] = useState(m.date);

  async function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      Taro.showToast({ title: "日期不能为空，格式 YYYY-MM-DD", icon: "none" });
      return;
    }
    try {
      await api.updateMeal(m.id, { rating, note, date });
      setOpen(false);
      onChanged();
    } catch (e) {
      toastErr(e);
    }
  }
  async function del() {
    const { confirm } = await Taro.showModal({
      title: "删除记录",
      content: `删除这条「${m.recipe_name}」记录？照片不会删，菜谱做过次数会减 1。`,
      confirmText: "删除",
      cancelText: "再想想",
    });
    if (!confirm) return;
    try {
      await api.deleteMeal(m.id);
      onChanged();
    } catch (e) {
      toastErr(e);
    }
  }

  return (
    <View className="mealwrap">
      <View className="mealrow">
        <View className="mealmain" hoverClass="btn-hover"
          onClick={() => Taro.navigateTo({ url: `/pages/recipe/index?id=${encodeURIComponent(m.recipe_id)}` })}>
          {m.photo_card
            ? <Image src={absUrl(m.photo_card)} mode="aspectFill" className="mealimg" lazyLoad />
            : <View className="mealimg mealnoimg">🍚</View>}
          <View className="mi">
            <View className="minametag">
              <Text className="miname">{m.recipe_name}</Text>
              <Text className="mistars">{"★".repeat(m.rating ?? 0) || "—"}</Text>
            </View>
            {m.note !== "" && <View className="minote">{m.note}</View>}
          </View>
        </View>
        <View className="more" onClick={() => setOpen(o => !o)}>⋯</View>
      </View>
      {open && (
        <View className="mealedit">
          <View className="stars">
            {[1, 2, 3, 4, 5].map(n => (
              <View key={n} className={`star ${rating !== null && n <= rating ? "on" : ""}`}
                onClick={() => setRating(n)}>{n <= (rating ?? 0) ? "★" : "☆"}</View>
            ))}
          </View>
          <Picker mode="date" value={date} onChange={e => setDate(e.detail.value)}>
            <View className="selectbox editgap">
              <Text>{date}</Text>
              <Text className="caret">▾</Text>
            </View>
          </Picker>
          <Textarea className="ta editgap editnote" placeholderClass="ph" value={note} maxlength={-1}
            onInput={e => setNote(e.detail.value)} />
          <View className="row editgap">
            <View className="btn ghost danger" hoverClass="btn-hover" onClick={del}>删除</View>
            <View className="btn" hoverClass="btn-hover" onClick={save}>保存</View>
          </View>
        </View>
      )}
    </View>
  );
}

export default function Timeline() {
  const [meals, setMeals] = useState<Meal[] | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [goal, setGoal] = useState<number | null>(null);
  const [err, setErr] = useState("");

  // 不 catch 的话，meals 接口一旦 5xx 就永久停在「加载中」，连报错都看不到
  const load = () => api.meals().then(ms => { setMeals(ms); setErr(""); })
    .catch(e => { setErr((e as Error).message); toastErr(e); });
  useDidShow(() => {
    load();
    api.config()
      .then(c => setGoal(c.goal?.kcal ? Number(c.goal.kcal) : null))
      .catch(() => {});
  });

  if (meals === null) {
    return (
      <View className="page">
        {err ? <ErrRetry what="食历" err={err} onRetry={load} /> : <Loading />}
      </View>
    );
  }

  const days = new Map<string, Meal[]>();
  for (const m of meals) (days.get(m.date) ?? days.set(m.date, []).get(m.date)!).push(m);

  const monday = new Date(Date.now() - ((new Date().getDay() + 6) % 7) * 864e5);
  const weekMeals = meals.filter(m => m.date >= fmt(monday));
  const todayStr = fmt(new Date());
  const todayMeals = meals.filter(m => m.date === todayStr);
  const todayKcal = todayMeals.reduce((s, m) => s + (m.kcal ?? 0), 0);
  const todayUncounted = todayMeals.filter(m => m.kcal == null).length;  // 没热量的餐不进合计，得说明一声
  const overGoal = goal != null && todayKcal > goal;

  return (
    <View className="page">
      <Text className="seal">历</Text>
      <View className="h1">食历</View>
      {meals.length > 0 && (
        <View className="papercard weekstrip" onClick={() => setShowReport(v => !v)}>
          <Text>本周 <Text className="ws-b">{weekMeals.length}</Text> 餐
            {todayKcal > 0 && (
              <Text className="dimtext">　今日 ≈<Text className={overGoal ? "over" : ""}>{todayKcal}</Text> kcal{goal ? ` / ${goal}` : ""}{overGoal ? " 超了" : ""}</Text>
            )}
            {todayUncounted > 0 && <Text className="dimtext">　{todayUncounted} 餐没热量未计入</Text>}
            {weekMeals.length > 0 && <Text className="dimtext">　{showReport ? "收起" : "小结 ›"}</Text>}
          </Text>
        </View>
      )}
      {showReport && <WeekReport />}
      {meals.length === 0 && (
        <View className="empty">
          <View className="empty-ico">🍚</View>
          <Text>还没有记录</Text>
          <View className="empty-act">
            <View className="btn" hoverClass="btn-hover"
              onClick={() => Taro.switchTab({ url: "/pages/record/index" })}>记下第一顿饭</View>
          </View>
        </View>
      )}
      {[...days.entries()].map(([date, ms]) => (
        <View className="day" key={date}>
          <View className="dayhead">{date}</View>
          {ms.map(m => <MealRow key={m.id} m={m} onChanged={load} />)}
        </View>
      ))}
    </View>
  );
}
