// 家人点菜页（客人视角，分享卡片 ?t=<token> 进入）。
// 产品纪律：这不是饭店点餐——措辞只用「想吃/点菜/传旨」，没有订单/购物车/结算。
// 客人一屏完成：选菜 → 每道菜可留讲究（少放辣…）→ 署名 → 传旨。
import { useEffect, useRef, useState } from "react";
import Taro, { useRouter } from "@tarojs/taro";
import { Image, Input, Text, Textarea, View } from "@tarojs/components";
import { api, absUrl, toastErr, type GuestDish } from "../../api";
import { Loading } from "../../components/common";
import "./index.scss";

/** 点单幂等键：进入传旨流程生成一个，改了单子内容就换新的（不同单），纯失败重试复用旧的 */
const newCid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "2026-07-22" → 「7月22日」；形状不对原样返回 */
const fmtDay = (d: string) => {
  const m = d.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])}月${Number(m[2])}日` : d;
};

/** 本机点过的单（storage my_orders，只留最近 20 条；t 字段用于只认本口令下的单） */
interface MyOrder { id: string | null; t: string; date: string; names: string[] }

function readMyOrders(): MyOrder[] {
  try {
    const a = JSON.parse((Taro.getStorageSync("my_orders") as string) || "null");
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

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
  // 传旨回执（用服务端回执渲染，不再用本地列表）：ok:false = 点的菜全被厨房收回
  const [receipt, setReceipt] = useState<{ ok: boolean; accepted: string[]; dropped: string[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [coverErr, setCoverErr] = useState<Record<string, boolean>>({});
  const failCover = (id: string) => setCoverErr(m => (m[id] ? m : { ...m, [id]: true }));
  // 点单幂等键：改了单子内容（选菜/讲究/捎话）就 bump 换新；catch 后原样重点则复用
  const cidRef = useRef(newCid());
  const bumpCid = () => { cidRef.current = newCid(); };
  // 「我点过的」：本口令下过的单（本地记录）+ 服务端查回的状态（id → done/done_date）
  const [mine, setMine] = useState<MyOrder[]>([]);
  const [mineStatus, setMineStatus] = useState<Record<string, { done: boolean; done_date?: string }>>({});

  useEffect(() => {
    if (!token) { setBad(true); return; }
    api.guestMenu(token)
      .then(({ categories, recipes }) => {
        const used = [...new Set(recipes.map(r => r.category))];
        setCats(["全部", ...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))]);
        setDishes(recipes);
        // 口令验证有效才记住：客人以后从主入口进来（食单页 401），能被引导回点菜页
        Taro.setStorageSync("guest_t", token);
      })
      .catch(() => setBad(true)); // 403（链接失效）与网络错都归到友好空态
  }, [token]);

  // 我点过的：只认本口令下的单，新的在上；有 id 的批量查一次状态。
  // 查询失败/单已不存在 → 对应行只显示本地信息、不显示状态（不吓人也不装知道）。
  useEffect(() => {
    if (!token) return;
    const list = readMyOrders().filter(o => o.t === token).reverse();
    setMine(list);
    const ids = list.map(o => o.id).filter((x): x is string => !!x);
    if (ids.length === 0) return;
    api.guestOrderStatus(token, ids)
      .then(({ orders }) => {
        const m: Record<string, { done: boolean; done_date?: string }> = {};
        for (const o of orders) m[o.id] = { done: o.done, done_date: o.done_date };
        setMineStatus(m);
      })
      .catch(() => {});
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
    bumpCid(); // 换了菜就是另一单
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
      const r = await api.guestOrder(token, who, note.trim(),
        pickedIds.map(id => ({ id, note: picked[id].trim(), name: dishes!.find(d => d.id === id)?.name })),
        cidRef.current);
      Taro.setStorageSync("guest_from", who);
      // 成功态按服务端回执渲染：accepted 才是真进了厨房的；dropped 如实相告
      setReceipt({ ok: r.ok, accepted: r.accepted.map(a => a.name), dropped: r.dropped });
      if (r.ok) {
        // 记进「我点过的」：只记真进了厨房的（accepted），最近 20 条
        const entry: MyOrder = { id: r.id ?? null, t: token, date: todayStr(), names: r.accepted.map(a => a.name) };
        Taro.setStorageSync("my_orders", JSON.stringify([...readMyOrders(), entry].slice(-20)));
        setMine(ms => [entry, ...ms]);
        if (entry.id) setMineStatus(s => ({ ...s, [entry.id!]: { done: false } }));
        setPicked({});
        setNote("");
        bumpCid(); // 这单已落定，下一单换新键
      }
    } catch (e) {
      toastErr(e, "没传出去，再试一次"); // 原样再点=同一单，cid 不换，服务端幂等兜底
    } finally {
      setSending(false);
    }
  }

  // 点的菜全被收回时的出路：重拉菜单，选中项里已下架的一并清掉
  async function refreshMenu() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const { categories, recipes } = await api.guestMenu(token);
      const used = [...new Set(recipes.map(r => r.category))];
      setCats(["全部", ...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))]);
      setDishes(recipes);
      setCat("全部");
      bumpCid(); // 选中项可能被裁掉，内容变了就是新单
      setPicked(p => {
        const next: Record<string, string> = {};  // fromEntries 是 ES2019，老基础库不稳，手拼
        for (const [pid, pn] of Object.entries(p)) if (recipes.some(d => d.id === pid)) next[pid] = pn;
        return next;
      });
      setReceipt(null);
    } catch (e) {
      toastErr(e, "菜单没刷出来，再试一次");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View className="page orderpage">
      <Text className="seal">旨</Text>
      <View className="h1">今天想吃什么</View>
      <View className="hint nomt">点一点想吃的菜，有讲究就写一句，最后传给厨房。</View>

      {/* 我点过的：安静的回执卡。状态只有两档——「已传到」/「做好了 ✓」，
          永不加“制作中/预计时间”（评审裁决：这是家里的厨房，不是外卖进度条，
          做没做只有这两个事实，别造中间态承诺）。 */}
      {mine.length > 0 && (
        <View className="papercard mineorders">
          <View className="t">我点过的</View>
          {mine.map((o, i) => {
            const st = o.id ? mineStatus[o.id] : undefined;
            return (
              <View key={o.id ?? `local${i}`} className="mine-row">
                <Text className="mine-date">{fmtDay(o.date)}</Text>
                <Text className="mine-names">{o.names.join("、")}</Text>
                {st && (st.done
                  ? <Text className="mine-done">做好了 ✓{st.done_date ? ` ${fmtDay(st.done_date)}` : ""}</Text>
                  : <Text className="mine-sent">已传到</Text>)}
              </View>
            );
          })}
        </View>
      )}

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
                    {d.minutes != null && ` · 约 ${d.minutes} 分钟`}
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
                    onInput={e => { bumpCid(); setPicked(p => ({ ...p, [d.id]: e.detail.value })); }}
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
            onInput={e => { bumpCid(); setNote(e.detail.value); }} placeholder="想说的话，比如：周六中午回家吃" />
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

      {receipt !== null && (
        <View className="sentmask" catchMove>
          {receipt.ok ? (
            <View className="papercard boxline sentcard">
              <Text className="seal sentseal">旨</Text>
              <View className="sent-title">菜单已传到厨房</View>
              <View className="sent-names">{receipt.accepted.join("、")}</View>
              {receipt.dropped.length > 0 && (
                <View className="sent-dropped">
                  有 {receipt.dropped.length} 道菜被厨房收回啦：{receipt.dropped.join("、")}
                </View>
              )}
              <View className="dimtext">主人打开一箪食就能看到啦</View>
              <View className="btn ghost sent-again" hoverClass="btn-hover"
                onClick={() => setReceipt(null)}>再点几道</View>
            </View>
          ) : (
            <View className="papercard boxline sentcard">
              <View className="sent-title">这几道菜刚被厨房收回了</View>
              <View className="sent-names">{receipt.dropped.join("、")}</View>
              <View className="dimtext">再挑挑别的吧</View>
              <View className={`btn sent-again ${refreshing ? "disabled" : ""}`} hoverClass="btn-hover"
                onClick={refreshMenu}>{refreshing ? "刷新中…" : "刷新菜单"}</View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
