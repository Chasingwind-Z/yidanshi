import { useEffect, useRef, useState } from "react";
import { api, type Meal, type Recipe } from "../api";

const fmt = (d: Date) => d.toLocaleDateString("sv");  // YYYY-MM-DD
const today = () => fmt(new Date());
const yesterday = () => fmt(new Date(Date.now() - 864e5));

type Circle = { cx: number; cy: number; r: number };
type CardResult = { mode: string; photo_id: string; card: string };

/** 透明 PNG（iPhone 长按抠图导出）客户端快速识别：四角 alpha 为 0 */
async function looksTransparent(f: File): Promise<boolean> {
  if (f.type !== "image/png") return false;
  const bmp = await createImageBitmap(f);
  const cv = document.createElement("canvas");
  cv.width = cv.height = 8;
  const ctx = cv.getContext("2d")!;
  for (const [sx, sy] of [[0, 0], [bmp.width - 8, 0], [0, bmp.height - 8], [bmp.width - 8, bmp.height - 8]]) {
    ctx.clearRect(0, 0, 8, 8);
    ctx.drawImage(bmp, sx, sy, 8, 8, 0, 0, 8, 8);
    if (ctx.getImageData(0, 0, 8, 8).data[3] !== 0) return false;
  }
  return true;
}

/** 实时取景：把盘子对进圆环，拍下即框准（需要 https 或 localhost；不支持时自动回退系统相机） */
function CameraView({ onCapture, onCancel }: { onCapture: (f: File, c: Circle) => void; onCancel: (reason?: string) => void }) {
  const vidRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    if (!navigator.mediaDevices?.getUserMedia) { onCancel("unavailable"); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } } })
      .then(s => { stream = s; if (vidRef.current) { vidRef.current.srcObject = s; vidRef.current.play(); } })
      .catch(() => onCancel("unavailable"));
    return () => stream?.getTracks().forEach(t => t.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function shoot() {
    const v = vidRef.current;
    if (!v || !v.videoWidth) return;
    const cv = document.createElement("canvas");
    cv.width = v.videoWidth;
    cv.height = v.videoHeight;
    cv.getContext("2d")!.drawImage(v, 0, 0);
    cv.toBlob(b => {
      if (!b) return;
      // 圆环在画面中的相对位置：横向居中、纵向 45%，半径约短边 40%（与 .ring 样式对应）
      onCapture(new File([b], "camera.jpg", { type: "image/jpeg" }), { cx: 0.5, cy: 0.45, r: 0.4 });
    }, "image/jpeg", 0.92);
  }

  return (
    <div className="cameraview">
      <video ref={vidRef} playsInline muted />
      <div className="ring" />
      <div className="camhint">把盘子放进圆环里 · 正上方俯拍</div>
      <div className="cambar">
        <button className="camcancel" onClick={() => onCancel()}>取消</button>
        <button className="shutter" onClick={shoot} aria-label="拍照" />
        <span style={{ width: 44 }} />
      </div>
    </div>
  );
}

/** 圆形参考框：把盘子框进圆里，拖动移动、滑杆缩放 */
function CircleCrop({ url, onDone, onCancel }: { url: string; onDone: (c: Circle) => void; onCancel: () => void }) {
  const [c, setC] = useState<Circle>({ cx: 0.5, cy: 0.5, r: 0.42 });
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  function down(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: c.cx, cy: c.cy };
  }
  function move(e: React.PointerEvent) {
    if (!drag.current || !boxRef.current) return;
    const b = boxRef.current.getBoundingClientRect();
    setC(v => ({ ...v,
      cx: Math.min(1, Math.max(0, drag.current!.cx + (e.clientX - drag.current!.x) / b.width)),
      cy: Math.min(1, Math.max(0, drag.current!.cy + (e.clientY - drag.current!.y) / b.height)) }));
  }

  return (
    <>
      <div ref={boxRef} className="cropbox" onPointerDown={down} onPointerMove={move}
        onPointerUp={() => (drag.current = null)}>
        <img src={url} alt="" draggable={false} />
        <svg className="cropmask" viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <mask id="hole">
              <rect width="100" height="100" fill="white" />
              <ellipse cx={c.cx * 100} cy={c.cy * 100} rx={c.r * 100} ry={c.r * 100} fill="black" />
            </mask>
          </defs>
          <rect width="100" height="100" fill="rgba(0,0,0,0.55)" mask="url(#hole)" />
        </svg>
        <div className="cropring" style={{
          left: `${c.cx * 100}%`, top: `${c.cy * 100}%`,
          width: `${c.r * 200}%`, aspectRatio: "1",
        }} />
      </div>
      <div className="hint">拖动圆框对准盘子，滑杆调大小——框准了抠图更稳</div>
      <input type="range" min={0.15} max={0.6} step={0.005} value={c.r}
        onChange={e => setC(v => ({ ...v, r: Number(e.target.value) }))} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn ghost" onClick={onCancel}>取消</button>
        <button className="btn" onClick={() => onDone(c)}>就这样，抠！</button>
      </div>
    </>
  );
}

export default function Record({ presetId }: { presetId?: string } = {}) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [recent, setRecent] = useState<{ id: string; name: string }[]>([]);
  const camRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<{ f: File; url: string } | null>(null);
  const [camera, setCamera] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [options, setOptions] = useState<CardResult[]>([]);
  const [picked, setPicked] = useState<CardResult | null>(null);
  const [polishing, setPolishing] = useState(false);
  const lastShot = useRef<{ f: File; circle: Circle | null } | null>(null);

  const [recipeId, setRecipeId] = useState(presetId ?? "");
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("");
  const [date, setDate] = useState(today());
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [backfill, setBackfill] = useState<{ recipe: Recipe; items: { i: number; name: string; amount: string; value: string }[]; askServings: boolean; servings: number | null } | null>(null);

  // 餐具：choice=auto 时按菜的品类自动匹配（汤面粥→深碗、甜点→浅盘、其余→平盘），也可手动指定
  const TW_MATCH: Record<string, string> = { 饭粥: "bowl", 面点: "bowl", 羹汤: "bowl", 甜点: "saucer" };
  const TW_LABEL: Record<string, string> = { plate: "平盘", bowl: "深碗", saucer: "浅盘" };
  const [tw, setTw] = useState<{ choice: string; current: string }>({ choice: "auto", current: "plate" });

  async function applyTw(target: string, choice: string) {
    if (!picked) return;
    if (target === tw.current) { setTw({ choice, current: target }); return; }
    try {
      const r = await api.replate(picked.photo_id, target);
      setPicked(p => p && { ...p, card: `${r.card}?t=${Date.now()}` });
      setTw({ choice, current: target });
    } catch { /* 换盘失败保持原样 */ }
  }

  useEffect(() => {
    if (!picked || picked.mode !== "plate" || tw.choice !== "auto") return;
    const cat = recipeId ? recipes.find(r => r.id === recipeId)?.category : newCat;
    const target = TW_MATCH[cat ?? ""] ?? "plate";
    if (target !== tw.current) applyTw(target, "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeId, newCat, picked?.photo_id, tw]);

  useEffect(() => {
    api.recipes().then(({ categories, recipes }) => {
      setRecipes(recipes);
      setCats(categories);
      setNewCat(categories[0] || "");
    });
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
    });
  }, []);

  async function pickFile(f: File) {
    setErr("");
    setOptions([]);
    setPicked(null);
    if (await looksTransparent(f)) {
      setCutting(true);
      api.cutout(f, { alreadyCut: true })
        .then(r => setPicked(r.results[0]))
        .catch(() => setErr("这张透明图没处理成功，换一张试试"))
        .finally(() => setCutting(false));
    } else {
      setFile({ f, url: URL.createObjectURL(f) });
    }
  }

  async function runCutout(f: File, circle: Circle) {
    setCutting(true);
    setErr("");
    lastShot.current = { f, circle };
    try {
      const r = await api.cutout(f, { mode: "both", circle });
      setOptions(r.results);
      if (r.results.length === 1) setPicked(r.results[0]);
      setFile(null);
    } catch (e) {
      console.error(e);
      setErr("这张没抠好——可以换一张再试，或者不带图直接记录");
    } finally {
      setCutting(false);
    }
  }

  async function crop(circle: Circle) {
    if (!file) return;
    await runCutout(file.f, circle);
  }

  async function polish() {
    if (!lastShot.current) return;
    setPolishing(true);
    setErr("");
    try {
      const r = await api.cutout(lastShot.current.f, { mode: "polish", circle: lastShot.current.circle ?? undefined });
      setOptions(o => [...o, ...r.results]);
    } catch (e) {
      setErr(`AI 精修失败：${(e as Error).message}`);
    } finally {
      setPolishing(false);
    }
  }

  async function save() {
    setErr("");
    if (!recipeId && !newName.trim()) return setErr("选一道菜，或者给新菜起个名字");
    setSaving(true);
    try {
      const meal = await api.addMeal({
        recipe_id: recipeId || undefined,
        new_recipe: recipeId ? undefined : { name: newName.trim(), category: newCat },
        photo_id: picked?.photo_id,
        date, rating, note,
      });
      // 实测量回填：这道菜若有"适量"类模糊量，轻提示补一笔（可一键跳过），菜谱越做越精确
      try {
        const rec = await api.recipe(meal.recipe_id);
        const fuzzy = rec.ingredients
          .map((ing, i) => ({ i, ...ing, value: "" }))
          .filter(x => !x.amount || /适量|少许|随意|若干|一点/.test(x.amount));
        const askServings = (rec.servings ?? 1) === 1 && (rec.kcal_whole ?? 0) > 1200;
        if (fuzzy.length > 0 || askServings) {
          setBackfill({ recipe: rec, items: fuzzy, askServings, servings: null });
          return;
        }
      } catch { /* 回填是锦上添花，失败不挡路 */ }
      location.hash = "#/timeline";
    } catch (e) {
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
    if (dirty) await api.saveRecipe(patch);
    location.hash = "#/timeline";
  }

  if (backfill) {
    return (
      <>
        <span className="seal">记</span>
        <h1>记好了！顺手补一笔？</h1>
        {backfill.items.length > 0 && (
          <div className="hint" style={{ marginTop: 0 }}>
            「{backfill.recipe.name}」有 {backfill.items.length} 个用量还是"大概"——这次实际放了多少？填了下次就能照做（不填也没关系）。
          </div>
        )}
        {backfill.askServings && (
          <>
            <label className="f">这一锅够吃几餐？（整锅 ≈{backfill.recipe.kcal_whole} kcal，分几餐记账更准）</label>
            <div className="chips">
              {[1, 2, 3, 4].map(n => (
                <button key={n} className={`chip pick ${backfill.servings === n ? "on" : ""}`}
                  onClick={() => setBackfill(b => b && ({ ...b, servings: n }))}>{n} 餐</button>
              ))}
            </div>
          </>
        )}
        {backfill.items.map((it, k) => (
          <div key={it.i}>
            <label className="f">{it.name}（现在是：{it.amount || "没写"}）</label>
            <input placeholder="如：1勺半 / 10毫升 / 两瓣" value={it.value}
              onChange={e => setBackfill(b => b && ({ ...b, items: b.items.map((x, j) => j === k ? { ...x, value: e.target.value } : x) }))} />
          </div>
        ))}
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn ghost" onClick={() => (location.hash = "#/timeline")}>下次再说</button>
          <button className="btn" onClick={saveBackfill}>回填保存</button>
        </div>
      </>
    );
  }

  const labels: Record<string, string> = { plate: "摆盘", auto: "AI 抠图", circle: "圆框直裁", polish: "AI 精修" };

  return (
    <>
      <span className="seal">记</span>
      <h1>记一餐</h1>

      <label className="f">今天做的饭</label>
      {picked ? (
        <>
          <div className="preview"><img src={picked.card} alt="菜卡" /></div>
          {picked.mode === "plate" && (
            <div className="chips" style={{ marginTop: 10 }}>
              <button className={`chip pick ${tw.choice === "auto" ? "on" : ""}`}
                onClick={() => setTw(t => ({ ...t, choice: "auto" }))}>自动配盘</button>
              {Object.entries(TW_LABEL).map(([k, label]) => (
                <button key={k} className={`chip pick ${tw.choice === k ? "on" : ""}`}
                  onClick={() => applyTw(k, k)}>{label}</button>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            {options.length > 1 && (
              <button className="btn ghost" onClick={() => setPicked(null)}>看另一种效果</button>
            )}
            <button className="btn ghost" onClick={() => { setPicked(null); setOptions([]); albumRef.current?.click(); }}>换一张</button>
          </div>
        </>
      ) : options.length > 0 ? (
        <>
          <div className="hint" style={{ marginTop: 0 }}>选一张效果好的：</div>
          <div className="row" style={{ marginTop: 8 }}>
            {options.map(o => (
              <button key={o.mode} className="pickcard" onClick={() => setPicked(o)}>
                <img src={o.card} alt={o.mode} />
                <span>{labels[o.mode] ?? o.mode}</span>
              </button>
            ))}
          </div>
          {!options.some(o => o.mode === "polish") && (
            <div style={{ marginTop: 10 }}>
              <button className="btn ghost" disabled={polishing} onClick={polish}>
                {polishing ? "AI 精修中，约一分钟…" : "✨ 都不满意？AI 精修一版（约 0.3 元）"}
              </button>
            </div>
          )}
        </>
      ) : file ? (
        <CircleCrop url={file.url} onDone={crop} onCancel={() => setFile(null)} />
      ) : cutting ? (
        <div className="loading">抠图中，两种效果都给你出一份</div>
      ) : (
        <>
          <div className="row">
            <button className="btn ghost" onClick={() => setCamera(true)}>📷 现场拍</button>
            <button className="btn ghost" onClick={() => albumRef.current?.click()}>🖼 从相册选</button>
          </div>
          <div className="hint">俯拍 · 盘子拍全 · 背景越素抠得越准；iPhone 长按抠好的透明图直接传也行。不拍照也可以往下记。</div>
        </>
      )}
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden
        onChange={e => { if (e.target.files?.[0]) pickFile(e.target.files[0]); e.target.value = ""; }} />
      <input ref={albumRef} type="file" accept="image/*" hidden
        onChange={e => { if (e.target.files?.[0]) pickFile(e.target.files[0]); e.target.value = ""; }} />
      {camera && (
        <CameraView
          onCapture={(f, c) => { setCamera(false); runCutout(f, c); }}
          onCancel={reason => { setCamera(false); if (reason === "unavailable") camRef.current?.click(); }} />
      )}

      <label className="f">这是哪道菜</label>
      {recent.length > 0 && (
        <div className="chips" style={{ marginBottom: 8 }}>
          {recent.map(r => (
            <button key={r.id} className={`chip pick ${recipeId === r.id ? "on" : ""}`}
              onClick={() => setRecipeId(id => (id === r.id ? "" : r.id))}>{r.name}</button>
          ))}
        </div>
      )}
      <select value={recipeId} onChange={e => setRecipeId(e.target.value)}>
        <option value="">＋ 新菜（在下面起名）</option>
        {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      {!recipeId && (
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="新菜名，如：云吞面" value={newName} onChange={e => setNewName(e.target.value)} />
          <select value={newCat} onChange={e => setNewCat(e.target.value)} style={{ maxWidth: 130 }}>
            {cats.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
      )}

      <label className="f">日期</label>
      <div className="chips" style={{ marginBottom: 8 }}>
        <button className={`chip pick ${date === today() ? "on" : ""}`} onClick={() => setDate(today())}>今天</button>
        <button className={`chip pick ${date === yesterday() ? "on" : ""}`} onClick={() => setDate(yesterday())}>昨天（补记）</button>
      </div>
      <input type="date" value={date} onChange={e => setDate(e.target.value)} />

      <label className="f">品味（这顿做得怎么样，不评也行）</label>
      <div className="stars">
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} className={rating !== null && n <= rating ? "on" : ""}
            onClick={() => setRating(v => (v === n ? null : n))}>{n <= (rating ?? 0) ? "★" : "☆"}</button>
        ))}
      </div>

      <label className="f">备注（口味调整、下次注意…）</label>
      <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="例：牛排腌 10 分钟刚好，芦笋焯水别超过 40 秒" />

      {err && <div className="err">{err}</div>}
      <div style={{ marginTop: 18 }}>
        <button className="btn" disabled={saving || cutting} onClick={save}>{saving ? "保存中…" : "记下这一餐"}</button>
      </div>
    </>
  );
}
