export interface Ingredient { name: string; amount: string }
export interface Recipe {
  id: string; name: string; category: string; cover: string; source: string; created: string;
  ingredients: Ingredient[]; steps: string[]; tips: string[];
  times: number; rating: number | null;
  illust?: { ingredients: string[]; steps: string[] };
}
export interface Meal {
  id: string; recipe_id: string; recipe_name: string; date: string;
  rating: number | null; note: string; photo_card: string;
}

async function j<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

export const api = {
  recipes: () => j<{ categories: string[]; recipes: Recipe[] }>(fetch("/api/recipes")),
  recipe: (id: string) => j<Recipe>(fetch(`/api/recipes/${id}`)),
  saveRecipe: (r: Partial<Recipe>) =>
    j<Recipe>(fetch(r.id ? `/api/recipes/${r.id}` : "/api/recipes", {
      method: r.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    })),
  random: (category?: string) =>
    j<Recipe>(fetch(`/api/random${category ? `?category=${encodeURIComponent(category)}` : ""}`)),
  meals: () => j<Meal[]>(fetch("/api/meals")),
  addMeal: (m: object) => j<Meal>(fetch("/api/meals", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m),
  })),
  updateMeal: (id: string, patch: object) => j<Meal>(fetch(`/api/meals/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  })),
  deleteMeal: (id: string) => j<{ ok: boolean }>(fetch(`/api/meals/${id}`, { method: "DELETE" })),
  seedExamples: () => j<{ added: number }>(fetch("/api/seed-examples", { method: "POST" })),
  cutout: (file: File, opts: { alreadyCut?: boolean; mode?: string; circle?: { cx: number; cy: number; r: number } }) => {
    const fd = new FormData();
    fd.append("photo", file);
    fd.append("already_cut", String(!!opts.alreadyCut));
    fd.append("mode", opts.mode ?? "auto");
    if (opts.circle) {
      fd.append("cx", String(opts.circle.cx));
      fd.append("cy", String(opts.circle.cy));
      fd.append("r", String(opts.circle.r));
    }
    return j<{ results: { mode: string; photo_id: string; card: string }[] }>(
      fetch("/api/cutout", { method: "POST", body: fd }));
  },
  aiStatus: () => j<{
    backend: string; model: string; available: boolean;
    imagegen?: { backend: string; model: string; available: boolean };
  }>(fetch("/api/ai/status")),
  aiIllustrate: (recipe_id: string, kind: "ing" | "step", index: number) =>
    j<{ url: string }>(fetch("/api/ai/illustrate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipe_id, kind, index }),
    })),
  aiExtract: (text: string, source: string) =>
    j<{ name: string; category: string; ingredients: Ingredient[]; steps: string[]; tips: string[]; source: string }>(
      fetch("/api/ai/extract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source }),
      })),
};
