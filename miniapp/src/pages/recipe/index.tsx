// 菜谱详情（移植 web/src/pages/Recipe.tsx；砍掉：插画生成按钮、导出长图、完整编辑器。
// 已有插画照常展示；食材小百科（两行营养对照 + 粗估/无法折算三分支文案）逻辑照抄 web。
// P1-3：没录做法的菜不再指去 Web——AI 代录（贴链接/文案）+ 手动补几笔两个补录入口）
import { useEffect, useState } from "react";
import Taro, { useRouter } from "@tarojs/taro";
import { Image, Input, ScrollView, Text, Textarea, View } from "@tarojs/components";
import { api, absUrl, toastErr, type IngInfo, type Recipe } from "../../api";
import { Loading, PosterSheet } from "../../components/common";
import { CLOUDRUN_HTTP_BASE, LOCAL_BASE } from "../../config";
import "./index.scss";

const isWeapp = process.env.TARO_ENV === "weapp";

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
  const [iconErr, setIconErr] = useState(false);
  useEffect(() => {
    setInfo(null);
    setErr("");
    setIconErr(false);
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
            {iconUrl && !iconErr
              ? <Image src={absUrl(iconUrl)} mode="aspectFill" className="iconimg" onError={() => setIconErr(true)} />
              : <Text>{icon(name)}</Text>}
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
  const [posterUrl, setPosterUrl] = useState("");
  // 云端迁移后，illust / 封面 URL 可能指向不存在的 COS 对象（只有 demo 菜生成过插画）：
  // 记下哪些图 404，当作「没插画」处理，别显示裂图
  const [imgErr, setImgErr] = useState<Record<string, boolean>>({});
  const failImg = (k: string) => setImgErr(m => (m[k] ? m : { ...m, [k]: true }));

  // 补录做法（P1-3）：ai = 贴教程链接/文案 AI 代录；manual = 手动补几笔轻表单
  const [fill, setFill] = useState<"" | "ai" | "manual">("");
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [mIngs, setMIngs] = useState<{ name: string; amount: string; grams: number | null }[]>([]);
  const [mSteps, setMSteps] = useState<string[]>([]);
  const [mSaving, setMSaving] = useState(false);

  useEffect(() => {
    api.recipe(id).then(setR).catch(() => setMissing404(true));
  }, [id]);

  function openManual() {
    if (!r) return;
    // 预填已有食材（grams 跟着行走，存回不丢克重）；空表给三行起步
    const ings = r.ingredients.map(x => ({ name: x.name, amount: x.amount, grams: x.grams ?? null }));
    while (ings.length < 3) ings.push({ name: "", amount: "", grams: null });
    setMIngs(ings);
    setMSteps(r.steps.length > 0 ? [...r.steps] : ["", "", ""]);
    setFill("manual");
  }

  async function aiGo() {
    const raw = aiText.trim();
    if (!raw || aiBusy || !r) return;
    setAiErr("");
    setAiBusy(true);
    try {
      // 粘的是分享链接（抖音口令等）→ 服务端抓文案；纯文字 → 直接整理（判定照抄 web Recipe.tsx）
      const link = raw.match(/https?:\/\/\S+/)?.[0];
      const isLinkMode = !!link && raw.replace(/https?:\/\/\S+/, "").trim().length < 80;
      // 本地 claude-cli 可能 30s+：60s 还没回就温和失败（不重试，避免重复写）
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("管家研读超时了——稍后再试，或先手动补几笔")), 60000));
      const x = await Promise.race([
        api.aiExtract(isLinkMode ? "" : raw, r.source, isLinkMode ? link : undefined),
        timeout,
      ]);
      // PUT 是 merge 语义（body 带的字段覆盖）：只写做法相关字段；菜名/分类是这道菜的身份，不让 AI 改
      const patch: Partial<Recipe> = { id, ingredients: x.ingredients, steps: x.steps, tips: x.tips };
      if (x.kcal != null) patch.kcal = x.kcal;
      if (x.minutes != null) patch.minutes = x.minutes;
      if (x.difficulty) patch.difficulty = x.difficulty;  // 翻牌子的「只要简单省事的」靠它
      // servings 不收：几餐由记一餐后的回填流程问本人，AI 猜的分餐数会带偏 kcal/餐 显示
      if (isLinkMode && link && r.source === "") patch.source = link;  // 顺手补上教程来源（不覆盖已有）
      await api.saveRecipe(patch);
      setR(await api.recipe(id));
      setFill("");
      setAiText("");
    } catch (e) {
      // 分不清是通道没配还是这次没成：问一下 ai/status——没配好就别让人干等，转手动
      const st = await api.aiStatus().catch(() => null);
      if (st && !st.available) {
        Taro.showToast({ title: "AI 通道没配好，先手动补几笔吧", icon: "none" });
        openManual();
      } else {
        setAiErr((e as Error).message || "管家没研读出来，再试一次？");
      }
    } finally {
      setAiBusy(false);
    }
  }

  async function manualSave() {
    if (!r || mSaving) return;
    const ings = mIngs
      .map(x => ({ name: x.name.trim(), amount: x.amount.trim(), grams: x.grams }))
      .filter(x => x.name !== "");
    const steps = mSteps.map(s => s.trim()).filter(s => s !== "");
    if (ings.length === 0 && steps.length === 0) {
      Taro.showToast({ title: "食材或步骤先写一条", icon: "none" });
      return;
    }
    setMSaving(true);
    try {
      await api.saveRecipe({ id, ingredients: ings, steps });
      setR(await api.recipe(id));
      setFill("");
    } catch (e) {
      toastErr(e);
    } finally {
      setMSaving(false);
    }
  }

  function goRecord() {
    // record 是 tabBar 页，switchTab 带不了参数——预选菜谱走 storage
    Taro.setStorageSync("record_preset", id);
    Taro.switchTab({ url: "/pages/record/index" });
  }

  // 教程卡：服务端 PIL 渲染的竖版长图。<Image> 的镜像请求带不上 openid 头，
  // 走 guest token 的 query 放行通道（?t=…）；weapp 需要公网访问域名才能直连图。
  async function openCard() {
    const base = isWeapp ? CLOUDRUN_HTTP_BASE : LOCAL_BASE;
    if (!base) {
      Taro.showToast({ title: "云端才支持导出（未配公网访问域名）", icon: "none" });
      return;
    }
    try {
      const { token } = await api.guestLink();
      setPosterUrl(`${base}/api/recipecard/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);
    } catch (e) {
      toastErr(e, "教程卡没能生成");
    }
  }

  async function delRecipe() {
    if (!r) return;
    const { confirm } = await Taro.showModal({
      title: "删除菜谱",
      content: `删除「${r.name}」？食历里的记录会保留，靠菜名快照继续可读。`,
      confirmText: "删除",
      cancelText: "再想想",
    });
    if (!confirm) return;
    try {
      await api.deleteRecipe(id);
      Taro.navigateBack();
    } catch (e) {
      toastErr(e);
    }
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
      {r.cover !== "" && !imgErr.cover && (
        <View className="hero">
          <Image src={absUrl(r.cover)} mode="widthFix" className="heroimg" onError={() => failImg("cover")} />
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

      {hasTutorial && (
        <View className="tcard">
          <View className="tname">{r.name}</View>
          <View className="tby">by zzf</View>
          <View className="tgrid">
            <View className="tcol tcol-ing">
              <View className="th4">食材准备</View>
              {r.ingredients.map((ing, i) => {
                // illust 存在且没 404 才当有插画：404 的走 emoji 兜底，也不把坏 URL 传进小百科
                const ingIllust = r.illust?.ingredients[i] && !imgErr[`ing${i}`] ? r.illust.ingredients[i] : undefined;
                return (
                  <View className="ing" key={i} hoverClass="btn-hover" onClick={() =>
                    setIngSheet({ name: ing.name, amount: ing.amount, iconUrl: ingIllust,
                      itemKcal: r.nutrition?.per_item?.[i] ?? undefined, grams: ing.grams ?? undefined })}>
                    <View className="icon">
                      {ingIllust
                        ? <Image src={absUrl(ingIllust)} mode="aspectFill" className="iconimg" onError={() => failImg(`ing${i}`)} />
                        : <Text>{icon(ing.name)}</Text>}
                    </View>
                    <View className="n">{ing.name}</View>
                    {ing.amount !== "" && <View className="a">{ing.amount}</View>}
                  </View>
                );
              })}
              <View className="dimtext tap-hint">点食材看小百科</View>
            </View>
            <View className="tcol tcol-steps">
              <View className="th4">做法步骤</View>
              {r.steps.map((s, i) => (
                <View className="step" key={i}>
                  <View className="num">{i + 1}</View>
                  <View className="stepbody">
                    <View className="steptext">{s}</View>
                    {r.illust?.steps[i] && !imgErr[`step${i}`] &&
                      <Image src={absUrl(r.illust.steps[i])} mode="widthFix" className="stepimg" onError={() => failImg(`step${i}`)} />}
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
      )}

      {/* 没有步骤就给补录入口（拆掉「v1 请在 Web 端录入」那堵墙）：AI 代录 + 手动轻表单 */}
      {r.steps.length === 0 && (
        <View className={hasTutorial ? "fillwall slim" : "empty fillwall"}>
          {!hasTutorial && <View className="empty-ico">🍚</View>}
          <Text>{hasTutorial ? "做法步骤还空着" : "还没录做法"}</Text>
          <View className="fill-acts">
            <View className="btn" hoverClass="btn-hover"
              onClick={() => { setAiErr(""); setFill("ai"); }}>贴教程链接/文案，AI 帮你录</View>
            <View className="btn ghost" hoverClass="btn-hover" onClick={openManual}>手动补几笔</View>
          </View>
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
        {hasTutorial && (
          <View className="btn ghost" hoverClass="btn-hover" onClick={openCard}>教程卡（长按可存图）</View>
        )}
        <View className="btn ghost danger" hoverClass="btn-hover" onClick={delRecipe}>删除这道菜</View>
      </View>
      {ingSheet && <IngredientSheet {...ingSheet} onClose={() => setIngSheet(null)} />}
      {posterUrl !== "" && <PosterSheet url={posterUrl} title="插画教程卡" onClose={() => setPosterUrl("")} />}

      {fill === "ai" && (
        <View className="sheetscrim" catchMove onClick={() => { if (!aiBusy) setFill(""); }}>
          <View className="ingsheet fillsheet" onClick={e => e.stopPropagation()}>
            <View className="fillhead">
              <Text className="filltitle">AI 帮你录</Text>
              <View className="close" onClick={() => { if (!aiBusy) setFill(""); }}>✕</View>
            </View>
            <Textarea className="ta filltext" placeholderClass="ph" value={aiText} maxlength={-1}
              disabled={aiBusy} onInput={e => setAiText(e.detail.value)}
              placeholder="粘贴抖音/下厨房链接，或整段文字教程" />
            {aiErr !== "" && <View className="err">{aiErr}</View>}
            <View className={`btn fillgo ${aiBusy || aiText.trim() === "" ? "disabled" : ""}`}
              hoverClass="btn-hover" onClick={aiGo}>
              {aiBusy ? "管家研读中，约需十几秒…" : "开始整理"}
            </View>
          </View>
        </View>
      )}

      {fill === "manual" && (
        <View className="sheetscrim" catchMove onClick={() => setFill("")}>
          <View className="ingsheet fillsheet" onClick={e => e.stopPropagation()}>
            <View className="fillhead">
              <Text className="filltitle">手动补几笔</Text>
              <View className="close" onClick={() => setFill("")}>✕</View>
            </View>
            <ScrollView scrollY className="fillscroll">
              <View className="f">食材（名字 + 用量，空行不算）</View>
              {mIngs.map((x, i) => (
                <View key={i} className="row fillrow">
                  <View className="grow2">
                    <Input className="ipt" placeholderClass="ph" placeholder="食材，如：鸡蛋" value={x.name}
                      onInput={e => {
                        const v = e.detail.value;
                        setMIngs(a => a.map((y, j) => (j === i ? { ...y, name: v } : y)));
                      }} />
                  </View>
                  <View className="grow1">
                    <Input className="ipt" placeholderClass="ph" placeholder="用量，如：2 个" value={x.amount}
                      onInput={e => {
                        const v = e.detail.value;
                        setMIngs(a => a.map((y, j) => (j === i ? { ...y, amount: v } : y)));
                      }} />
                  </View>
                </View>
              ))}
              <View className="fill-add" hoverClass="btn-hover"
                onClick={() => setMIngs(a => [...a, { name: "", amount: "", grams: null }])}>＋ 再加一行食材</View>
              <View className="f">步骤（一行一步，空行不算）</View>
              {mSteps.map((s, i) => (
                <View key={i} className="fillrow">
                  <Textarea className="ta fillstep" placeholderClass="ph" autoHeight maxlength={-1}
                    placeholder={`第 ${i + 1} 步`} value={s}
                    onInput={e => {
                      const v = e.detail.value;
                      setMSteps(a => a.map((y, j) => (j === i ? v : y)));
                    }} />
                </View>
              ))}
              <View className="fill-add" hoverClass="btn-hover"
                onClick={() => setMSteps(a => [...a, ""])}>＋ 再加一步</View>
            </ScrollView>
            <View className={`btn fillgo ${mSaving ? "disabled" : ""}`} hoverClass="btn-hover"
              onClick={manualSave}>{mSaving ? "保存中…" : "补好了，保存"}</View>
          </View>
        </View>
      )}
    </View>
  );
}
