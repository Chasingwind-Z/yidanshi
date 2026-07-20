// 与 web/src/api.ts 同源的类型与接口层。
// 开发期直连本机 FastAPI（开发者工具勾/已配「不校验合法域名」）；
// 上云后把 request() 换成 wx.cloud.callContainer 即可，页面代码零改动。
import Taro from "@tarojs/taro";

export interface Ingredient { name: string; amount: string; grams?: number | null }
export interface Recipe {
  id: string; name: string; category: string; cover: string; source: string; created: string;
  kcal?: number | null; minutes?: number | null; difficulty?: string | null; relaxed?: boolean;
  nutrition?: { kcal: number; protein_g: number; fat_g: number; carb_g: number; covered: number; total: number; per_item?: (number | null)[]; missing?: string[] } | null;
  kcal_effective?: number | null; kcal_whole?: number | null; kcal_source?: string; servings?: number;
  ingredients: Ingredient[]; steps: string[]; tips: string[];
  times: number; rating: number | null;
  illust?: { ingredients: string[]; steps: string[] };
  annotations?: { date: string; note: string }[];
}
export interface Meal {
  id: string; recipe_id: string; recipe_name: string; date: string;
  rating: number | null; note: string; photo_card: string; kcal?: number | null;
}
export interface IngInfo {
  name: string; kcal_per_100g: number | null; protein_g: number | null;
  fat_g: number | null; carb_g: number | null; benefits: string[]; tips: string[];
  source?: string; matched?: string; text_source?: string;
}

// 开发期后端地址：真机预览时换成电脑的局域网 IP
export const BASE = "http://127.0.0.1:18100";

/** 把相对图片路径（/photos/...）补全成可加载的 URL */
export const imgUrl = (p?: string) => (p ? (p.startsWith("http") ? p : BASE + p) : "");

async function request<T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", data?: object): Promise<T> {
  const res = await Taro.request({
    url: BASE + path, method, data,
    header: { "Content-Type": "application/json" },
  });
  if (res.statusCode >= 400) {
    const d = (res.data as { detail?: unknown })?.detail;
    throw new Error(typeof d === "string" ? d : `请求失败 (${res.statusCode})`);
  }
  return res.data as T;
}

export const api = {
  recipes: () => request<{ categories: string[]; recipes: Recipe[] }>("/api/recipes"),
  recipe: (id: string) => request<Recipe>(`/api/recipes/${id}`),
  meals: () => request<Meal[]>("/api/meals"),
  addMeal: (m: object) => request<Meal>("/api/meals", "POST", m),
  ingredient: (name: string) => request<IngInfo>(`/api/ingredient/${encodeURIComponent(name)}`),
  random: (category?: string, opts?: { avoidDays?: number; maxMinutes?: number; difficulty?: string }) => {
    const q: string[] = [];
    if (category) q.push(`category=${encodeURIComponent(category)}`);
    if (opts?.avoidDays) q.push(`avoid_days=${opts.avoidDays}`);
    if (opts?.maxMinutes) q.push(`max_minutes=${opts.maxMinutes}`);
    if (opts?.difficulty) q.push(`difficulty=${encodeURIComponent(opts.difficulty)}`);
    return request<Recipe>(`/api/random${q.length ? "?" + q.join("&") : ""}`);
  },
};
