// 菜谱详情（移植 web/src/pages/Recipe.tsx；砍掉：导出长图、完整编辑器（改一笔轻表单代替）。
// 插画生成按钮 R28 补齐（此前漏移植，zzf 反馈"为什么没有生成卡通做法图"）——逐张调用与
// web genAll 同构；食材小百科（两行营养对照 + 粗估/无法折算三分支文案）逻辑照抄 web。
// P1-3：没录做法的菜不再指去 Web——AI 代录（贴链接/文案）+ 手动补几笔两个补录入口）
import { useEffect, useState } from "react";
import Taro, { useRouter } from "@tarojs/taro";
import { Image, Input, ScrollView, Text, Textarea, View } from "@tarojs/components";
import { api, absUrl, toastErr, uploadCutout, type IngInfo, type Meal, type Recipe } from "../../api";
import { extractAndApply, extractFromVideoAndApply } from "../../aiExtract";
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

/** 卡片 URL 的文件名就是 photo_id（形如 p20260730093015-auto.png），后缀是当时抠的 mode——
 * 「抠成盘子」按钮曾误传 mode=auto（无餐具，2026-07-29 前的记录都中招），能靠后缀识别出来，
 * 用已存的抠图（cut/{photo_id}.png）现改摆盘，不用重拍 */
function coverPhotoId(url: string): { pid: string; mode: string } | null {
  const m = url.match(/\/([^/]+)\.png(?:\?|$)/);
  if (!m) return null;
  const pid = m[1];
  const i = pid.lastIndexOf("-");
  return i < 0 ? null : { pid, mode: pid.slice(i + 1) };
}

/** 朱批提到哪个食材：取最长命中，避免"葱"命中"葱花"和"小葱"两行时选错 */
function matchIngredient(note: string, names: string[]): string | null {
  const hits = names.filter(n => n && note.includes(n));
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => (b.length > a.length ? b : a));
}

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

/** 份量换算：把用量文案开头的数字按倍数放大（中文数字也认），仅用于展示，不改菜谱本身。
 * 「少许/适量」这类本来就不是精确用量，认不出数字就原样返回——乘不出意义，不硬凑 */
function scaleAmount(amount: string | undefined, factor: number): string {
  if (!amount || factor === 1) return amount ?? "";
  const CN: Record<string, number> = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const m = amount.match(/^(\d+(?:\.\d+)?|[半一二两三四五六七八九十])(.*)$/);
  if (!m) return amount;
  const n = CN[m[1]] ?? parseFloat(m[1]);
  if (!n) return amount;
  const scaled = n * factor;
  const num = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1).replace(/\.0$/, "");
  return num + m[2];
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
  // 份量换算：纯展示倍数，不写回菜谱、不影响上面「整锅 kcal」的记录口径
  const [portion, setPortion] = useState(1);
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
  // amount0 = 打开表单时的原始用量文案。克重（grams）是跟着某一句用量算出来的，
  // 用量被改了旧克重就不再可信——存回时按 amount0 比对，改过的行丢弃陈旧克重（宁可留白也不装懂）。
  // 小程序这张表单没有克重输入框（web 编辑器有），所以只能这样兜。
  const [mIngs, setMIngs] = useState<{ name: string; amount: string; grams: number | null; amount0: string }[]>([]);
  const [mSteps, setMSteps] = useState<string[]>([]);
  const [mSaving, setMSaving] = useState(false);
  // 从朱批点进来时要定位到哪个食材（ScrollView scrollIntoView 找的就是这个行的 id）
  const [hitIngName, setHitIngName] = useState("");
  // 插画教程卡：逐张生成（每张几十秒），与 web genAll 同构；canIllust 决定按钮是否露出
  const [canIllust, setCanIllust] = useState(false);
  const [gen, setGen] = useState<{ running: boolean; msg: string }>({ running: false, msg: "" });
  // 历史照片：每次记餐带的图本来就是「可选+带日期」的，缺的只是在菜谱页把它们拣出来看——
  // 不新增字段，直接从 meals 里按 recipe_id 过滤（数据量个人规模，客户端筛没有性能问题）
  const [photos, setPhotos] = useState<Meal[]>([]);
  const [coverBusy, setCoverBusy] = useState(false);  // 「换封面」在传新照片，避免重复点
  const [fixBusy, setFixBusy] = useState(false);
  const [coverBust, setCoverBust] = useState(0);  // replate 原地覆盖同名文件，靠这个逼 <Image> 重新拉取

  useEffect(() => {
    api.recipe(id).then(setR).catch(() => setMissing404(true));
    api.meals().then(ms => setPhotos(
      ms.filter(m => m.recipe_id === id && m.photo_card !== "").sort((a, b) => b.date.localeCompare(a.date)),
    )).catch(() => {});
    setPortion(1);
  }, [id]);
  useEffect(() => { api.aiStatus().then(s => setCanIllust(!!s.imagegen?.available)).catch(() => {}); }, []);

  // 从历史照片里选一张设为封面：直接复用已经拍好的图，不用重新拍
  async function setCoverFrom(url: string) {
    if (!r || url === r.cover) return;
    const { confirm } = await Taro.showModal({ title: "换封面", content: "把这张设为封面图？", confirmText: "设为封面" });
    if (!confirm) return;
    try {
      setR(await api.saveRecipe({ id, cover: url }));
    } catch (e) { toastErr(e); }
  }

  // 补个盘子：老照片当年被 mode=auto 的 bug 坑了（没摆盘），不用重拍，
  // 拿当时存的抠图重新摆盘、原地覆盖同一张卡片 URL
  async function fixPlate() {
    if (!r || fixBusy) return;
    const info = coverPhotoId(r.cover);
    if (!info) return;
    setFixBusy(true);
    try {
      await api.replate(info.pid, "plate");
      setCoverBust(Date.now());
      Taro.showToast({ title: "补好了", icon: "success" });
    } catch (e) {
      toastErr(e, "没补上，这张再重拍一次吧");
    } finally {
      setFixBusy(false);
    }
  }

  // 拍/选一张新照片直接当封面：走跟记餐一样的抠图，但用默认居中圆，不进精细取景层——
  // 这只是换个封面图，没必要跟「记一餐」那套精确对准盘子的流程一样重
  async function pickNewCover() {
    if (coverBusy || !r) return;
    let path: string | null = null;
    try {
      if (process.env.TARO_ENV === "weapp") {
        const m = await Taro.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["compressed"] });
        path = m.tempFiles[0]?.tempFilePath ?? null;
      } else {
        const m = await Taro.chooseImage({ count: 1 });
        path = m.tempFilePaths[0] ?? null;
      }
    } catch { return; }  // 用户取消
    if (!path) return;
    setCoverBusy(true);
    try {
      const cut = await uploadCutout(path, { mode: "plate", circle: { cx: 0.5, cy: 0.5, r: 0.42 } });
      if (cut.results.length === 0) throw new Error("没有返回结果");
      setR(await api.saveRecipe({ id, cover: cut.results[0].card }));
    } catch (e) {
      toastErr(e, "这张没抠好，换一张再试");
    } finally {
      setCoverBusy(false);
    }
  }

  function openManual(highlight?: string) {
    if (!r) return;
    // 预填已有食材（grams 跟着行走，存回不丢克重）；空表给三行起步
    const ings = r.ingredients.map(x => ({ name: x.name, amount: x.amount, grams: x.grams ?? null, amount0: x.amount }));
    while (ings.length < 3) ings.push({ name: "", amount: "", grams: null, amount0: "" });
    setMIngs(ings);
    setMSteps(r.steps.length > 0 ? [...r.steps] : ["", "", ""]);
    setHitIngName(highlight ?? "");
    setFill("manual");
  }

  async function aiGo() {
    const raw = aiText.trim();
    if (!raw || aiBusy || !r) return;
    setAiErr("");
    setAiBusy(true);
    const source = r.source;
    try {
      const result = await extractAndApply(id, raw, source);
      setR(result.recipe);
      setFill("");
      setAiText("");
      // 文案没写具体做法（⚠️ 诚实警示）时才问要不要看视频——真花钱、真慢，不是默认路径
      if (result.videoCanRetry && result.link) {
        const link = result.link;
        const { confirm } = await Taro.showModal({
          title: "文案没写具体做法",
          content: "要不要看视频再核对一次做法？要花一点点钱，十几秒就好。",
          confirmText: "看视频", cancelText: "就这样",
        });
        if (confirm) {
          Taro.showLoading({ title: "AI 在看视频…", mask: true });
          try {
            setR(await extractFromVideoAndApply(id, link, source));
          } catch (e) {
            Taro.showToast({ title: `看视频失败：${(e as Error).message}`, icon: "none" });
          } finally {
            Taro.hideLoading();
          }
        }
      }
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
      // 用量被改过的行丢弃旧克重：那个数是按原来那句用量算的（「2个」→110g），
      // 改成「3个」还留 110g，会让营养折算给出一个自信的错数（IngredientSheet 会写「本菜行已按 110g 折算」）
      .map(x => ({ name: x.name.trim(), amount: x.amount.trim(),
                   grams: x.amount.trim() === x.amount0.trim() ? x.grams : null }))
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
  // 与 web 完全同构：illust 数组里空字符串的位置就是还没画的那张
  const missing = !r.illust ? [] : [
    ...r.illust.ingredients.map((u, i) => (!u && r.ingredients[i] ? { kind: "ing" as const, index: i + 1, label: r.ingredients[i].name } : null)),
    ...r.illust.steps.map((u, i) => (!u ? { kind: "step" as const, index: i + 1, label: `步骤 ${i + 1}` } : null)),
  ].filter((x): x is { kind: "ing" | "step"; index: number; label: string } => x !== null);

  // 逐张生成：每张成功后刷新 r（下一轮 missing 会跟着收窄）——中途退出小程序也不怕，
  // 未生成的还是 missing，回来再点一次接着补，不需要额外断点续传逻辑
  async function genAll() {
    setGen({ running: true, msg: "" });
    for (let k = 0; k < missing.length; k++) {
      const it = missing[k];
      setGen({ running: true, msg: `正在画「${it.label}」（${k + 1}/${missing.length}），每张几十秒…` });
      try {
        await api.aiIllustrate(id, it.kind, it.index);
        setR(await api.recipe(id));
      } catch (e) {
        setGen({ running: false, msg: `画到「${it.label}」时失败：${(e as Error).message}` });
        return;
      }
    }
    setGen({ running: false, msg: "" });
  }
  const coverInfo = r.cover ? coverPhotoId(r.cover) : null;
  const coverSrc = absUrl(r.cover) + (coverBust ? (r.cover.includes("?") ? "&" : "?") + "v=" + coverBust : "");
  return (
    <View className="page">
      {r.cover !== "" && !imgErr.cover ? (
        <View className="hero">
          <Image src={coverSrc} mode="widthFix" className="heroimg" onError={() => failImg("cover")} />
          <View className={`herobtn ${coverBusy ? "disabled" : ""}`} hoverClass="btn-hover"
            onClick={() => { if (!coverBusy) pickNewCover(); }}>{coverBusy ? "处理中…" : "换封面"}</View>
          {coverInfo?.mode === "auto" && (
            <View className={`herobtn fixbtn ${fixBusy ? "disabled" : ""}`} hoverClass="btn-hover"
              onClick={() => { if (!fixBusy) fixPlate(); }}>{fixBusy ? "补盘子中…" : "补个盘子"}</View>
          )}
        </View>
      ) : (
        <View className={`heroempty ${coverBusy ? "disabled" : ""}`} hoverClass="btn-hover"
          onClick={() => { if (!coverBusy) pickNewCover(); }}>
          <Text>{coverBusy ? "处理中…" : "＋ 加封面"}</Text>
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

      {photos.length > 0 && (
        <View className="photohist">
          <View className="photohist-t">历史照片</View>
          <ScrollView scrollX className="photohist-row">
            {photos.map(m => (
              <View className={`photohist-item ${m.photo_card === r.cover ? "on" : ""}`} key={m.id}
                hoverClass="btn-hover" onClick={() => setCoverFrom(m.photo_card)}>
                <Image src={absUrl(m.photo_card)} mode="aspectFill" className="photohist-img" />
                <Text className="photohist-date">{m.date.slice(5).replace("-", "/")}</Text>
              </View>
            ))}
          </ScrollView>
          <Text className="dimtext">点一张设为封面</Text>
        </View>
      )}

      {hasTutorial && (
        <View className="tcard">
          <View className="tname">{r.name}</View>
          <View className="tby">by zzf</View>
          <View className="tgrid">
            <View className="tcol tcol-ing">
              <View className="th4">食材准备</View>
              {r.ingredients.length > 0 && (
                <View className="portionbar">
                  <Text className="dimtext">份量</Text>
                  <View className={`stepbtn${portion <= 0.5 ? " off" : ""}`} hoverClass="btn-hover"
                    onClick={() => portion > 0.5 && setPortion(p => Math.max(0.5, Math.round((p - 0.5) * 10) / 10))}>－</View>
                  <Text className="portionval">{portion}×</Text>
                  <View className={`stepbtn${portion >= 5 ? " off" : ""}`} hoverClass="btn-hover"
                    onClick={() => portion < 5 && setPortion(p => Math.min(5, Math.round((p + 0.5) * 10) / 10))}>＋</View>
                  {portion !== 1 && <Text className="dimtext">量按 {portion} 倍算，只是看看，不改菜谱</Text>}
                </View>
              )}
              {r.ingredients.map((ing, i) => {
                // illust 存在且没 404 才当有插画：404 的走 emoji 兜底，也不把坏 URL 传进小百科
                const ingIllust = r.illust?.ingredients[i] && !imgErr[`ing${i}`] ? r.illust.ingredients[i] : undefined;
                const sAmount = scaleAmount(ing.amount, portion);
                const sGrams = ing.grams != null ? Math.round(ing.grams * portion) : null;
                const sKcal = r.nutrition?.per_item?.[i] != null ? Math.round(r.nutrition.per_item[i]! * portion) : undefined;
                return (
                  <View className="ing" key={i} hoverClass="btn-hover" onClick={() =>
                    setIngSheet({ name: ing.name, amount: sAmount, iconUrl: ingIllust,
                      itemKcal: sKcal, grams: sGrams ?? undefined })}>
                    <View className="icon">
                      {ingIllust
                        ? <Image src={absUrl(ingIllust)} mode="aspectFill" className="iconimg" onError={() => failImg(`ing${i}`)} />
                        : <Text>{icon(ing.name)}</Text>}
                    </View>
                    <View className="n">{ing.name}</View>
                    {sAmount !== "" && <View className="a">{sAmount}</View>}
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
              {r.annotations!.map((a, i) => {
                // 朱批提到食材名就能点：直接进编辑表单定位到那一行，省得自己去食材列表里翻
                const hit = matchIngredient(a.note, r.ingredients.map(ing => ing.name));
                return (
                  <View className={`zhupi-p${hit ? " clickable" : ""}`} key={i}
                    onClick={hit ? () => openManual(hit) : undefined}>
                    <Text className="zhupi-date">{a.date.slice(5).replace("-", "/")}</Text>
                    {a.note}
                    {hit && <Text className="zhupi-hint"> → 改「{hit}」</Text>}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      {canIllust && missing.length > 0 && (
        <View className="illustgen">
          <View className={`btn ghost ${gen.running ? "disabled" : ""}`} hoverClass="btn-hover"
            onClick={() => { if (!gen.running) genAll(); }}>
            {gen.running ? gen.msg : `✨ 生成插画教程卡（${missing.length} 张）`}
          </View>
          {!gen.running && gen.msg !== "" && <View className="err">{gen.msg}</View>}
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
            <View className="btn ghost" hoverClass="btn-hover" onClick={() => openManual()}>手动补几笔</View>
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
        {/* M1：有步骤的菜此前没有任何编辑入口（补录墙只在 steps===0 时出现）——
            补一个轻量「改一笔」，复用 openManual 并预填现有食材/步骤，别让用户从空表单重打一遍 */}
        {r.steps.length > 0 && (
          <View className="btn ghost" hoverClass="btn-hover" onClick={() => openManual()}>改一笔</View>
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
              placeholder="粘贴抖音/小红书/B站/下厨房链接，或整段文字教程" />
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
              {/* 同一张轻表单两处复用：没步骤时是「补几笔」，已有步骤时是「改一笔」——标题跟着场景走 */}
              <Text className="filltitle">{r.steps.length > 0 ? "改一笔" : "手动补几笔"}</Text>
              <View className="close" onClick={() => setFill("")}>✕</View>
            </View>
            <ScrollView scrollY className="fillscroll"
              scrollIntoView={hitIngName ? `ingrow-${mIngs.findIndex(x => x.name === hitIngName)}` : undefined}>
              <View className="f">食材（名字 + 用量，空行不算）</View>
              {mIngs.map((x, i) => (
                <View key={i} id={`ingrow-${i}`} className={`row fillrow${x.name === hitIngName ? " hit" : ""}`}>
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
                onClick={() => setMIngs(a => [...a, { name: "", amount: "", grams: null, amount0: "" }])}>＋ 再加一行食材</View>
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
              onClick={manualSave}>{mSaving ? "保存中…" : r.steps.length > 0 ? "改好了，保存" : "补好了，保存"}</View>
          </View>
        </View>
      )}
    </View>
  );
}
