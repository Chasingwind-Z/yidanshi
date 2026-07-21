// 食单（移植 web/src/pages/Menu.tsx；guest 点单收件箱与「录一道菜」入口不进 v1）
import { useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { Image, Input, Text, View } from "@tarojs/components";
import { api, absUrl, toastErr, type Recipe } from "../../api";
import { ErrRetry, Loading } from "../../components/common";
import "./index.scss";

function readFlag(key: string, def: boolean): boolean {
  const v = Taro.getStorageSync(key);
  return v === "" ? def : v === "1";
}

export default function Index() {
  const [cats, setCats] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [cat, setCat] = useState("");
  const [fan, setFan] = useState(false);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  // 云端封面 URL 可能 404（迁移后 COS 对象不在）：记下坏图，回退到空盘占位，别显示裂图
  const [coverErr, setCoverErr] = useState<Record<string, boolean>>({});
  const failCover = (rid: string) => setCoverErr(m => (m[rid] ? m : { ...m, [rid]: true }));
  const [avoid7, setAvoid7] = useState(() => readFlag("fan_avoid7", true));
  const [quick30, setQuick30] = useState(() => readFlag("fan_quick30", false));
  const [easy, setEasy] = useState(() => readFlag("fan_easy", false));
  const [pantryFirst, setPantryFirst] = useState(() => readFlag("fan_pantry", false));

  function flip() {
    Taro.setStorageSync("fan_avoid7", avoid7 ? "1" : "0");
    Taro.setStorageSync("fan_quick30", quick30 ? "1" : "0");
    Taro.setStorageSync("fan_easy", easy ? "1" : "0");
    Taro.setStorageSync("fan_pantry", pantryFirst ? "1" : "0");
    api.random(q.trim() ? "" : cat, {
      avoidDays: avoid7 ? 7 : 0,
      maxMinutes: quick30 ? 30 : 0,
      difficulty: easy ? "简单" : "",
      usePantry: pantryFirst,
    })
      .then(r => {
        Taro.navigateTo({ url: `/pages/recipe/index?id=${encodeURIComponent(r.id)}` }).then(() => {
          // 后端条件内没菜时会逐级放宽并带 relaxed，翻过去时告诉用户一声，别让人以为条件生效了
          if (r.relaxed) {
            Taro.showToast({ title: "没找到完全符合条件的，放宽了筛选", icon: "none", duration: 2500 });
          }
        });
      })
      .catch(() => Taro.showToast({ title: "食单还空着，先记一餐吧", icon: "none" }));
  }

  function load() {
    return api.recipes().then(({ categories, recipes }) => {
      const used = [...new Set(recipes.map(r => r.category))];
      const all = [...categories.filter(c => used.includes(c)), ...used.filter(c => !categories.includes(c))];
      setCats(all);
      setRecipes(recipes);
      setCat(c => (c && all.includes(c) ? c : all[0] || ""));
      setErr("");
    }).catch(e => {  // 不 catch 的话任何 5xx 都是永久「加载中」
      setErr((e as Error).message);
      toastErr(e);
    });
  }
  useDidShow(() => { load(); });

  if (recipes === null) {
    return (
      <View className="page">
        {err ? <ErrRetry what="食单" err={err} onRetry={load} /> : <Loading />}
      </View>
    );
  }

  const kw = q.trim();
  const shown = kw
    ? recipes.filter(r => r.name.includes(kw) || r.category.includes(kw) || r.ingredients.some(i => i.name.includes(kw)))
    : recipes.filter(r => r.category === cat);

  const toggles: { label: string; on: boolean; set: (v: boolean) => void }[] = [
    { label: "最近 7 天没做过的", on: avoid7, set: setAvoid7 },
    { label: "30 分钟内能做的", on: quick30, set: setQuick30 },
    { label: "只要简单省事的", on: easy, set: setEasy },
    { label: "优先用冰箱里的食材", on: pantryFirst, set: setPantryFirst },
  ];

  return (
    <View className="page">
      <View className="pagehead">
        <View>
          <Text className="seal">箪</Text>
          <View className="h1">我的食单</View>
        </View>
        <View className="headacts">
          <View className="act" hoverClass="btn-hover"
            onClick={() => Taro.navigateTo({ url: "/pages/settings/index" })}>⚙</View>
        </View>
      </View>

      {recipes.length === 0 ? (
        <View className="empty">
          <View className="empty-ico">🍚</View>
          <Text>食单还空着</Text>
          <View className="row empty-acts">
            <View className="btn" hoverClass="btn-hover"
              onClick={() => Taro.switchTab({ url: "/pages/record/index" })}>记下第一顿饭</View>
            <View className="btn ghost" hoverClass="btn-hover"
              onClick={() => api.seedExamples().then(load).catch(toastErr)}>先看看示例食单</View>
          </View>
        </View>
      ) : (
        <>
          {recipes.length > 5 && (
            <View className="searchbar">
              <Input className="ipt" placeholderClass="ph" value={q}
                onInput={e => setQ(e.detail.value)} placeholder="找菜：菜名 / 食材 / 分类" />
              {kw !== "" && <View className="clear" onClick={() => setQ("")}>✕</View>}
            </View>
          )}
          <View className={`fanpill ${fan ? "on" : ""}`} hoverClass="btn-hover" onClick={() => setFan(f => !f)}>
            <Text className="fanpill-ico">🎴</Text>
            <Text className="fanpill-txt">翻牌子 · 今天吃什么</Text>
            <Text className="fanpill-caret">{fan ? "▲" : "▼"}</Text>
          </View>
          {fan && (
            <View className="papercard boxline fanpanel">
              {toggles.map(t => (
                <View key={t.label} className="fanrow" onClick={() => t.set(!t.on)}>
                  <View className={`checkbox ${t.on ? "on" : ""}`}>{t.on ? "✓" : ""}</View>
                  <Text>{t.label}</Text>
                </View>
              ))}
              <View className="btn" hoverClass="btn-hover" onClick={flip}>翻牌子！</View>
            </View>
          )}
          <View className="menu">
            {!kw && (
              <View className="cats">
                {cats.map(c => (
                  <View key={c} className={`catbtn ${c === cat ? "on" : ""}`} hoverClass="btn-hover"
                    onClick={() => setCat(c)}>{c}</View>
                ))}
              </View>
            )}
            <View className="dishes">
              {shown.map(r => (
                <View className="dish" key={r.id} hoverClass="btn-hover"
                  onClick={() => Taro.navigateTo({ url: `/pages/recipe/index?id=${encodeURIComponent(r.id)}` })}>
                  {r.cover && !coverErr[r.id] ? (
                    <View className="coverwrap">
                      <Image className="cover" src={absUrl(r.cover)} mode="aspectFill" lazyLoad onError={() => failCover(r.id)} />
                    </View>
                  ) : (
                    <View className="coverwrap noimg">
                      <View className="ring" />
                      <Text className="rice">🍚</Text>
                      <Text className="noimg-hint">做好拍一张，就有封面了</Text>
                    </View>
                  )}
                  <View className="body">
                    <View className="dname">{r.name}</View>
                    <View className="chips">
                      <Text className="chip">★ {r.rating?.toFixed(1) ?? "—"}</Text>
                      <Text className="chip">做过 {r.times} 回</Text>
                      {r.kcal_effective != null && (
                        <Text className="chip">≈{r.kcal_effective} kcal{(r.servings ?? 1) > 1 ? "/餐" : ""}</Text>
                      )}
                    </View>
                    <View className="go">
                      <Text>查看做法</Text>
                      <Text>›</Text>
                    </View>
                  </View>
                </View>
              ))}
              {shown.length === 0 && (
                <View className="empty">
                  <View className="empty-ico">🍚</View>
                  <Text>{kw ? `没有和「${kw}」相关的菜` : "这个分类还没有菜"}</Text>
                </View>
              )}
            </View>
          </View>
        </>
      )}
    </View>
  );
}
