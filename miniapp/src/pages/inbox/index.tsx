// 收到的点菜（主人收件箱）：谁想吃什么、每道菜的讲究（朱批小字）、做好了打勾。
// 已做过的单折到下方灰显。措辞纪律：点菜/想吃，不叫订单。
import { useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { Text, View } from "@tarojs/components";
import { api, toastErr, type Order } from "../../api";
import { ErrRetry, Loading } from "../../components/common";
import "./index.scss";

function OrderCard({ o, onDone }: { o: Order; onDone?: (id: string) => void }) {
  return (
    <View className={`papercard ocard ${o.done ? "isdone" : "boxline"}`}>
      <View className="o-head">
        <Text className="o-from">{o.from}</Text>
        <Text className="o-date">{o.date}</Text>
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
      {!o.done && onDone && (
        <View className="btn ghost o-donebtn" hoverClass="btn-hover" onClick={() => onDone(o.id)}>
          做好了 ✓
        </View>
      )}
    </View>
  );
}

export default function Inbox() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [err, setErr] = useState("");

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

  function markDone(id: string) {
    api.orderDone(id).then(() => {
      Taro.showToast({ title: "记上了，开做！", icon: "none" });
      load();
    }).catch(toastErr);
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
          {todo.map(o => <OrderCard key={o.id} o={o} onDone={markDone} />)}
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
