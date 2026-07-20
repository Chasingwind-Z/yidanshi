// 菜谱详情 —— 从 web/src/pages/Recipe.tsx 移植：封面、热量两口径、教程卡、食材小百科弹层、朱批
import { View, Text, Image } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useEffect, useState } from "react";
import { api, imgUrl, type IngInfo, type Recipe } from "../../api";
import "./index.scss";

/** 教程只写「一勺/半勺」这类模糊量时的粗估克重；少许/适量不猜（与 web 版同源逻辑） */
function fuzzyGrams(amount?: string): number | null {
  if (!amount) return null;
  const m = amount.match(/([半一两二三四五]|\d+(?:\.\d+)?)\s*(大勺|汤勺|瓷勺|小勺|茶匙|勺)/);
  if (!m) return null;
  const NUM: Record<string, number> = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };
  const n = NUM[m[1]] ?? parseFloat(m[1]);
  if (!n) return null;
  return Math.round(n * (/小勺|茶匙/.test(m[2]) ? 5 : 15));
}
const isVague = (amount?: string) => !!amount && /少许|适量|些许|酌量|随意|适度|少量|一点|微量|若干/.test(amount);

function IngSheet({ name, amount, grams, onClose }: { name: string; amount?: string; grams?: number | null; onClose: () => void }) {
  const [info, setInfo] = useState<IngInfo | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.ingredient(name).then(setInfo).catch(e => setErr((e as Error).message));
  }, [name]);

  const est = grams ? null : fuzzyGrams(amount);
  const eff = grams ?? est;
  const f = eff != null ? eff / 100 : null;
  const rough = grams != null && isVague(amount);
  const scaled = (v: number | null) => (v == null || f == null ? null : Math.round(v * f * 10) / 10);

  return (
    <View className="scrim" onClick={onClose}>
      <View className="sheet" onClick={e => e.stopPropagation()}>
        <View className="sheethead">
          <Text className="sheetname">{name}</Text>
          {(amount || grams) && (
            <Text className="dimtext">本菜用量：{amount}{grams ? `（${rough ? "约 " : ""}${grams}g${rough ? "，粗估" : ""}）` : ""}</Text>
          )}
        </View>
        {err && <View className="err">{err}</View>}
        {!info && !err && <View className="loading">翻小百科中</View>}
        {info && (
          <View>
            {info.kcal_per_100g != null && (
              <View>
                <View className="ingtable">
                  <View className="row head">
                    <Text className="c l" /><Text className="c">kcal</Text><Text className="c">蛋白质</Text><Text className="c">脂肪</Text><Text className="c">碳水</Text>
                  </View>
                  <View className="row">
                    <Text className="c l">每100g</Text>
                    <Text className="c">{info.kcal_per_100g}</Text>
                    <Text className="c">{info.protein_g != null ? `${info.protein_g}g` : "—"}</Text>
                    <Text className="c">{info.fat_g != null ? `${info.fat_g}g` : "—"}</Text>
                    <Text className="c">{info.carb_g != null ? `${info.carb_g}g` : "—"}</Text>
                  </View>
                  {f != null && (
                    <View className="row ac">
                      <Text className="c l">本菜{grams ? (rough ? ` ≈${grams}g` : ` ${grams}g`) : ` ≈${est}g`}</Text>
                      <Text className="c">{Math.round((info.kcal_per_100g || 0) * f)}</Text>
                      <Text className="c">{info.protein_g != null ? `${scaled(info.protein_g)}g` : "—"}</Text>
                      <Text className="c">{info.fat_g != null ? `${scaled(info.fat_g)}g` : "—"}</Text>
                      <Text className="c">{info.carb_g != null ? `${scaled(info.carb_g)}g` : "—"}</Text>
                    </View>
                  )}
                </View>
                {grams != null && !rough && <Text className="note">本菜行已按 {grams}g 折算；改克重后按比例自动更新</Text>}
                {rough && <Text className="note">「{amount}」难精确，此处按 ≈{grams}g 粗估，仅作参考</Text>}
                {grams == null && est != null && <Text className="note">教程未标克重，「{amount}」按 ≈{est}g 粗估折算，仅供参考</Text>}
                {grams == null && est == null && amount && <Text className="note">教程用量「{amount}」没标克重，无法折算——上表为每100g 标准参考</Text>}
              </View>
            )}
            {info.benefits.map((b, i) => <Text className="line" key={i}>· {b}</Text>)}
            {info.tips.length > 0 && (
              <View className="tipsbox">
                <Text className="tipst">小贴士：</Text>
                {info.tips.map((t, i) => <Text className="line" key={i}>{t}</Text>)}
              </View>
            )}
            <Text className="note">* 数值：{info.source ?? "常见参考值"}{info.matched ? `（按「${info.matched}」计）` : ""} · 仅供参考</Text>
          </View>
        )}
      </View>
    </View>
  );
}

export default function RecipePage() {
  const { params } = useRouter();
  const id = params.id || "";
  const [r, setR] = useState<Recipe | null>(null);
  const [missing, setMissing] = useState(false);
  const [sheet, setSheet] = useState<{ name: string; amount?: string; grams?: number | null } | null>(null);

  useEffect(() => {
    api.recipe(id).then(setR).catch(() => setMissing(true));
  }, [id]);

  if (missing) return <View className="page"><View className="empty">这道菜不在食单里了</View></View>;
  if (!r) return <View className="page"><View className="loading">加载中</View></View>;

  return (
    <View className="page">
      {r.cover && <Image className="hero" src={imgUrl(r.cover)} mode="aspectFill" />}
      <Text className="rtitle">{r.name}</Text>
      <View className="stats">
        <Text>★ {r.rating != null ? r.rating.toFixed(1) : "—"}　做过 {r.times} 回　{r.category}
          {r.difficulty ? `　${r.difficulty}` : ""}{r.minutes != null ? `　⏱${r.minutes}分钟` : ""}</Text>
      </View>
      {r.kcal_whole != null && (
        <View className="stats">
          <Text>{(r.servings ?? 1) > 1
            ? `整锅 ≈${r.kcal_whole} kcal · 约 ${r.servings} 餐 · 每餐 ≈${r.kcal_effective}`
            : `≈${r.kcal_whole} kcal`}</Text>
          {r.kcal_source === "实算" && r.nutrition && (
            <Text className="dimtext">　蛋白{r.nutrition.protein_g}g · 脂肪{r.nutrition.fat_g}g · 碳水{r.nutrition.carb_g}g</Text>
          )}
          {r.kcal_source === "AI估算" && <Text className="dimtext">　AI 估算，录克重后自动改为实算</Text>}
        </View>
      )}

      {(r.ingredients.length > 0 || r.steps.length > 0) && (
        <View className="tcard">
          <Text className="tname">{r.name}</Text>
          <View className="tsec">
            <Text className="th">食材准备</Text>
            <View className="ings">
              {r.ingredients.map((ing, i) => (
                <View className="ing" key={i}
                  onClick={() => setSheet({ name: ing.name, amount: ing.amount, grams: ing.grams })}>
                  {r.illust?.ingredients[i]
                    ? <Image className="icon" src={imgUrl(r.illust.ingredients[i])} mode="aspectFit" />
                    : <View className="icontxt">{ing.name.slice(0, 1)}</View>}
                  <Text className="n">{ing.name}</Text>
                  {ing.amount && <Text className="a">{ing.amount}</Text>}
                </View>
              ))}
            </View>
            <Text className="dimtext center">点食材看小百科</Text>
          </View>
          <View className="tsec">
            <Text className="th">做法步骤</Text>
            {r.steps.map((s, i) => (
              <View className="step" key={i}>
                <View className="num">{i + 1}</View>
                <View className="stepbody">
                  <Text>{s}</Text>
                  {r.illust?.steps[i] && <Image className="stepimg" src={imgUrl(r.illust.steps[i])} mode="widthFix" />}
                </View>
              </View>
            ))}
          </View>
          {r.tips.length > 0 && (
            <View className="tips">
              <Text className="tipst">小贴士：</Text>
              {r.tips.map((t, i) => <Text className="line" key={i}>{t}</Text>)}
            </View>
          )}
          {(r.annotations?.length ?? 0) > 0 && (
            <View className="zhupi">
              <Text className="zhupit">朱批</Text>
              {r.annotations!.map((a, i) => (
                <Text className="line" key={i}>{a.date.slice(5).replace("-", "/")}　{a.note}</Text>
              ))}
            </View>
          )}
        </View>
      )}

      <View className="btn" style={{ marginTop: "32rpx" }}
        onClick={() => Taro.showToast({ title: "记一餐页面移植中", icon: "none" })}>做完了？记一餐</View>

      {sheet && <IngSheet {...sheet} onClose={() => setSheet(null)} />}
    </View>
  );
}
