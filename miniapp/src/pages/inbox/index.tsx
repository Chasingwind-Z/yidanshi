// 收到的点菜（主人收件箱）：谁想吃什么、每道菜的讲究（朱批小字）、做好了打勾。
// 已做过的单折到下方灰显。措辞纪律：点菜/想吃，不叫订单。
// 做好了 ✓ 接上主人动线：顺手记进食历（record_preset 桥）；未完成单可把食材并入买菜清单。
import { useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { Text, View } from "@tarojs/components";
import { api, toastErr, type Order } from "../../api";
import { mergeShopping } from "../../shop";
import { ErrRetry, Loading } from "../../components/common";
import "./index.scss";

/** "2026-07-22" → 「7月22日」（done_date 只有 P0-2 之后完成的单才有） */
const doneDay = (d: string) => {
  const [, m, day] = d.split("-");
  return `${Number(m)}月${Number(day)}日`;
};

/** 单 id 形如 o+YYYYMMDDHHMMSS+微秒（o20260722143205123456）→ 「14:32」；
 *  形状不对（老单/异构 id）返回空串、不显示——时刻是顺手解析出来的，解析不出就别硬凑 */
const orderTime = (id: string) => {
  const m = id.match(/^o\d{8}(\d{2})(\d{2})\d{2}\d{6}$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
  return `${m[1]}:${m[2]}`;
};

function OrderCard({ o, onDone, onShop, shopped }: {
  o: Order; onDone?: (o: Order) => void; onShop?: (o: Order) => void; shopped?: boolean;
}) {
  return (
    <View className={`papercard ocard ${o.done ? "isdone" : "boxline"}`}>
      <View className="o-head">
        <Text className="o-from">{o.from}</Text>
        <Text className="o-date">{o.date}{orderTime(o.id) !== "" ? ` ${orderTime(o.id)}` : ""}</Text>
      </View>
      <View className="o-items">
        {o.items.map((it, i) => (
          <View key={`${it.recipe_id}-${i}`} className="o-item">
            <Text className="o-name">{it.name}</Text>
            {!!it.note && <Text className="o-zhupi">·{it.note}</Text>}
          </View>
        ))}
      </View>
      {!!o.note && <View className="o-note">捎话：{o.note}</View>}
      {o.done && !!o.done_date && <View className="o-donedate">{doneDay(o.done_date)}做的</View>}
      {!o.done && onDone && (
        <View className="row o-acts">
          <View className="btn ghost o-shopbtn" hoverClass="btn-hover"
            onClick={() => (shopped
              ? Taro.switchTab({ url: "/pages/shopping/index" })
              : onShop?.(o))}>
            {shopped ? "已并入 ✓ 去买菜 ›" : "食材并入买菜清单"}
          </View>
          <View className="btn ghost o-donebtn" hoverClass="btn-hover" onClick={() => onDone(o)}>
            做好了 ✓
          </View>
        </View>
      )}
    </View>
  );
}

export default function Inbox() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [err, setErr] = useState("");
  // 本次会话已并入清单的单：按钮换脸成「去买菜」，免得反复并（合并本身幂等，这是给人看的）
  const [shopped, setShopped] = useState<Set<string>>(new Set());

  function load() {
    return api.orders().then(os => { setOrders(os); setErr(""); })
      .catch(e => { setErr((e as Error).message); });
  }
  useDidShow(() => { load(); });

  if (orders === null) {
    return (
      <View className="page">
        {err ? <ErrRetry what="点菜" err={err} onRetry={load} /> : <Loading />}
      </View>
    );
  }

  const todo = orders.filter(o => !o.done);
  const done = orders.filter(o => o.done);

  async function markDone(o: Order) {
    try {
      await api.orderDone(o.id);
    } catch (e) {
      toastErr(e);
      return;
    }
    Taro.showToast({ title: "这单翻篇啦", icon: "none" });
    load();
    // 顺手记进食历：单菜直达记一餐（record_preset 桥，同 recipe 页），多菜先选一道主菜
    const { confirm } = await Taro.showModal({
      title: "顺手记进食历？",
      content: o.items.length === 1
        ? `把「${o.items[0].name}」记成一餐，食历里就有这顿了`
        : "挑一道主菜记成一餐，食历里就有这顿了",
      confirmText: "去记一餐",
      cancelText: "先不了",
    });
    if (!confirm) return;
    let rid = o.items[0]?.recipe_id;
    if (o.items.length > 1) {
      try {
        const names = o.items.slice(0, 6).map(it => it.name);  // 微信 actionSheet 上限 6 项
        const { tapIndex } = await Taro.showActionSheet({ itemList: names });
        rid = o.items[tapIndex]?.recipe_id;
      } catch {
        return;  // 取消选择 → 留在原地
      }
    }
    if (!rid) return;
    Taro.setStorageSync("record_preset", rid);
    Taro.switchTab({ url: "/pages/record/index" });
  }

  // 逻辑对齐 web/src/pages/Menu.tsx orderToShopping + shop.ts mergeShopping：
  // 拉当前清单 → 单内各菜食材同名合并用量、调料归调料 → 存回
  async function toShopping(o: Order) {
    try {
      const [{ recipes }, cur] = await Promise.all([api.recipes(), api.shopping()]);
      const rs = recipes.filter(r => o.items.some(it => it.recipe_id === r.id));
      if (rs.length === 0) {
        Taro.showToast({ title: "这单的菜已不在食单里", icon: "none" });
        return;
      }
      await api.saveShopping(mergeShopping(cur.items, rs));
      setShopped(s => new Set(s).add(o.id));
      Taro.showToast({ title: "买菜清单加上了", icon: "none" });
    } catch (e) {
      toastErr(e);
    }
  }

  return (
    <View className="page">
      <Text className="seal">函</Text>
      <View className="h1">收到的点菜</View>

      {orders.length === 0 ? (
        <View className="empty">
          <View className="empty-ico">📮</View>
          <Text>还没人点菜</Text>
          <View className="dimtext">去设置页把点菜卡片发给家里人吧</View>
        </View>
      ) : (
        <>
          {todo.map(o => (
            <OrderCard key={o.id} o={o} onDone={markDone} onShop={toShopping} shopped={shopped.has(o.id)} />
          ))}
          {todo.length === 0 && (
            <View className="hint alldone">想吃的都做完啦，等下一单 🍚</View>
          )}
          {done.length > 0 && (
            <>
              <View className="h2 donehead">做过的</View>
              {done.map(o => <OrderCard key={o.id} o={o} />)}
            </>
          )}
        </>
      )}
    </View>
  );
}
