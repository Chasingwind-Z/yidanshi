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
  random: () => j<Recipe>(fetch("/api/random")),
  meals: () => j<Meal[]>(fetch("/api/meals")),
  addMeal: (m: object) => j<Meal>(fetch("/api/meals", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m),
  })),
  cutout: (file: File, alreadyCut: boolean) => {
    const fd = new FormData();
    fd.append("photo", file);
    fd.append("already_cut", String(alreadyCut));
    return j<{ photo_id: string; raw: string; cut: string; card: string }>(
      fetch("/api/cutout", { method: "POST", body: fd }));
  },
};
