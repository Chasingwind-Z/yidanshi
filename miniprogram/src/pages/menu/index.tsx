// 食单（首页）—— 从 web/src/pages/Menu.tsx 移植：分类 tab、搜索、菜卡、翻牌子
import { View, Text, Image, Input } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useState } from "react";
import { api, imgUrl, type Recipe } from "../../api";
import "./index.scss";

export default function Menu() {
  const [cats, setCats] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [cat, setCat] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [fanning, setFanning] = useState(false);

  function load() {
    api.recipes().then(({ categories, recipes }) => {
      const used = [...new Set(recipes.map(r => r.category))];
      const all = [...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))];
      setCats(all);
      setRecipes(recipes);
      setCat(c => (c && all.includes(c) ? c : all[0] || ""));
      setErr("");
    }).catch(e => setErr((e as Error).message));
  }
  useDidShow(load);  // 每次回到页面刷新（记完餐/编辑后数据会变）

  async function flip() {
    if (fanning) return;
    setFanning(true);
    try {
      const r = await api.random(cat, { avoidDays: 7 });
      if (r.relaxed) Taro.showToast({ title: "没有完全符合的，先翻了这道", icon: "none" });
      Taro.navigateTo({ url: `/pages/recipe/index?id=${r.id}` });
    } catch {
      Taro.showToast({ title: "食单还空着", icon: "none" });
    } finally {
      setFanning(false);
    }
  }

  if (recipes === null) {
    return (
      <View className="page">
        {err
          ? <View className="empty">食单没能读出来{"\n"}<Text className="dimtext">{err}</Text>
              <View className="btn" style={{ marginTop: "24rpx" }} onClick={load}>重试</View></View>
          : <View className="loading">加载中</View>}
      </View>
    );
  }

  const kw = q.trim();
  const shown = kw
    ? recipes.filter(r => r.name.includes(kw) || r.category.includes(kw) || r.ingredients.some(i => i.name.includes(kw)))
    : recipes.filter(r => r.category === cat);

  return (
    <View className="page">
      <View className="pagehead">
        <View>
          <Text className="seal">箪</Text>
          <Text className="h1">我的食单</Text>
        </View>
        {recipes.length > 0 && (
          <View className="fanbtn" onClick={flip}>🎴 翻牌子</View>
        )}
      </View>

      {recipes.length > 5 && (
        <Input className="searchbar" value={q} onInput={e => setQ(e.detail.value)}
          placeholder="找菜：菜名 / 食材 / 分类" />
      )}

      {!kw && (
        <View className="cats">
          {cats.map(c => (
            <View key={c} className={`cat ${c === cat ? "on" : ""}`} onClick={() => setCat(c)}>{c}</View>
          ))}
        </View>
      )}

      <View className="dishes">
        {shown.map(r => (
          <View className="dish" key={r.id}
            onClick={() => Taro.navigateTo({ url: `/pages/recipe/index?id=${r.id}` })}>
            {r.cover
              ? <Image className="cover" src={imgUrl(r.cover)} mode="aspectFill" lazyLoad />
              : <View className="noimg">🍚</View>}
            <View className="body">
              <Text className="name">{r.name}</Text>
              <View className="chips">
                <Text className="chip">★ {r.rating != null ? r.rating.toFixed(1) : "—"}</Text>
                <Text className="chip">做过 {r.times} 回</Text>
                {r.kcal_effective != null && (
                  <Text className="chip">≈{r.kcal_effective} kcal{(r.servings ?? 1) > 1 ? "/餐" : ""}</Text>
                )}
              </View>
            </View>
          </View>
        ))}
        {shown.length === 0 && (
          <View className="empty">{kw ? `没有和「${kw}」相关的菜` : "这个分类还没有菜"}</View>
        )}
      </View>
    </View>
  );
}
