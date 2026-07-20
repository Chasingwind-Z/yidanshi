// 买菜清单（移植 web/src/pages/Shopping.tsx：冰箱库存区、按选中菜谱生成清单
// （mergeShopping）、生鲜/调料分组勾选、已买入冰箱、清空）
import { useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { Input, Text, View } from "@tarojs/components";
import { api, toastErr, type Recipe, type ShopItem } from "../../api";
import { mergeShopping } from "../../shop";
import { ErrRetry, Loading } from "../../components/common";
import "./index.scss";

export default function Shopping() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [pantry, setPantry] = useState<string[]>([]);
  const [pantryInput, setPantryInput] = useState("");
  const [err, setErr] = useState("");

  function load() {
    api.recipes().then(({ recipes }) => setRecipes(recipes)).catch(e => setErr((e as Error).message));
    api.shopping().then(d => { setItems(d.items); setErr(""); })
      .catch(e => { setErr((e as Error).message); toastErr(e); });
    api.pantry().then(d => setPantry(d.items)).catch(() => {});
  }
  useDidShow(() => { load(); });

  function addPantry() {
    const names = pantryInput.split(/[、,，\s]+/).map(x => x.trim()).filter(Boolean);
    if (names.length === 0) return;
    const next = [...new Set([...pantry, ...names])];
    setPantry(next);
    api.savePantry(next).catch(toastErr);
    setPantryInput("");
  }

  function removePantry(name: string) {
    const next = pantry.filter(x => x !== name);
    setPantry(next);
    api.savePantry(next).catch(toastErr);
  }

  function stockBought() {
    const bought = items!.filter(x => x.checked).map(x => x.name);
    const next = [...new Set([...pantry, ...bought])];
    setPantry(next);
    api.savePantry(next).catch(toastErr);
  }

  if (items === null) {
    return (
      <View className="page">
        {err ? <ErrRetry what="买菜清单" err={err} onRetry={load} /> : <Loading />}
      </View>
    );
  }

  function toggleSel(id: string) {
    setSel(p => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function generate() {
    const next = mergeShopping([], recipes.filter(r => sel.has(r.id)));
    setItems(next);
    api.saveShopping(next).catch(toastErr);
    setPicking(false);
    setSel(new Set());
  }

  function toggleItem(name: string) {
    setItems(list => {
      if (!list) return list;
      const next = list.map(x => x.name === name ? { ...x, checked: !x.checked } : x);
      api.saveShopping(next).catch(toastErr);
      return next;
    });
  }

  async function clearAll() {
    const { confirm } = await Taro.showModal({ title: "清空买菜清单？", confirmText: "清空", cancelText: "再想想" });
    if (!confirm) return;
    setItems([]);
    api.saveShopping([]).catch(toastErr);
  }

  const fresh = items.filter(x => !x.seasoning);
  const season = items.filter(x => x.seasoning);

  const renderItem = (x: ShopItem) => (
    <View key={x.name} className={`shopitem ${x.checked ? "done" : ""}`} onClick={() => toggleItem(x.name)}>
      <View className={`checkbox ${x.checked ? "on" : ""}`}>{x.checked ? "✓" : ""}</View>
      <Text className="n">{x.name}</Text>
      <Text className="a">{x.amounts}</Text>
      <Text className="r">{x.recipes}</Text>
    </View>
  );

  return (
    <View className="page">
      <Text className="seal">采</Text>
      <View className="h1">买菜清单</View>

      <View className="papercard pantrybox">
        <View className="t">🧊 冰箱里有（翻牌子会优先推能用上的菜）</View>
        <View className="chips">
          {pantry.map(name => (
            <View key={name} className="chip pick" onClick={() => removePantry(name)}>{name} ✕</View>
          ))}
          {pantry.length === 0 && <Text className="hint nomt">还没记，把冰箱里的食材加进来</Text>}
        </View>
        <View className="row addrow">
          <View className="grow">
            <Input className="ipt" placeholderClass="ph" placeholder="鸡蛋、番茄、五花肉（顿号或空格分隔）"
              value={pantryInput} onInput={e => setPantryInput(e.detail.value)}
              onConfirm={addPantry} />
          </View>
          <View className="addbtn">
            <View className="btn ghost" hoverClass="btn-hover" onClick={addPantry}>加入</View>
          </View>
        </View>
      </View>

      {picking ? (
        <>
          <View className="hint nomt">勾选这周想做的菜，食材自动合并成清单：</View>
          <View className="chips pickchips">
            {recipes.map(r => (
              <View key={r.id} className={`chip pick ${sel.has(r.id) ? "on" : ""}`} onClick={() => toggleSel(r.id)}>
                {r.name}{r.ingredients.length === 0 ? "（没录食材）" : ""}
              </View>
            ))}
          </View>
          <View className="row acts">
            <View className="btn ghost" hoverClass="btn-hover" onClick={() => setPicking(false)}>取消</View>
            <View className={`btn ${sel.size === 0 ? "disabled" : ""}`} hoverClass="btn-hover"
              onClick={() => { if (sel.size > 0) generate(); }}>生成清单（{sel.size} 道菜）</View>
          </View>
        </>
      ) : items.length === 0 ? (
        <View className="empty">
          <View className="empty-ico">🍚</View>
          <Text>清单还空着</Text>
          <View className="empty-act">
            <View className="btn" hoverClass="btn-hover" onClick={() => setPicking(true)}>选这周想做的菜</View>
          </View>
        </View>
      ) : (
        <>
          {fresh.map(renderItem)}
          {season.length > 0 && (
            <>
              <View className="hint seasonhead">调料（家里可能已经有，出门前瞄一眼）</View>
              {season.map(renderItem)}
            </>
          )}
          <View className="row acts">
            <View className="btn ghost danger" hoverClass="btn-hover" onClick={clearAll}>清空</View>
            {items.some(x => x.checked) && (
              <View className="btn ghost" hoverClass="btn-hover" onClick={stockBought}>已买的入冰箱</View>
            )}
            <View className="btn ghost" hoverClass="btn-hover" onClick={() => setPicking(true)}>重新选菜</View>
          </View>
        </>
      )}
    </View>
  );
}
