// 统一请求层（移植自 web/src/api.ts）：
//  - weapp：Taro.cloud.callContainer 打到微信云托管（免域名配置）
//  - 其他环境（h5 本地联调）：fetch http://127.0.0.1:18100
import Taro from "@tarojs/taro";
import { CLOUD_ENV, CLOUDRUN_HTTP_BASE, LOCAL_BASE, SERVICE } from "./config";

// ---------- 类型（与 web 端一致） ----------
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
export interface Order {
  id: string; from: string; note: string; date: string; done: boolean;
  items: { recipe_id: string; name: string }[];
}
export interface ShopItem { name: string; amounts: string; recipes: string; checked: boolean; seasoning: boolean }
export interface Meal {
  id: string; recipe_id: string; recipe_name: string; date: string;
  rating: number | null; note: string; photo_card: string; kcal?: number | null;
}
export interface IngInfo {
  name: string; kcal_per_100g: number | null; protein_g: number | null;
  fat_g: number | null; carb_g: number | null; benefits: string[]; tips: string[]; source?: string;
  matched?: string; text_source?: string;
}
export interface CutoutResult { mode: string; photo_id: string; card: string }
export interface AiStatus {
  backend: string; model: string; available: boolean;
  imagegen?: { backend: string; model: string; available: boolean };
}
export interface ConfigPayload {
  llm: Record<string, unknown>; imagegen: Record<string, unknown>; goal: { kcal?: number | string };
  status?: AiStatus; secrets?: Record<string, boolean>; owner_token?: boolean;
}

const isWeapp = process.env.TARO_ENV === "weapp";

let cloudReady = false;
function ensureCloud() {
  if (!cloudReady) {
    Taro.cloud.init();
    cloudReady = true;
  }
}

/** FastAPI 的错误 detail：字符串直接用；422 是数组，拼 msg（照抄 web 端处理） */
function detailMsg(body: unknown): string {
  const d = (body as { detail?: unknown } | null | undefined)?.detail;
  if (Array.isArray(d)) {
    return d.map(x => (x as { msg?: string } | null)?.msg).filter(Boolean).join("；");
  }
  return typeof d === "string" ? d : "";
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface ContainerResp { statusCode: number; data: unknown; header?: Record<string, string> }

export async function request<T>(path: string, method: Method = "GET", data?: object): Promise<T> {
  if (isWeapp) {
    ensureCloud();
    // callContainer 的 TS 定义在部分版本缺 config/path 字段，这里收窄成本地接口
    const call = (Taro.cloud as unknown as {
      callContainer: (opt: object) => Promise<ContainerResp>;
    }).callContainer;
    let res: ContainerResp;
    try {
      res = await call({
        config: { env: CLOUD_ENV },
        path,
        method,
        data,
        header: { "X-WX-SERVICE": SERVICE, "content-type": "application/json" },
      });
    } catch (e) {
      throw new Error((e as { errMsg?: string })?.errMsg || "网络请求失败");
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(detailMsg(res.data) || `请求失败（${res.statusCode}）`);
    }
    return res.data as T;
  }
  // h5 本地联调
  const res = await fetch(LOCAL_BASE + path, {
    method,
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(detailMsg(body) || res.statusText || `请求失败（${res.status}）`);
  }
  return res.json() as Promise<T>;
}

/** 相对路径照片（/photos/…）补成完整地址；完整 URL（COS）原样返回 */
export function absUrl(p?: string | null): string {
  if (!p) return "";
  if (/^https?:\/\//.test(p)) return p;
  if (isWeapp) return CLOUDRUN_HTTP_BASE ? CLOUDRUN_HTTP_BASE + p : p;
  return LOCAL_BASE + p;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

// ---------- 照片上传（multipart） ----------

/** 手工 UTF-8 编码：小程序环境不保证有 TextEncoder */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.codePointAt(i)!;
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function parseUploadBody(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

async function uploadViaUploadFile(url: string, filePath: string, formData: Record<string, string>) {
  const res = await Taro.uploadFile({ url, filePath, name: "photo", formData });
  const body = parseUploadBody(res.data);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(detailMsg(body) || `上传失败（${res.statusCode}）`);
  }
  return body as { results: CutoutResult[] };
}

/** 免域名配置的兜底：读文件字节，手工拼 multipart，走 callContainer */
async function uploadViaCallContainer(path: string, filePath: string, formData: Record<string, string>) {
  ensureCloud();
  const fileBuf = Taro.getFileSystemManager().readFileSync(filePath) as ArrayBuffer;
  const boundary = `----yidanshi${Date.now().toString(16)}`;
  let head = "";
  for (const [k, v] of Object.entries(formData)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const hb = utf8Bytes(head);
  const tb = utf8Bytes(tail);
  const file = new Uint8Array(fileBuf);
  const body = new Uint8Array(hb.length + file.length + tb.length);
  body.set(hb, 0);
  body.set(file, hb.length);
  body.set(tb, hb.length + file.length);

  const call = (Taro.cloud as unknown as {
    callContainer: (opt: object) => Promise<ContainerResp>;
  }).callContainer;
  const res = await call({
    config: { env: CLOUD_ENV },
    path,
    method: "POST",
    data: body.buffer,
    header: { "X-WX-SERVICE": SERVICE, "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  const parsed = parseUploadBody(res.data);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(detailMsg(parsed) || `上传失败（${res.statusCode}）`);
  }
  return parsed as { results: CutoutResult[] };
}

/**
 * 拍照/选图后上传 /api/cutout。云端没有 rembg，返回圆框直裁或 SegmentFood
 * 抠图结果（单结果，无需双选）。
 */
export function uploadCutout(filePath: string, opts: { alreadyCut?: boolean; mode?: string } = {}) {
  const formData: Record<string, string> = {
    already_cut: String(!!opts.alreadyCut),
    mode: opts.mode ?? "auto",
  };
  if (!isWeapp) return uploadViaUploadFile(`${LOCAL_BASE}/api/cutout`, filePath, formData);
  if (CLOUDRUN_HTTP_BASE) return uploadViaUploadFile(`${CLOUDRUN_HTTP_BASE}/api/cutout`, filePath, formData);
  return uploadViaCallContainer("/api/cutout", filePath, formData);
}

// ---------- 接口（与 web/src/api.ts 对应） ----------
export const api = {
  recipes: () => request<{ categories: string[]; recipes: Recipe[] }>("/api/recipes"),
  recipe: (id: string) => request<Recipe>(`/api/recipes/${id}`),
  saveRecipe: (r: Partial<Recipe>) =>
    request<Recipe>(r.id ? `/api/recipes/${r.id}` : "/api/recipes", r.id ? "PUT" : "POST", r),
  random: (category?: string, opts?: { avoidDays?: number; maxMinutes?: number; difficulty?: string; usePantry?: boolean }) =>
    request<Recipe>(`/api/random${qs({
      category,
      avoid_days: opts?.avoidDays || undefined,
      max_minutes: opts?.maxMinutes || undefined,
      difficulty: opts?.difficulty || undefined,
      use_pantry: opts?.usePantry ? 1 : undefined,
    })}`),
  ingredient: (name: string) => request<IngInfo>(`/api/ingredient/${encodeURIComponent(name)}`),
  ingredientNames: () => request<{ names: string[]; defaults: Record<string, number> }>("/api/ingredient-names"),
  pantry: () => request<{ items: string[] }>("/api/pantry"),
  savePantry: (items: string[]) => request<{ items: string[] }>("/api/pantry", "PUT", { items }),
  weekreport: () => request<{
    meals: number; kcal: number; uncounted?: number; kcal_avg: number | null; protein_meals: number;
    veg_kinds: string[]; categories: Record<string, number>; tip: string;
  }>("/api/weekreport"),
  meals: () => request<Meal[]>("/api/meals"),
  addMeal: (m: object) => request<Meal>("/api/meals", "POST", m),
  updateMeal: (id: string, patch: object) => request<Meal>(`/api/meals/${id}`, "PUT", patch),
  deleteMeal: (id: string) => request<{ ok: boolean }>(`/api/meals/${id}`, "DELETE"),
  seedExamples: () => request<{ added: number }>("/api/seed-examples", "POST"),
  guestLink: (reset = false) => request<{ token: string }>(`/api/guest-link${reset ? "?reset=true" : ""}`, "POST"),
  orders: () => request<Order[]>("/api/orders"),
  orderDone: (id: string, done = true) => request<Order>(`/api/orders/${id}`, "PUT", { done }),
  shopping: () => request<{ items: ShopItem[] }>("/api/shopping"),
  saveShopping: (items: ShopItem[]) => request<{ items: ShopItem[] }>("/api/shopping", "PUT", { items }),
  aiStatus: () => request<AiStatus>("/api/ai/status"),
  config: () => request<ConfigPayload>("/api/config"),
  saveConfig: (c: object) => request<ConfigPayload>("/api/config", "PUT", c),
};

/** 所有请求失败统一 toast（页面里 catch 后调用） */
export function toastErr(e: unknown, fallback = "出错了") {
  const msg = (e as Error)?.message || fallback;
  Taro.showToast({ title: msg, icon: "none" });
}
