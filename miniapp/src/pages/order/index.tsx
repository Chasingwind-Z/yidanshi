// 家人点菜页（客人视角，分享卡片 ?t=<token> 进入）。
// 产品纪律：这不是饭店点餐——措辞只用「想吃/点菜/传旨」，没有订单/购物车/结算。
// 客人一屏完成：选菜 → 每道菜可留讲究（少放辣…）→ 署名 → 传旨。
import { useEffect, useState } from "react";
import Taro, { useRouter } from "@tarojs/taro";
import { Image, Input, Text, Textarea, View } from "@tarojs/components";
import { api, absUrl, toastErr, type GuestDish } from "../../api";
import { Loading } from "../../components/common";
import "./index.scss";

export default function Order() {
  const router = useRouter();
  const token = (router.params.t as string) || "";

  const [cats, setCats] = useState<string[]>([]);
  const [dishes, setDishes] = useState<GuestDish[] | null>(null);
  const [bad, setBad] = useState(false); // 无 token / token 失效
  const [cat, setCat] = useState("全部");
  const [q, setQ] = useState("");
  // 选中的菜：id → 这道菜的讲究（备注）；在 map 里 = 想吃
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [from, setFrom] = useState<string>(() => (Taro.getStorageSync("guest_from") as string) || "");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sentNames, setSentNames] = useState<string[] | null>(null); // 非 null = 显示传旨成功态
  const [coverErr, setCoverErr] = useState<Record<string, boolean>>({});
  const failCover = (id: string) => setCoverErr(m => (m[id] ? m : { ...m, [id]: true }));

  useEffect(() => {
    if (!token) { setBad(true); return; }
    api.guestMenu(token)
      .then(({ categories, recipes }) => {
        const used = [...new Set(recipes.map(r => r.category))];
        setCats(["全部", ...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))]);
        setDishes(recipes);
      })
      .catch(() => setBad(true)); // 403（链接失效）与网络错都归到友好空态
  }, [token]);

  if (bad) {
    return (
      <View className="page">
        <View className="empty">
          <View className="empty-ico">✉️</View>
          <Text>点菜链接失效啦</Text>
          <View className="dimtext">找主人再要一张点菜卡片，点开就能选想吃的</View>
        </View>
      </View>
    );
  }
  if (dishes === null) return <View className="page"><Loading /></View>;

  const kw = q.trim();
  const shown = kw
    ? dishes.filter(d => d.name.includes(kw) || d.category.includes(kw))
    : cat === "全部" ? dishes : dishes.filter(d => d.category === cat);
  const pickedIds = Object.keys(picked);

  function toggle(id: string) {
    setPicked(p => {
      if (id in p) {
        const { [id]: _drop, ...rest } = p;
        return rest;
      }
      return { ...p, [id]: "" };
    });
  }

  async function send() {
    if (pickedIds.length === 0 || sending) return;
    const who = from.trim();
    if (!who) {
      Taro.showToast({ title: "留个名吧，厨房才知道是谁想吃", icon: "none" });
      return;
    }
    setSending(true);
    try {
      await api.guestOrder(token, who, note.trim(),
        pickedIds.map(id => ({ id, note: picked[id].trim() })));
      Taro.setStorageSync("guest_from", who);
      setSentNames(pickedIds.map(id => dishes!.find(d => d.id === id)?.name || ""));
      setPicked({});
      setNote("");
    } catch (e) {
      toastErr(e, "没传出去，再试一次");
    } finally {
      setSending(false);
    }
  }

  return (
    <View className="page orderpage">
      <Text className="seal">旨</Text>
      <View className="h1">今天想吃什么</View>
      <View className="hint nomt">点一点想吃的菜，有讲究就写一句，最后传给厨房。</View>

      {dishes.length > 5 && (
        <View className="searchbar">
          <Input className="ipt" placeholderClass="ph" value={q}
            onInput={e => setQ(e.detail.value)} placeholder="找菜：菜名 / 分类" />
          {kw !== "" && <View className="clear" onClick={() => setQ("")}>✕</View>}
        </View>
      )}
      {!kw && cats.length > 2 && (
        <View className="cats">
          {cats.map(c => (
            <View key={c} className={`catbtn ${c === cat ? "on" : ""}`} hoverClass="btn-hover"
              onClick={() => setCat(c)}>{c}</View>
          ))}
        </View>
      )}

      <View className="gdishes">
        {shown.map(d => {
          const on = d.id in picked;
          return (
            <View key={d.id} className={`gdish ${on ? "on" : ""}`}>
              <View className="gd-main" hoverClass="btn-hover" onClick={() => toggle(d.id)}>
                <View className={`gd-thumb ${d.cover && !coverErr[d.id] ? "" : "noimg"}`}>
                  {d.cover && !coverErr[d.id]
                    ? <Image className="gd-img" src={absUrl(d.cover)} mode="aspectFill" lazyLoad onError={() => failCover(d.id)} />
                    : <Text className="gd-rice">🍚</Text>}
                </View>
                <View className="gd-body">
                  <View className="gd-name">{d.name}</View>
                  <View className="gd-meta">
                    {d.category}
                    {d.kcal != null && ` · ≈${d.kcal} kcal${(d.servings ?? 1) > 1 ? "/餐" : ""}`}
                    {d.times > 0 && ` · 做过 ${d.times} 回`}
                    {d.rating != null && ` · ★${d.rating.toFixed(1)}`}
                  </View>
                </View>
                <View className={`gd-mark ${on ? "on" : ""}`}>{on ? "✓" : "想吃"}</View>
              </View>
              {on && (
                <View className="gd-noterow">
                  <Input className="ipt gd-note" placeholderClass="ph" value={picked[d.id]}
                    onInput={e => setPicked(p => ({ ...p, [d.id]: e.detail.value }))}
                    maxlength={60} placeholder="有什么讲究？少放辣、多放醋…" />
                </View>
              )}
            </View>
          );
        })}
        {shown.length === 0 && (
          <View className="empty">
            <View className="empty-ico">🍚</View>
            <Text>{kw ? `没有和「${kw}」相关的菜` : "这个分类还没有菜"}</Text>
          </View>
        )}
      </View>

      {pickedIds.length > 0 && (
        <View className="papercard boxline sendcard">
          <View className="t">已选 {pickedIds.length} 道 · 捎句话（可不写）</View>
          <Textarea className="ta ordernote" placeholderClass="ph" value={note} maxlength={200}
            onInput={e => setNote(e.detail.value)} placeholder="想说的话，比如：周六中午回家吃" />
        </View>
      )}

      <View className="sendbar">
        <Input className="ipt fromipt" placeholderClass="ph" value={from} maxlength={20}
          onInput={e => setFrom(e.detail.value)} placeholder="你是哪位？" />
        <View className={`btn sendbtn ${pickedIds.length === 0 || sending ? "disabled" : ""}`}
          hoverClass="btn-hover" onClick={send}>
          {sending ? "传旨中…" : pickedIds.length > 0 ? `传旨 ✉ ${pickedIds.length} 道` : "先点想吃的菜"}
        </View>
      </View>

      {sentNames !== null && (
        <View className="sentmask" catchMove>
          <View className="papercard boxline sentcard">
            <Text className="seal sentseal">旨</Text>
            <View className="sent-title">菜单已传到厨房</View>
            <View className="sent-names">{sentNames.join("、")}</View>
            <View className="dimtext">主人打开一箪食就能看到啦</View>
            <View className="btn ghost sent-again" hoverClass="btn-hover"
              onClick={() => setSentNames(null)}>再点几道</View>
          </View>
        </View>
      )}
    </View>
  );
}
