import { useEffect, useRef, useState } from "react";
import { api, type Recipe } from "../api";

const today = () => new Date().toLocaleDateString("sv");  // YYYY-MM-DD

export default function Record() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const [alreadyCut, setAlreadyCut] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [photo, setPhoto] = useState<{ photo_id: string; card: string } | null>(null);

  const [recipeId, setRecipeId] = useState("");
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("");
  const [date, setDate] = useState(today());
  const [rating, setRating] = useState<number | null>(5);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.recipes().then(({ categories, recipes }) => {
      setRecipes(recipes);
      setCats(categories);
      setNewCat(categories[0] || "");
    });
  }, []);

  async function pick(file: File) {
    setErr("");
    setCutting(true);
    try {
      const r = await api.cutout(file, alreadyCut);
      setPhoto(r);
    } catch (e) {
      setErr(`抠图失败：${(e as Error).message}`);
    } finally {
      setCutting(false);
    }
  }

  async function save() {
    setErr("");
    if (!recipeId && !newName.trim()) return setErr("选一道菜，或者给新菜起个名字");
    setSaving(true);
    try {
      await api.addMeal({
        recipe_id: recipeId || undefined,
        new_recipe: recipeId ? undefined : { name: newName.trim(), category: newCat },
        photo_id: photo?.photo_id,
        date, rating, note,
      });
      location.hash = "#/timeline";
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="brand">RECORD</div>
      <h1>记一餐</h1>

      <label className="f">今天做的饭</label>
      {photo ? (
        <>
          <div className="preview"><img src={photo.card} alt="菜卡" /></div>
          <div style={{ marginTop: 10 }}>
            <button className="btn ghost" onClick={() => { setPhoto(null); fileRef.current?.click(); }}>换一张</button>
          </div>
        </>
      ) : (
        <>
          <button className="btn ghost" disabled={cutting} onClick={() => fileRef.current?.click()}>
            {cutting ? "抠图中，稍等几秒…" : "拍照 / 选择照片"}
          </button>
          <label className="toggle">
            <input type="checkbox" checked={alreadyCut} onChange={e => setAlreadyCut(e.target.checked)} />
            这是已抠好的透明图（iPhone 相册长按抠图导出）
          </label>
          <div className="hint">不拍照也可以直接往下记。</div>
        </>
      )}
      <input ref={fileRef} type="file" accept="image/*" hidden
        onChange={e => e.target.files?.[0] && pick(e.target.files[0])} />

      <label className="f">这是哪道菜</label>
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
      <input type="date" value={date} onChange={e => setDate(e.target.value)} />

      <label className="f">品味（这顿做得怎么样）</label>
      <div className="stars">
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} className={rating !== null && n <= rating ? "on" : ""}
            onClick={() => setRating(n)}>{n <= (rating ?? 0) ? "★" : "☆"}</button>
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
