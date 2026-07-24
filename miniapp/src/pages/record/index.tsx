// 记一餐（移植 web/src/pages/Record.tsx；砍掉：实时取景圆环、圆框拖拽、rembg 双结果
// 选择、AI 精修、换餐具。云端 /api/cutout 返回圆框直裁或 SegmentFood 抠图，取第一个结果。
// 保留：最近做过 chips、新菜、日期 今天/昨天、五星、备注、实测量回填（菜谱越做越精确））
import { useState } from "react";
import Taro, { useDidShow, useDidHide, useRouter } from "@tarojs/taro";
import { Image, Input, Picker, ScrollView, Text, Textarea, View } from "@tarojs/components";
import { api, absUrl, toastErr, uploadCutout, type CutoutResult, type Meal, type Recipe } from "../../api";
import { Loading, Stars } from "../../components/common";
import "./index.scss";

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => fmt(new Date());
const yesterday = () => fmt(new Date(Date.now() - 864e5));

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

  const [recipeId, setRecipeId] = useState("");
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("");
  const [date, setDate] = useState(today());
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
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
    closePicker();
  }
  function startNewDish() {
    setRecipeId("");
    setNewMode(true);
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
    setFraming(path);  // 先进取景确认层，对准盘子再抠
  }

  // 取景确认后真正抠图。圆坐标=居中、r 锁在安全值（实测再紧会丢食材）——
  // 圆的真作用是构图对齐（合成的瓷盘是俯拍，菜摆中间才贴得稳），不提升抠图精度
  // mode=auto 抠成插画盘；mode=photo 留原图（不抠不合成，方裁圆角）
  async function doCutout(path: string, mode: "auto" | "photo") {
    setFraming(null);
    setCutting(true);
    try {
      const r = await uploadCutout(path, { mode, circle: { cx: 0.5, cy: 0.5, r: 0.42 } });
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
      // 盖章庆祝：保存一成功就落印（纯 CSS 动画），期间下面的回填检查照常进行不被阻塞
      const CELEBRATE_MS = 1250;
      const stamped = Date.now();
      setCelebrate(true);
      const afterStamp = (fn?: () => void) =>
        setTimeout(() => { setCelebrate(false); fn?.(); }, Math.max(0, CELEBRATE_MS - (Date.now() - stamped)));
      // 实测量回填：这道菜若有「适量」类模糊量，轻提示补一笔（可一键跳过），菜谱越做越精确
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
      // 新菜是"空壳"（只有名字+分类）：盖完章搭一座桥去补做法——不打断记录（可跳过），
      // 但别让人不知道去哪补（zzf 真机反馈：记餐时找不到写做法的地方）
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
        <Image src={framing} mode="widthFix" className="frameimg" />
        <View className="framering" />
        <View className="framedim framedim-t" />
        <View className="framedim framedim-b" />
      </View>
      <View className="framehint">摆中间、从上往下拍，抠成盘子最服帖；也可以留原样那张照片</View>
      <View className="row frameacts">
        <View className="btn ghost" hoverClass="btn-hover"
          onClick={() => doCutout(framing, "photo")}>留原图</View>
        <View className="btn" hoverClass="btn-hover" onClick={() => doCutout(framing, "auto")}>抠成盘子 ✎</View>
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
          {saving ? "保存中…" : "记下这一餐"}
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
