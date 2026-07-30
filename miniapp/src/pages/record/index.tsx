// 记一餐（移植 web/src/pages/Record.tsx；砍掉：rembg 双结果选择、AI 精修、换餐具。
// 云端 /api/cutout 返回圆框直裁或 SegmentFood 抠图，取第一个结果。
// 保留：最近做过 chips、新菜、日期 今天/昨天、五星、备注、实测量回填（菜谱越做越精确））
// 取景圆环 R26 曾锁死居中不给拖（实测圆形预裁不提升抠图精度），R28 真机反馈证伪这个决定——
// 拍进锅里、菜没摆在画面正中的照片，固定圆根本框不住，改回可拖动/可缩放（movable-view 原生手势）。
import { useState } from "react";
import Taro, { useDidShow, useDidHide, useRouter } from "@tarojs/taro";
import { Image, Input, MovableArea, MovableView, Picker, ScrollView, Text, Textarea, View } from "@tarojs/components";
import { api, absUrl, toastErr, uploadCutout, type CutoutResult, type Meal, type Recipe } from "../../api";
import { extractAndApply } from "../../aiExtract";
import { Loading, Stars } from "../../components/common";
import "./index.scss";

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => fmt(new Date());
const yesterday = () => fmt(new Date(Date.now() - 864e5));

// 取景框固定像素方块（不用 % 布局）：圆心/圆半径的换算全靠这个已知常量，不用再异步查节点尺寸
const FRAME_VP = 320;
const RING_FRAC = 0.42;  // 沿用 R25 实测出的安全值：圆再收紧会在裁切阶段丢真实食材

/** 覆盖满 FRAME_VP×FRAME_VP 取景框时的显示尺寸与居中偏移（scale=1 的初始状态，等价 object-fit:cover） */
function coverFit(w: number, h: number) {
  const s = Math.max(FRAME_VP / w, FRAME_VP / h);
  const bw = w * s, bh = h * s;
  return { bw, bh, x: (FRAME_VP - bw) / 2, y: (FRAME_VP - bh) / 2 };
}

interface BackfillState {
  recipe: Recipe;
  items: { i: number; name: string; amount: string; value: string }[];
  askServings: boolean;
  servings: number | null;
}

export default function Record() {
  const router = useRouter();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [recent, setRecent] = useState<{ id: string; name: string }[]>([]);

  const [cutting, setCutting] = useState(false);
  const [framing, setFraming] = useState<string | null>(null);  // 取景确认层：待抠的图路径
  const [picked, setPicked] = useState<CutoutResult | null>(null);
  // 取景圆环可拖动/缩放（zzf 反馈：拍进锅里的菜，居中固定圆根本框不住）——
  // 圆本身固定在取景框正中央，靠拖动/缩放底下的照片来对准，而不是拖圆本身
  const [fImgSize, setFImgSize] = useState<{ w: number; h: number } | null>(null);  // 原图像素尺寸
  const [fBase, setFBase] = useState<{ w: number; h: number } | null>(null);  // 覆盖满取景框时的显示尺寸（scale=1）
  const [fScale, setFScale] = useState(1);
  const [fX, setFX] = useState(0);
  const [fY, setFY] = useState(0);
  // movable-view 的 x/y/scale-value 是「受控」属性——之前直接绑 fX/fY/fScale，
  // 每次拖动/缩放事件都把 state 灌回同一个 prop，微信文档写明"改变这几个值会触发动画"，
  // 于是原生手势每走一帧就叠加一次多余的"跳转动画"，跟手势本身打架，抖得很明显（真机实测反馈）。
  // 修法：prop 只给「这张照片刚打开时」的初始值，从此不再改它；fX/fY/fScale 继续被
  // onChange/onScale 实时更新，但只用来算圆心坐标，不再回灌 prop——手势期间彻底交给原生。
  const [fInit, setFInit] = useState({ x: 0, y: 0 });

  const [recipeId, setRecipeId] = useState("");
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("");
  const [newMethod, setNewMethod] = useState("");  // 记新菜时顺手贴的做法，可空
  const [date, setDate] = useState(today());
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingMethod, setSavingMethod] = useState(false);  // 保存态第二阶段：AI 在整理刚贴的做法
  const [backfill, setBackfill] = useState<BackfillState | null>(null);
  const [celebrate, setCelebrate] = useState(false);  // 保存成功后的盖章微动效（~1.2s 自动散场）

  // 选菜器（替代原 Picker 长列表滑动）：弹层开关 / 弹层内搜索词 / 新菜输入态 / 封面坏图记录
  const [recipesLoaded, setRecipesLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [newMode, setNewMode] = useState(false);
  const [coverErr, setCoverErr] = useState<Record<string, boolean>>({});
  const failCover = (rid: string) => setCoverErr(m => (m[rid] ? m : { ...m, [rid]: true }));

  useDidShow(() => {
    // 详情页「做完了？记一餐」经 switchTab 过来带不了参数，走 storage 预选
    const preset = (Taro.getStorageSync("record_preset") as string) || router.params.id || "";
    if (preset) {
      Taro.removeStorageSync("record_preset");
      setRecipeId(decodeURIComponent(preset));
    }
    api.recipes().then(({ categories, recipes }) => {
      setRecipes(recipes);
      setCats(categories);
      setNewCat(c => c || categories[0] || "");
      setRecipesLoaded(true);
    }).catch(e => { toastErr(e); setRecipesLoaded(true); });
    api.meals().then((ms: Meal[]) => {
      const seen = new Set<string>();
      const rec: { id: string; name: string }[] = [];
      for (const m of ms) {
        if (!seen.has(m.recipe_id) && rec.length < 4) {
          seen.add(m.recipe_id);
          rec.push({ id: m.recipe_id, name: m.recipe_name });
        }
      }
      setRecent(rec);
    }).catch(() => {});
  });

  // 离开本页时若弹层还开着，兜底把原生 tabBar 还原出来（选菜器为遮住 tabBar 会 hideTabBar）
  useDidHide(() => {
    if (pickerOpen) {
      setPickerOpen(false);
      Taro.showTabBar({ animation: false }).catch(() => {});
    }
  });

  function openPicker() {
    setPickerQ("");
    setPickerOpen(true);
    Taro.hideTabBar({ animation: false }).catch(() => {});
  }
  function closePicker() {
    setPickerOpen(false);
    Taro.showTabBar({ animation: false }).catch(() => {});
  }
  function selectRecipe(id: string) {
    setRecipeId(id);
    setNewMode(false);
    setNewMethod("");  // 换了道菜，上一道菜顺手贴的做法不能带过去
    closePicker();
  }
  function startNewDish() {
    setRecipeId("");
    setNewMode(true);
    setNewMethod("");
    closePicker();
  }

  async function pickImagePath(): Promise<string | null> {
    try {
      if (process.env.TARO_ENV === "weapp") {
        const m = await Taro.chooseMedia({
          count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["compressed"],
        });
        return m.tempFiles[0]?.tempFilePath ?? null;
      }
      const m = await Taro.chooseImage({ count: 1 });
      return m.tempFilePaths[0] ?? null;
    } catch {
      return null;  // 用户取消
    }
  }

  async function choosePhoto() {
    const path = await pickImagePath();
    if (!path) return;
    setErr("");
    setPicked(null);
    setFScale(1);
    try {
      // 拿原图像素尺寸算取景框的初始覆盖尺寸/居中偏移；失败就退回旧的居中默认圆（见 currentCircle）
      const info = await Taro.getImageInfo({ src: path });
      const { bw, bh, x, y } = coverFit(info.width, info.height);
      setFImgSize({ w: info.width, h: info.height });
      setFBase({ w: bw, h: bh });
      setFX(x);
      setFY(y);
      setFInit({ x, y });  // 只在这里设一次，movable-view 的 x/y prop 往后不会再变
    } catch {
      setFImgSize(null);
      setFBase(null);
    }
    setFraming(path);  // 先进取景确认层，对准盘子再抠
  }

  // 圆环固定在取景框正中央——靠拖动/缩放底下的照片来对准，不是拖圆本身。
  // 把当前的拖拽/缩放状态换算成原图坐标系里的参考圆（cx/cy 是原图宽高比例，r 是短边比例，
  // 与 server/cutout.py 的 _crop_to_circle 约定一致）；拿不到原图尺寸就退回旧的居中默认值。
  function currentCircle(): { cx: number; cy: number; r: number } {
    if (!fImgSize || !fBase) return { cx: 0.5, cy: 0.5, r: RING_FRAC };
    const dispW = fBase.w * fScale, dispH = fBase.h * fScale;
    const ringCx = FRAME_VP / 2, ringCy = FRAME_VP / 2, ringR = FRAME_VP * RING_FRAC;
    const cx = (ringCx - fX) / dispW;
    const cy = (ringCy - fY) / dispH;
    const natScale = dispW / fImgSize.w;  // 屏幕像素 → 原图像素的缩放系数（等比，dispH/fImgSize.h 同值）
    const r = ringR / natScale / Math.min(fImgSize.w, fImgSize.h);
    return { cx, cy, r };
  }

  // mode=plate 抠成插画盘；mode=photo 留原图（不抠不合成，方裁圆角）
  async function doCutout(path: string, mode: "plate" | "photo") {
    const circle = currentCircle();
    setFraming(null);
    setCutting(true);
    try {
      const r = await uploadCutout(path, { mode, circle });
      if (r.results.length === 0) throw new Error("没有返回结果");
      setPicked(r.results[0]);
    } catch (e) {
      toastErr(e, mode === "photo" ? "这张没存上" : "这张没抠好");
      setErr(mode === "photo" ? "这张没存上——换一张再试，或不带图直接记"
        : "这张没抠好——可以留原图，或换一张，或不带图直接记录");
    } finally {
      setCutting(false);
    }
  }

  function resetForm() {
    setPicked(null);
    setRecipeId("");
    setNewName("");
    setNewMethod("");
    setDate(today());
    setRating(null);
    setNote("");
    setErr("");
    setBackfill(null);
    setNewMode(false);
  }

  function done() {
    resetForm();
    Taro.switchTab({ url: "/pages/timeline/index" });
  }

  async function save() {
    setErr("");
    if (!recipeId && !newName.trim()) {
      setErr("选一道菜，或者给新菜起个名字");
      Taro.showToast({ title: "选一道菜，或者给新菜起个名字", icon: "none" });
      return;
    }
    setSaving(true);
    try {
      const meal = await api.addMeal({
        recipe_id: recipeId || undefined,
        new_recipe: recipeId ? undefined : { name: newName.trim(), category: newCat },
        photo_id: picked?.photo_id,
        date, rating, note,
      });
      // 今日荐预热：记一餐会让 AI 荐的缓存失效，趁盖章动画顺手让服务端先算——
      // fire-and-forget，结果丢弃，失败无感（首页下次打开就不用等 20 秒了）
      api.suggest().catch(() => {});
      // 盖章庆祝：保存一成功就落印（纯 CSS 动画），期间下面的回填检查/做法整理照常进行不被阻塞
      const CELEBRATE_MS = 1250;
      const stamped = Date.now();
      setCelebrate(true);
      const afterStamp = (fn?: () => void) =>
        setTimeout(() => { setCelebrate(false); fn?.(); }, Math.max(0, CELEBRATE_MS - (Date.now() - stamped)));
      // 新菜顺手贴了做法：立刻整理写回，不用先保存完再跳一次菜谱页去补
      // （zzf 反馈：为什么不能顺便记做法，非要专门再去一趟）。整理失败不挡路，
      // 照旧走下面「去补做法」的桥——methodApplied 只用来决定还要不要问那句话。
      let methodApplied = false;
      // 新菜、或选了没做法的老菜时顺手贴的做法，都在这一步整理写回——不再限定「必须是新菜」
      // （zzf 反馈：选已有但没做法的菜，记餐时同样应该能顺手补，别只照顾新菜那条路）
      if (meal.recipe_id && newMethod.trim() !== "") {
        setSavingMethod(true);
        try {
          await extractAndApply(meal.recipe_id, newMethod.trim(), "");
          methodApplied = true;
        } catch { /* AI 没整理出来：静默降级，走后面的「去补做法」桥，不是死路 */ }
        setSavingMethod(false);
      }
      // 实测量回填：这道菜若有「适量」类模糊量，轻提示补一笔（可一键跳过），菜谱越做越精确
      // 用整理做法后的最新食材查——methodApplied 的话食材已经不是空壳了
      try {
        const rec = await api.recipe(meal.recipe_id);
        const fuzzy = rec.ingredients
          .map((ing, i) => ({ i, name: ing.name, amount: ing.amount, value: "" }))
          .filter(x => !x.amount || /适量|少许|随意|若干|一点/.test(x.amount));
        const askServings = (rec.servings ?? 1) === 1 && (rec.kcal_whole ?? 0) > 1200;
        if (fuzzy.length > 0 || askServings) {
          setBackfill({ recipe: rec, items: fuzzy, askServings, servings: null });
          afterStamp();  // 印章散场后露出底下的回填页
          return;
        }
      } catch { /* 回填是锦上添花，失败不挡路 */ }
      // 做法已经顺手整理完了，不用再问一遍「去补做法」——直接收尾
      if (methodApplied) {
        afterStamp(done);
        return;
      }
      // 新菜是"空壳"（只有名字+分类，且没贴做法/AI 没整理出来）：盖完章搭一座桥去补做法——
      // 不打断记录（可跳过），但别让人不知道去哪补
      if (!recipeId && meal.recipe_id) {
        afterStamp(async () => {
          const { confirm } = await Taro.showModal({
            title: "新菜已立档",
            content: "做法可以贴教程链接让 AI 录，或手动补几笔——现在去？",
            confirmText: "去补做法",
            cancelText: "下次再说",
          });
          done();
          if (confirm) {
            Taro.navigateTo({ url: `/pages/recipe/index?id=${encodeURIComponent(meal.recipe_id)}` });
          }
        });
        return;
      }
      afterStamp(done);  // 章落定再走原有的重置/跳转
    } catch (e) {
      toastErr(e);
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveBackfill() {
    if (!backfill) return;
    const filled = backfill.items.filter(x => x.value.trim());
    const patch: Partial<Recipe> = { ...backfill.recipe };
    let dirty = false;
    if (filled.length > 0) {
      patch.ingredients = backfill.recipe.ingredients.map((ing, idx) => {
        const it = filled.find(x => x.i === idx);
        return it ? { ...ing, amount: it.value.trim() } : ing;
      });
      dirty = true;
    }
    if (backfill.servings && backfill.servings > 1) {
      patch.servings = backfill.servings;
      dirty = true;
    }
    try {
      if (dirty) await api.saveRecipe(patch);
    } catch (e) {
      toastErr(e);
      return;
    }
    done();
  }

  // 盖章庆祝浮层：全屏但只活 ~1.2s，动画期间顺手挡住重复点击（不是流程阻塞）
  const celebrateOverlay = celebrate ? (
    <View className="celebrate" catchMove>
      <View className="celebrate-seal">记</View>
      <Text className="celebrate-txt">已记入食历</Text>
    </View>
  ) : null;

  if (backfill) {
    return (
      <View className="page">
        {celebrateOverlay}
        <Text className="seal">记</Text>
        <View className="h1">记好了！顺手补一笔？</View>
        {backfill.items.length > 0 && (
          <View className="hint nomt">
            「{backfill.recipe.name}」有 {backfill.items.length} 个用量还是“大概”——这次实际放了多少？填了下次就能照做（不填也没关系）。
          </View>
        )}
        {backfill.askServings && (
          <>
            <View className="f">这一锅够吃几餐？（整锅 ≈{backfill.recipe.kcal_whole} kcal，分几餐记账更准）</View>
            <View className="chips">
              {[1, 2, 3, 4].map(n => (
                <View key={n} className={`chip pick ${backfill.servings === n ? "on" : ""}`}
                  onClick={() => setBackfill(b => b && ({ ...b, servings: n }))}>{n} 餐</View>
              ))}
            </View>
          </>
        )}
        {backfill.items.map((it, k) => (
          <View key={it.i}>
            <View className="f">{it.name}（现在是：{it.amount || "没写"}）</View>
            <Input className="ipt" placeholderClass="ph" placeholder="如：1勺半 / 10毫升 / 两瓣" value={it.value}
              onInput={e => {
                const v = e.detail.value;
                setBackfill(b => b && ({ ...b, items: b.items.map((x, j) => j === k ? { ...x, value: v } : x) }));
              }} />
          </View>
        ))}
        <View className="row acts">
          <View className="btn ghost" hoverClass="btn-hover" onClick={done}>下次再说</View>
          <View className="btn" hoverClass="btn-hover" onClick={saveBackfill}>回填保存</View>
        </View>
      </View>
    );
  }

  const curRecipe = recipes.find(r => r.id === recipeId);
  const pickerKw = pickerQ.trim();
  const pickerList = pickerKw
    ? recipes.filter(r => r.name.includes(pickerKw) || r.category.includes(pickerKw) || r.ingredients.some(i => i.name.includes(pickerKw)))
    : recipes;

  const framingOverlay = framing ? (
    <View className="framemask" catchMove>
      {/* 右上角退出：拍完不想抠也能走，这餐不配图直接记（抠图本就是可选的） */}
      <View className="frameclose" hoverClass="btn-hover" onClick={() => setFraming(null)}>✕</View>
      <View className="frametitle">对准盘子</View>
      <View className="framewrap">
        {fBase ? (
          <MovableArea className="framearea">
            <MovableView className="framemove" direction="all" scale scaleMin={1} scaleMax={4}
              x={fInit.x} y={fInit.y} scaleValue={1}
              style={{ width: `${fBase.w}px`, height: `${fBase.h}px` }}
              onChange={e => { setFX(e.detail.x); setFY(e.detail.y); }}
              onScale={e => { setFScale(e.detail.scale); setFX(e.detail.x); setFY(e.detail.y); }}>
              <Image src={framing} mode="scaleToFill" className="frameimg-mv" />
            </MovableView>
          </MovableArea>
        ) : (
          // 拿不到原图尺寸时的退化展示：静态居中裁一张，不给拖拽（仍能抠图，只是圆不能对）
          <Image src={framing} mode="aspectFill" className="frameimg" />
        )}
        <View className="framering" />
      </View>
      <View className="framehint">
        {fBase ? "拖动、双指捏合缩放，把菜挪到圈里；也可以留原样那张照片" : "摆中间、从上往下拍，抠成盘子最服帖；也可以留原样那张照片"}
      </View>
      <View className="row frameacts">
        <View className="btn ghost" hoverClass="btn-hover"
          onClick={() => doCutout(framing, "photo")}>留原图</View>
        <View className="btn" hoverClass="btn-hover" onClick={() => doCutout(framing, "plate")}>抠成盘子 ✎</View>
      </View>
      <View className="row framesubacts">
        <View className="frameskip" hoverClass="btn-hover"
          onClick={() => { setFraming(null); choosePhoto(); }}>换一张</View>
        <View className="frameskip" hoverClass="btn-hover" onClick={() => setFraming(null)}>不加图，直接记</View>
      </View>
    </View>
  ) : null;

  return (
    <View className="page">
      {celebrateOverlay}
      {framingOverlay}
      <Text className="seal">记</Text>
      <View className="h1">记一餐</View>

      <View className="f">今天做的饭</View>
      {picked ? (
        <>
          <View className="preview">
            <Image src={absUrl(picked.card)} mode="widthFix" className="previewimg" />
          </View>
          <View className="row acts-sm">
            <View className="btn ghost" hoverClass="btn-hover"
              onClick={() => { setPicked(null); choosePhoto(); }}>换一张</View>
          </View>
        </>
      ) : cutting ? (
        <Loading text="抠图中" />
      ) : (
        <>
          <View className="row">
            <View className="btn ghost" hoverClass="btn-hover" onClick={choosePhoto}>📷 拍照 / 从相册选</View>
          </View>
          <View className="hint">俯拍 · 盘子拍全 · 背景越素抠得越准。不拍照也可以往下记。</View>
        </>
      )}
      {err !== "" && <View className="err">{err}</View>}

      <View className="f">这是哪道菜</View>
      {newMode ? (
        <View className="newpick">
          <View className="row newrow">
            <View className="grow">
              <Input className="ipt" placeholderClass="ph" placeholder="新菜名，如：云吞面" value={newName}
                onInput={e => setNewName(e.detail.value)} />
            </View>
            <View className="catcol">
              <Picker mode="selector" range={cats} value={Math.max(0, cats.indexOf(newCat))}
                onChange={e => setNewCat(cats[Number(e.detail.value)] ?? newCat)}>
                <View className="selectbox">
                  <Text>{newCat || "分类"}</Text>
                  <Text className="caret">▾</Text>
                </View>
              </Picker>
            </View>
          </View>
          <View className="switchpick" onClick={openPicker}>‹ 从已有食单里选</View>
          {/* 顺手记做法：不用先存了新菜再专门跑一趟菜谱页去补——贴了就在保存时一起整理 */}
          <View className="f">做法（可选，贴教程链接/文案，AI 帮你整理；不写也行，之后随时能补）</View>
          <Textarea className="ta" placeholderClass="ph" value={newMethod} maxlength={-1}
            onInput={e => setNewMethod(e.detail.value)}
            placeholder="粘贴抖音/小红书/B站/下厨房链接，或整段文字教程" />
        </View>
      ) : (
        <View className="dishpick" hoverClass="btn-hover" onClick={openPicker}>
          {curRecipe ? (
            <>
              <View className={`dp-thumb ${curRecipe.cover && !coverErr[curRecipe.id] ? "" : "noimg"}`}>
                {curRecipe.cover && !coverErr[curRecipe.id]
                  ? <Image className="dp-img" src={absUrl(curRecipe.cover)} mode="aspectFill" onError={() => failCover(curRecipe.id)} />
                  : <Text className="dp-rice">🍚</Text>}
              </View>
              <View className="dp-body">
                <Text className="dp-name">{curRecipe.name}</Text>
                <Text className="dp-meta">
                  {curRecipe.category}
                  {curRecipe.kcal_effective != null ? ` · ≈${curRecipe.kcal_effective} kcal${(curRecipe.servings ?? 1) > 1 ? "/餐" : ""}` : ""}
                </Text>
              </View>
              <Text className="dp-action">重选</Text>
            </>
          ) : (
            <>
              <Text className="dp-placeholder">选一道菜</Text>
              <Text className="caret">▾</Text>
            </>
          )}
        </View>
      )}
      {/* 选中的是已有但还没做法的菜：顺手贴一下，跟新菜那条路一样在保存时一起整理——
          放在 dishpick 外面（那个 View 整块点击都会重新打开选菜器，textarea 得单独放） */}
      {!newMode && curRecipe && curRecipe.steps.length === 0 && (
        <>
          <View className="f">这道菜还没做法，顺手贴一下？（可选，AI 帮你整理；不写也行，之后随时能补）</View>
          <Textarea className="ta" placeholderClass="ph" value={newMethod} maxlength={-1}
            onInput={e => setNewMethod(e.detail.value)}
            placeholder="粘贴抖音/小红书/B站/下厨房链接，或整段文字教程" />
        </>
      )}

      <View className="f">日期</View>
      <View className="chips datechips">
        <View className={`chip pick ${date === today() ? "on" : ""}`} onClick={() => setDate(today())}>今天</View>
        <View className={`chip pick ${date === yesterday() ? "on" : ""}`} onClick={() => setDate(yesterday())}>昨天（补记）</View>
      </View>
      <Picker mode="date" value={date} onChange={e => setDate(e.detail.value)}>
        <View className="selectbox">
          <Text>{date}</Text>
          <Text className="caret">▾</Text>
        </View>
      </Picker>

      <View className="f">品味（这顿做得怎么样，不评也行）</View>
      <Stars value={rating} onChange={setRating} />

      <View className="f">备注（口味调整、下次注意…）</View>
      <Textarea className="ta" placeholderClass="ph" value={note} maxlength={-1}
        onInput={e => setNote(e.detail.value)}
        placeholder="例：牛排腌 10 分钟刚好，芦笋焯水别超过 40 秒" />

      <View className="acts">
        <View className={`btn ${saving || cutting ? "disabled" : ""}`} hoverClass="btn-hover"
          onClick={() => { if (!saving && !cutting) save(); }}>
          {savingMethod ? "AI 整理做法中…" : saving ? "保存中…" : "记下这一餐"}
        </View>
      </View>

      {pickerOpen && (
        <View className="pickerscrim" catchMove onClick={closePicker}>
          <View className="pickersheet" onClick={e => e.stopPropagation()}>
            <View className="pickerhead">
              <View className="pickertitle">
                <Text className="pt-h">选一道菜</Text>
                <View className="pickerclose" onClick={closePicker}>✕</View>
              </View>
              <View className="pickersearch">
                <Input className="ipt" placeholderClass="ph" value={pickerQ}
                  onInput={e => setPickerQ(e.detail.value)} placeholder="搜索：菜名 / 食材 / 分类" />
                {pickerQ !== "" && <View className="pickersearch-clear" onClick={() => setPickerQ("")}>✕</View>}
              </View>
              {pickerKw === "" && recent.length > 0 && (
                <View className="pickerrecent">
                  <Text className="pickerrecent-label">最近做过</Text>
                  <View className="chips">
                    {recent.map(r => (
                      <View key={r.id} className="chip pick" hoverClass="btn-hover"
                        onClick={() => selectRecipe(r.id)}>{r.name}</View>
                    ))}
                  </View>
                </View>
              )}
            </View>
            <ScrollView scrollY className="pickerlist" style={{ maxHeight: "50vh" }}>
              {!recipesLoaded ? (
                <Loading text="读取食单" />
              ) : pickerList.length === 0 ? (
                <View className="empty">
                  <View className="empty-ico">🍚</View>
                  <Text>{pickerKw ? `没有和「${pickerKw}」相关的菜` : "食单还空着，记一道新菜吧"}</Text>
                </View>
              ) : (
                pickerList.map(r => (
                  <View className="pickeritem" key={r.id} hoverClass="btn-hover" onClick={() => selectRecipe(r.id)}>
                    <View className={`dp-thumb ${r.cover && !coverErr[r.id] ? "" : "noimg"}`}>
                      {r.cover && !coverErr[r.id]
                        ? <Image className="dp-img" src={absUrl(r.cover)} mode="aspectFill" lazyLoad onError={() => failCover(r.id)} />
                        : <Text className="dp-rice">🍚</Text>}
                    </View>
                    <View className="pi-body">
                      <Text className="pi-name">{r.name}</Text>
                      <View className="pi-meta">
                        <Text className="pi-cat">{r.category}</Text>
                        {r.kcal_effective != null && (
                          <Text className="pi-kcal">≈{r.kcal_effective} kcal{(r.servings ?? 1) > 1 ? "/餐" : ""}</Text>
                        )}
                      </View>
                    </View>
                    <Text className="pi-go">›</Text>
                  </View>
                ))
              )}
            </ScrollView>
            <View className="pickerfoot">
              <View className="btn ghost" hoverClass="btn-hover" onClick={startNewDish}>＋ 记一道新菜</View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
