// 菜谱详情（移植 web/src/pages/Recipe.tsx；砍掉：插画生成按钮、导出长图、编辑器。
// 已有插画照常展示；食材小百科（两行营养对照 + 粗估/无法折算三分支文案）逻辑照抄 web）
import { useEffect, useState } from "react";
import Taro, { useRouter } from "@tarojs/taro";
import { Image, Text, View } from "@tarojs/components";
import { api, absUrl, type IngInfo, type Recipe } from "../../api";
import { Loading } from "../../components/common";
import "./index.scss";

const EMOJI: [RegExp, string][] = [
  [/蛋/, "🥚"], [/玉米/, "🌽"], [/番茄|西红柿/, "🍅"], [/土豆|红薯|薯/, "🥔"], [/萝卜/, "🥕"],
  [/牛/, "🥩"], [/猪|排骨|培根|火腿/, "🥓"], [/鸡|鸭|鹅/, "🍗"], [/鱼/, "🐟"], [/虾/, "🦐"],
  [/豆腐|豆/, "🧊"], [/蒜/, "🧄"], [/姜/, "🫚"], [/葱/, "🌱"], [/辣椒|花椒|胡椒|椒/, "🌶️"],
  [/油|生抽|老抽|酱|醋|料酒|盐|糖|淀粉/, "🧂"], [/米|饭|粥/, "🍚"], [/面|粉/, "🍜"],
  [/芦笋|菜|瓜|笋|菇|芹|蒿|苗|叶/, "🥬"],
];
const icon = (name: string) => EMOJI.find(([re]) => re.test(name))?.[1] ?? name.slice(0, 1);

/** 教程只写「一勺/半勺」这类模糊量时的粗估克重；少许/适量不猜 */
function fuzzyGrams(amount?: string): number | null {
  if (!amount) return null;
  const m = amount.match(/([半一两二三四五]|\d+(?:\.\d+)?)\s*(大勺|汤勺|瓷勺|小勺|茶匙|勺)/);
  if (!m) return null;
  const NUM: Record<string, number> = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };
  const n = NUM[m[1]] ?? parseFloat(m[1]);
  if (!n) return null;
  return Math.round(n * (/小勺|茶匙/.test(m[2]) ? 5 : 15));
}

/** 「少许/适量」这类天然不可量化的词：就算 AI 硬估了克重，也只当粗估看，不摆出精确数字 */
function isVagueAmount(amount?: string): boolean {
  return !!amount && /少许|适量|些许|酌量|随意|适度|少量|一点|微量|若干/.test(amount);
}

interface SheetArgs { name: string; amount?: string; iconUrl?: string; itemKcal?: number; grams?: number }

/** 食材小百科：点食材弹出，AI 生成一次全食单缓存复用 */
function IngredientSheet({ name, amount, iconUrl, itemKcal, grams, onClose }: SheetArgs & { onClose: () => void }) {
  const [info, setInfo] = useState<IngInfo | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setInfo(null);
    setErr("");
    api.ingredient(name).then(setInfo).catch(e => setErr((e as Error).message));
  }, [name]);

  const est = grams ? null : fuzzyGrams(amount);
  const eff = grams ?? est;
  const f = eff != null ? eff / 100 : null;
  const scaled = (v: number | null) => (v == null || f == null ? null : Math.round(v * f * 10) / 10);
  // 有克重、但用量词本身是「少许」这类模糊量：折算照做，但按粗估呈现（≈ + 提示），别装精确
  const rough = grams != null && isVagueAmount(amount);

  return (
    <View className="sheetscrim" onClick={onClose} catchMove>
      <View className="ingsheet" onClick={e => e.stopPropagation()}>
        <View className="ingsheet-head">
          <View className="icon">
            {iconUrl ? <Image src={absUrl(iconUrl)} mode="aspectFill" className="iconimg" /> : <Text>{icon(name)}</Text>}
          </View>
          <View className="titlebox">
            <View className="iname">{name}</View>
            {(amount || grams) && (
              <View className="dimtext">
                本菜用量：{amount}{grams ? `（${rough ? "约 " : ""}${grams}g${rough ? "，粗估" : ""}）` : ""}
              </View>
            )}
          </View>
          <View className="close" onClick={onClose}>✕</View>
        </View>
        {err !== "" && <View className="err">{err}</View>}
        {!info && err === "" && <Loading text="翻小百科中" />}
        {info && (
          <>
            {info.kcal_per_100g != null && (
              <>
                <View className="ingtable">
                  <View className="itr">
                    <Text className="il" />
                    <Text className="ih">kcal</Text>
                    <Text className="ih">蛋白质</Text>
                    <Text className="ih">脂肪</Text>
                    <Text className="ih">碳水</Text>
                  </View>
                  <View className="itr">
                    <Text className="il">每100g</Text>
                    <Text className="iv">{info.kcal_per_100g}</Text>
                    <Text className="iv">{info.protein_g != null ? `${info.protein_g}g` : "—"}</Text>
                    <Text className="iv">{info.fat_g != null ? `${info.fat_g}g` : "—"}</Text>
                    <Text className="iv">{info.carb_g != null ? `${info.carb_g}g` : "—"}</Text>
                  </View>
                  {f != null && (
                    <View className="itr">
                      <Text className="il ac">本菜{grams ? (rough ? ` ≈${grams}g` : ` ${grams}g`) : ` ≈${est}g`}</Text>
                      <Text className="iv ac">{grams != null ? (itemKcal ?? Math.round(info.kcal_per_100g * f)) : Math.round(info.kcal_per_100g * f)}</Text>
                      <Text className="iv ac">{info.protein_g != null ? `${scaled(info.protein_g)}g` : "—"}</Text>
                      <Text className="iv ac">{info.fat_g != null ? `${scaled(info.fat_g)}g` : "—"}</Text>
                      <Text className="iv ac">{info.carb_g != null ? `${scaled(info.carb_g)}g` : "—"}</Text>
                    </View>
                  )}
                </View>
                {grams != null && !rough && <View className="ingsheet-note">本菜行已按 {grams}g 折算；改克重后按比例自动更新</View>}
                {rough && <View className="ingsheet-note">「{amount}」难精确，此处按 ≈{grams}g 粗估，仅作参考</View>}
                {grams == null && est != null && <View className="ingsheet-note">教程未标克重，「{amount}」按 ≈{est}g 粗估折算，仅供参考</View>}
                {grams == null && est == null && amount && <View className="ingsheet-note">教程用量「{amount}」没标克重，无法折算——上表为每100g 标准参考</View>}
              </>
            )}
            {info.benefits.length > 0 && info.benefits.map((b, i) => <View className="ingsheet-line" key={i}>· {b}</View>)}
            {info.tips.length > 0 && (
              <View className="tips sheettips">
                <View className="tips-b">小贴士：</View>
                {info.tips.map((t, i) => <View className="tips-p" key={i}>{t}</View>)}
              </View>
            )}
            <View className="dimtext foot">
              * {f != null ? "按每100克参考值折算" : "每100克参考值"}{info.matched ? `（按「${info.matched}」计）` : ""} · 数值：{info.source ?? "常见参考值"}
              {info.text_source && info.benefits.length > 0 ? ` · 功效贴士：${info.text_source}` : ""} · 仅供参考
            </View>
          </>
        )}
      </View>
    </View>
  );
}

export default function RecipePage() {
  const router = useRouter();
  const id = decodeURIComponent(router.params.id ?? "");
  const [r, setR] = useState<Recipe | null>(null);
  const [missing404, setMissing404] = useState(false);
  const [ingSheet, setIngSheet] = useState<SheetArgs | null>(null);

  useEffect(() => {
    api.recipe(id).then(setR).catch(() => setMissing404(true));
  }, [id]);

  function goRecord() {
    // record 是 tabBar 页，switchTab 带不了参数——预选菜谱走 storage
    Taro.setStorageSync("record_preset", id);
    Taro.switchTab({ url: "/pages/record/index" });
  }

  if (missing404) {
    return (
      <View className="page">
        <View className="empty">
          <View className="empty-ico">🍚</View>
          <Text>这道菜不在食单里了（可能被删除或改了名）</Text>
          <View className="backhome">
            <View className="btn ghost" hoverClass="btn-hover"
              onClick={() => Taro.switchTab({ url: "/pages/index/index" })}>回食单</View>
          </View>
        </View>
      </View>
    );
  }
  if (!r) return <View className="page"><Loading /></View>;

  const hasTutorial = r.ingredients.length > 0 || r.steps.length > 0;
  return (
    <View className="page">
      {r.cover !== "" && (
        <View className="hero">
          <Image src={absUrl(r.cover)} mode="widthFix" className="heroimg" />
        </View>
      )}
      <View className="rtitle">{r.name}</View>
      <View className="stats">
        ★ {r.rating?.toFixed(1) ?? "—"}　做过 {r.times} 回　{r.category}
        {r.difficulty ? `　${r.difficulty}` : ""}{r.minutes != null ? `　⏱${r.minutes}分钟` : ""}
      </View>
      {r.kcal_whole != null && (
        <View className="stats kcalline">
          {(r.servings ?? 1) > 1
            ? <Text>整锅 ≈{r.kcal_whole} kcal · 约 {r.servings} 餐 · 每餐 ≈{r.kcal_effective}</Text>
            : <Text>≈{r.kcal_whole} kcal</Text>}
          {r.kcal_source === "实算" && r.nutrition && (
            <Text className="dimtext">　蛋白{r.nutrition.protein_g}g · 脂肪{r.nutrition.fat_g}g · 碳水{r.nutrition.carb_g}g
              {r.nutrition.missing && r.nutrition.missing.length > 0 && r.nutrition.missing.length <= 2
                ? `（${r.nutrition.missing.join("、")}未计入）` : ""}
            </Text>
          )}
          {r.kcal_source === "AI估算" && <Text className="dimtext">　AI 估算，录克重后自动改为实算</Text>}
        </View>
      )}

      {hasTutorial ? (
        <View className="tcard">
          <View className="tname">{r.name}</View>
          <View className="tby">by zzf</View>
          <View className="tgrid">
            <View className="tcol tcol-ing">
              <View className="th4">食材准备</View>
              {r.ingredients.map((ing, i) => (
                <View className="ing" key={i} hoverClass="btn-hover" onClick={() =>
                  setIngSheet({ name: ing.name, amount: ing.amount, iconUrl: r.illust?.ingredients[i] || undefined,
                    itemKcal: r.nutrition?.per_item?.[i] ?? undefined, grams: ing.grams ?? undefined })}>
                  <View className="icon">
                    {r.illust?.ingredients[i]
                      ? <Image src={absUrl(r.illust.ingredients[i])} mode="aspectFill" className="iconimg" />
                      : <Text>{icon(ing.name)}</Text>}
                  </View>
                  <View className="n">{ing.name}</View>
                  {ing.amount !== "" && <View className="a">{ing.amount}</View>}
                </View>
              ))}
              <View className="dimtext tap-hint">点食材看小百科</View>
            </View>
            <View className="tcol tcol-steps">
              <View className="th4">做法步骤</View>
              {r.steps.map((s, i) => (
                <View className="step" key={i}>
                  <View className="num">{i + 1}</View>
                  <View className="stepbody">
                    <View className="steptext">{s}</View>
                    {r.illust?.steps[i] && <Image src={absUrl(r.illust.steps[i])} mode="widthFix" className="stepimg" />}
                  </View>
                </View>
              ))}
            </View>
          </View>
          {r.tips.length > 0 && (
            <View className="tips">
              <View className="tips-b">小贴士：</View>
              {r.tips.map((t, i) => <View className="tips-p" key={i}>{t}</View>)}
            </View>
          )}
          {(r.annotations?.length ?? 0) > 0 && (
            <View className="zhupi">
              <View className="zhupi-b">朱批</View>
              {r.annotations!.map((a, i) => (
                <View className="zhupi-p" key={i}>
                  <Text className="zhupi-date">{a.date.slice(5).replace("-", "/")}</Text>
                  {a.note}
                </View>
              ))}
            </View>
          )}
        </View>
      ) : (
        <View className="empty">
          <View className="empty-ico">🍚</View>
          <Text>还没录做法（v1 请在 Web 端录入）</Text>
        </View>
      )}

      {r.source !== "" && (
        <View className="source" onClick={() => {
          Taro.setClipboardData({ data: r.source });
        }}>
          教程来源：<Text className="srclink">{r.source}</Text>（点击复制）
        </View>
      )}
      <View className="record-cta">
        <View className="btn" hoverClass="btn-hover" onClick={goRecord}>做完了？记一餐</View>
      </View>
      {ingSheet && <IngredientSheet {...ingSheet} onClose={() => setIngSheet(null)} />}
    </View>
  );
}
