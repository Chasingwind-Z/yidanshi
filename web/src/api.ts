export interface Ingredient { name: string; amount: string; grams?: number | null }
export interface Recipe {
  id: string; name: string; category: string; cover: string; source: string; created: string;
  kcal?: number | null; minutes?: number | null; difficulty?: string | null; relaxed?: boolean;
  nutrition?: { kcal: number; protein_g: number; fat_g: number; carb_g: number; covered: number; total: number } | null;
  ingredients: Ingredient[]; steps: string[]; tips: string[];
  times: number; rating: number | null;
  illust?: { ingredients: string[]; steps: string[] };
  annotations?: { date: string; note: string }[];
}
export interface Order {
  id: string; from: string; note: string; date: string; done: boolean;
  items: { recipe_id: string; name: string }[];
}
export interface ShopItem { name: string; amounts: string; recipes: string; checked: boolean; seasoning: boolean }
export interface Meal {
  id: string; recipe_id: string; recipe_name: string; date: string;
  rating: number | null; note: string; photo_card: string; kcal?: number | null;
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
  random: (category?: string, opts?: { avoidDays?: number; maxMinutes?: number; difficulty?: string; usePantry?: boolean }) => {
    const q = new URLSearchParams();
    if (category) q.set("category", category);
    if (opts?.avoidDays) q.set("avoid_days", String(opts.avoidDays));
    if (opts?.maxMinutes) q.set("max_minutes", String(opts.maxMinutes));
    if (opts?.difficulty) q.set("difficulty", opts.difficulty);
    if (opts?.usePantry) q.set("use_pantry", "1");
    return j<Recipe>(fetch(`/api/random?${q}`));
  },
  ingredientNames: () => j<{ names: string[]; defaults: Record<string, number> }>(fetch("/api/ingredient-names")),
  pantry: () => j<{ items: string[] }>(fetch("/api/pantry")),
  savePantry: (items: string[]) => j<{ items: string[] }>(fetch("/api/pantry", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
  })),
  weekreport: () => j<{ meals: number; kcal: number; protein_meals: number; veg_kinds: string[];
    categories: Record<string, number>; tip: string }>(fetch("/api/weekreport")),
  meals: () => j<Meal[]>(fetch("/api/meals")),
  addMeal: (m: object) => j<Meal>(fetch("/api/meals", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m),
  })),
  updateMeal: (id: string, patch: object) => j<Meal>(fetch(`/api/meals/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  })),
  deleteMeal: (id: string) => j<{ ok: boolean }>(fetch(`/api/meals/${id}`, { method: "DELETE" })),
  seedExamples: () => j<{ added: number }>(fetch("/api/seed-examples", { method: "POST" })),
  guestLink: (reset = false) =>
    j<{ token: string }>(fetch(`/api/guest-link${reset ? "?reset=true" : ""}`, { method: "POST" })),
  orders: () => j<Order[]>(fetch("/api/orders")),
  orderDone: (id: string, done = true) => j<Order>(fetch(`/api/orders/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done }),
  })),
  shopping: () => j<{ items: ShopItem[] }>(fetch("/api/shopping")),
  saveShopping: (items: ShopItem[]) => j<{ items: ShopItem[] }>(fetch("/api/shopping", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
  })),
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
  replate: (photo_id: string, tableware: string) =>
    j<{ card: string; tableware: string }>(fetch("/api/replate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_id, tableware }),
    })),
  aiStatus: () => j<{
    backend: string; model: string; available: boolean;
    imagegen?: { backend: string; model: string; available: boolean };
  }>(fetch("/api/ai/status")),
  aiIllustrate: (recipe_id: string, kind: "ing" | "step", index: number) =>
    j<{ url: string }>(fetch("/api/ai/illustrate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipe_id, kind, index }),
    })),
  aiExtract: (text: string, source: string, url?: string) =>
    j<{ name: string; category: string; ingredients: Ingredient[]; steps: string[]; tips: string[]; kcal: number | null; minutes: number | null; source: string }>(
      fetch("/api/ai/extract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source, url }),
      })),
};
