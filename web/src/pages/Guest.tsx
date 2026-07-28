import { useEffect, useRef, useState } from "react";
import { api, type GuestDish } from "../api";

/** 点单幂等键：**只有选的菜变了才换新**（那才是另一单）。
 *  改备注/捎话不换——传旨看似失败时客人常会改一句再重试，换了键服务端就认不出是重试，会重复下单。 */
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

/** 本机点过的单（localStorage my_orders，只留最近 20 条；t 字段用于只认本口令下的单） */
interface MyOrder { id: string | null; t: string; date: string; names: string[] }

function readMyOrders(): MyOrder[] {
  try {
    const a = JSON.parse(localStorage.getItem("my_orders") || "null");
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function writeMyOrders(list: MyOrder[]) {
  localStorage.setItem("my_orders", JSON.stringify(list.slice(-20)));
}

/** 亲友点菜页：只读食单 + 逐菜留讲究 + 传旨；「我点过的」回执让客人关了页面也能回来看状态 */
export default function Guest({ token }: { token: string }) {
  const [cats, setCats] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<GuestDish[] | null>(null);
  const [cat, setCat] = useState("");
  // 选中的菜：id → 这道菜的讲究（备注）；在 map 里 = 想吃
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [ordering, setOrdering] = useState(false);
  const [from, setFrom] = useState(() => localStorage.getItem("guest_from") || "");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [state, setState] = useState<"browse" | "sent" | "error">("browse");
  const [err, setErr] = useState("");
  // 传旨回执：ok:false = 点的菜全被厨房收回；dropped 如实相告哪些没进去
  const [receipt, setReceipt] = useState<{ ok: boolean; accepted: string[]; dropped: string[] } | null>(null);
  // 「我点过的」：本口令下过的单（本地记录）+ 服务端查回的状态（id → done/done_date）
  const [mine, setMine] = useState<MyOrder[]>([]);
  const [mineStatus, setMineStatus] = useState<Record<string, { done: boolean; done_date?: string }>>({});
  // 点单幂等键：改了单子内容（选菜/讲究/捎话）就换新；提交失败原样重试则复用旧的
  const cidRef = useRef(newCid());
  const bumpCid = () => { cidRef.current = newCid(); };

  useEffect(() => {
    api.guestMenu(token)
      .then(({ categories, recipes }) => {
        const used = [...new Set(recipes.map(r => r.category))];
        const all = [...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))];
        setCats(all);
        setRecipes(recipes);
        setCat(all[0] || "");
      })
      .catch(e => { setErr((e as Error).message); setState("error"); });
  }, [token]);

  // 我点过的：只认本口令下的单，新的在上；有 id 的批量查一次状态。
  // 查询失败/单已不存在 → 对应行只显示本地信息、不显示状态（不吓人也不装知道）。
  useEffect(() => {
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

  if (state === "error") return <div className="empty">{err || "链接失效了"}</div>;
  if (recipes === null) return <div className="loading">上菜中</div>;

  if (state === "sent" && receipt) {
    return (
      <div className="empty" style={{ paddingTop: 120 }}>
        {receipt.ok ? (
          <>
            圣旨已送达御膳房 🍳<br />
            {receipt.accepted.join("、")}
            {receipt.dropped.length > 0 && (
              <div className="dimtext" style={{ marginTop: 10 }}>
                有 {receipt.dropped.length} 道被厨房收回啦：{receipt.dropped.join("、")}
              </div>
            )}
          </>
        ) : (
          <>
            这几道菜刚被厨房收回了：{receipt.dropped.join("、")}<br />
            再挑挑别的吧
          </>
        )}
        <div style={{ marginTop: 20, maxWidth: 260, marginInline: "auto" }}>
          <button className="btn ghost" onClick={() => { setPicked({}); setState("browse"); setOrdering(false); setReceipt(null); }}>再点几道</button>
        </div>
      </div>
    );
  }

  function toggle(id: string) {
    bumpCid();  // 换了菜就是另一单
    setPicked(p => {
      if (id in p) {
        const { [id]: _drop, ...rest } = p;
        return rest;
      }
      return { ...p, [id]: "" };
    });
  }

  async function submit() {
    if (sending) return;
    setErr("");
    setSending(true);
    try {
      const pickedIds = Object.keys(picked);
      const r = await api.guestOrder(token, from, note,
        pickedIds.map(id => ({ id, note: picked[id].trim(), name: recipes!.find(x => x.id === id)?.name })),
        cidRef.current);
      localStorage.setItem("guest_from", from);
      setReceipt({ ok: r.ok, accepted: r.accepted.map(a => a.name), dropped: r.dropped });
      if (r.ok) {
        // 记进「我点过的」：只记真进了厨房的（accepted），最近 20 条
        const entry: MyOrder = { id: r.id ?? null, t: token, date: todayStr(), names: r.accepted.map(a => a.name) };
        writeMyOrders([...readMyOrders(), entry]);
        setMine(ms => [entry, ...ms]);
        if (entry.id) setMineStatus(s => ({ ...s, [entry.id!]: { done: false } }));
        setPicked({});
        setNote("");
        bumpCid();  // 这单已落定，下一单换新键
      }
      setState("sent");
    } catch (e) {
      setErr((e as Error).message);  // 原样再点=同一单，cid 不换，服务端幂等兜底
    } finally {
      setSending(false);
    }
  }

  const shown = recipes.filter(r => r.category === cat);
  const pickedIds = Object.keys(picked);

  return (
    <>
      <span className="seal">箪</span>
      <h1>翻牌子点菜</h1>
      <div className="hint" style={{ marginTop: -12, marginBottom: 16 }}>这是主人家的私房食单，点你想吃的～</div>

      {/* 我点过的：安静的回执，状态只有两档——「已传到」/「做好了 ✓」，不造「制作中」这类中间态承诺 */}
      {mine.length > 0 && !ordering && (
        <div className="pantrybox mineorders">
          <div className="t">我点过的</div>
          {mine.map((o, i) => {
            const st = o.id ? mineStatus[o.id] : undefined;
            return (
              <div key={o.id ?? `local${i}`} className="mine-row">
                <span className="mine-date">{fmtDay(o.date)}</span>
                <span className="mine-names">{o.names.join("、")}</span>
                {st && (st.done
                  ? <span className="mine-done">做好了 ✓{st.done_date ? ` ${fmtDay(st.done_date)}` : ""}</span>
                  : <span className="mine-sent">已传到</span>)}
              </div>
            );
          })}
        </div>
      )}

      {ordering ? (
        <>
          <div className="hint">已点：{recipes.filter(r => r.id in picked).map(r => r.name).join("、")}</div>
          <label className="f">你的称呼</label>
          <input value={from} onChange={e => setFrom(e.target.value)} placeholder="如：领导 / 妈 / 老王" />
          <label className="f">想说的话（可空）</label>
          {/* 改备注不换幂等键：客人以为传旨失败（其实服务端已收）时，多半会顺手补一句再重试——
              那时若换了键，服务端认不出是重试，厨房就收到两份一样的单。宁可丢掉这次备注修改 */}
          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="周六中午回家吃" />
          {err && <div className="err">{err}</div>}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn ghost" onClick={() => setOrdering(false)}>再看看</button>
            <button className="btn" disabled={sending} onClick={submit}>{sending ? "传旨中…" : `传旨（${pickedIds.length} 道）`}</button>
          </div>
        </>
      ) : (
        <>
          <div className="menu">
            <div className="cats">
              {cats.map(c => (
                <button key={c} className={c === cat ? "on" : ""} onClick={() => setCat(c)}>{c}</button>
              ))}
            </div>
            <div className="dishes">
              {shown.map(r => {
                const on = r.id in picked;
                return (
                  <div className={`dish guestdish ${on ? "on" : ""}`} key={r.id}>
                    <div onClick={() => toggle(r.id)}>
                      {r.cover ? <img src={r.cover} alt={r.name} loading="lazy" /> : <div className="noimg">🍚</div>}
                      <div className="body">
                        <h3>{r.name}</h3>
                        <div className="chips">
                          <span className="chip">★ {r.rating?.toFixed(1) ?? "—"}</span>
                          {/* times 是主人做过的次数，不是被点次数——别再标成「被点过」 */}
                          <span className="chip">做过 {r.times} 回</span>
                          {r.minutes != null && <span className="chip">⏱{r.minutes}min</span>}
                          {/* guest 的 kcal 是「每餐」值，必须标 /餐——否则访客会把它读成整道菜的热量 */}
                          {r.kcal != null && <span className="chip">≈{r.kcal} kcal{(r.servings ?? 1) > 1 ? "/餐" : ""}</span>}
                        </div>
                        <div className="go"><span>{on ? "✓ 已点" : "点这道"}</span><span>{on ? "" : "＋"}</span></div>
                      </div>
                    </div>
                    {on && (
                      <div style={{ marginTop: 8 }}>
                        <input value={picked[r.id]} maxLength={60} placeholder="有什么讲究？少放辣、多放醋…"
                          onChange={e => setPicked(p => ({ ...p, [r.id]: e.target.value }))} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {pickedIds.length > 0 && (
            <div className="orderbar">
              <button className="btn" onClick={() => setOrdering(true)}>点好了，传旨（{pickedIds.length} 道）</button>
            </div>
          )}
        </>
      )}
    </>
  );
}
