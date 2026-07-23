// 食历（移植 web/src/pages/Timeline.tsx；砍掉：本月食单卡长图链接。
// 保留：周条（本周 N 餐/今日 kcal/目标对照+超标红）、周小结、按日分组、行内编辑/删除）
import { useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { Image, Picker, Text, Textarea, View } from "@tarojs/components";
import { api, absUrl, toastErr, type Meal } from "../../api";
import { ErrRetry, Loading, PosterSheet } from "../../components/common";
import { CLOUDRUN_HTTP_BASE, LOCAL_BASE } from "../../config";
import "./index.scss";

const isWeapp = process.env.TARO_ENV === "weapp";

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function WeekReport() {
  const [r, setR] = useState<Awaited<ReturnType<typeof api.weekreport>> | null>(null);
  useDidShow(() => { api.weekreport().then(setR).catch(() => {}); });
  if (!r) return null;
  // 空周不摆一排 0，只留服务端给的那一句（行为化契约；版式对齐 web Timeline.tsx）
  if (r.empty) return <View className="papercard weekreport"><View className="wr-p">{r.line}</View></View>;
  return (
    <View className="papercard weekreport">
      <View className="wr-p">开火 <Text className="wr-b">{r.meals}</Text> 次 · <Text className="wr-b">{r.days}</Text> 天
        {r.delta_meals != null && (
          <Text className="dimtext">（{r.delta_meals === 0 ? "和上周持平" : `比上周${r.delta_meals > 0 ? "+" : ""}${r.delta_meals}`}）</Text>
        )}
      </View>
      {r.new_dishes.length > 0 && (
        <View className="wr-p">新面孔 <Text className="wr-b">{r.new_dishes.length}</Text> 道
          <Text className="dimtext">（{r.new_dishes.slice(0, 6).join("、")}{r.new_dishes.length > 6 ? "…" : ""}）</Text>
        </View>
      )}
      {r.repeat_top && (
        <View className="wr-p">回锅之王：<Text className="wr-b">{r.repeat_top.name}</Text>，做了 {r.repeat_top.times} 回</View>
      )}
      {r.streak_weeks >= 2 && <View className="wr-p">连续开火 <Text className="wr-b">{r.streak_weeks}</Text> 周了</View>}
      {/* orders_done=家人点的菜做掉数；别写「翻牌子」——那是随机抽菜功能，撞名会把两件事搅一起 */}
      {r.orders_done && r.orders_done.count > 0 && (
        <View className="wr-p">家里点的菜做掉 <Text className="wr-b">{r.orders_done.count}</Text> 道
          {r.orders_done.froms.length > 0 && <Text className="dimtext">（{r.orders_done.froms.join("、")} 点的）</Text>}
        </View>
      )}
      {r.five_star.length > 0 && (
        <View className="wr-p">五星高光：<Text className="wr-b">{r.five_star.slice(0, 3).join("、")}</Text>
          {r.five_star.length > 3 && <Text className="dimtext">　等 {r.five_star.length} 道</Text>}
        </View>
      )}
      {r.photos > 0 && <View className="wr-p">带图 <Text className="wr-b">{r.photos}</Text> 张</View>}
      {!!r.nutri_note && <View className="wr-p dimtext">{r.nutri_note}</View>}
      {r.tip !== "" && <View className="wr-p tipline">「{r.tip}」</View>}
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
  const [monthPoster, setMonthPoster] = useState("");

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
  // 本月小结卡入口：本月有记录才摆——空月后端 404，别领着人去撞「图没能取回来」
  const ym = todayStr.slice(0, 7);
  const monthHasMeals = meals.some(m => m.date.startsWith(ym));

  // 与教程卡/纸上食单同一条路：<Image> 的镜像请求带不上 openid 头，走 guest token 的 query 放行通道
  async function openMonthCard() {
    const base = isWeapp ? CLOUDRUN_HTTP_BASE : LOCAL_BASE;
    if (!base) {
      Taro.showToast({ title: "云端才支持导出（未配公网访问域名）", icon: "none" });
      return;
    }
    try {
      const { token } = await api.guestLink();
      setMonthPoster(`${base}/api/monthcard/${ym}?t=${encodeURIComponent(token)}`);
    } catch (e) {
      toastErr(e, "小结卡没能生成");
    }
  }

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
            {/* 空周也能点开小结——周报契约的 empty 态会给一句话，不再藏死（对齐 web） */}
            <Text className="dimtext">　{showReport ? "收起" : "小结 ›"}</Text>
          </Text>
        </View>
      )}
      {showReport && <WeekReport />}
      {monthHasMeals && (
        <View className="btn ghost monthbtn" hoverClass="btn-hover" onClick={openMonthCard}>本月小结卡 ›</View>
      )}
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
      {monthPoster !== "" && (
        <PosterSheet url={monthPoster} title="本月小结卡" onClose={() => setMonthPoster("")} />
      )}
    </View>
  );
}
