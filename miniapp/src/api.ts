// 统一请求层（移植自 web/src/api.ts）：
//  - weapp：Taro.cloud.callContainer 打到微信云托管（免域名配置）
//  - 其他环境（h5 本地联调）：fetch http://127.0.0.1:18100
import Taro from "@tarojs/taro";
import { CLOUD_ENV, CLOUDRUN_HTTP_BASE, LOCAL_BASE, SERVICE } from "./config";

// ---------- 类型（与 web 端一致） ----------
export interface Ingredient { name: string; amount: string; grams?: number | null }
export interface Recipe {
  id: string; name: string; category: string; cover: string; source: string; created: string;
  demo?: boolean;  // 示例菜（seed-examples 摆进来的），空盘占位要如实标「示例菜」
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
  done_date?: string;  // 做好打勾那天（P0-2 起服务端写入；旧单没有 → 不显示）
  items: { recipe_id: string; name: string; note?: string }[];
}
/** 周报（行为化契约，与 web 一致）：empty:true 时只渲染 line 一句；可选行有则显示、无则整行不出 */
export interface WeekReport {
  empty: boolean; line: string; meals: number; days: number; delta_meals: number | null;
  new_dishes: string[]; repeat_top: { name: string; times: number } | null; streak_weeks: number;
  orders_done: { count: number; froms: string[] } | null; five_star: string[]; photos: number;
  nutri_note: string | null; tip: string;
}
/** 每日荐（规则版，主人接口）：0-2 条；客人 401 → 页面整体不渲染 */
export interface Suggestion { recipe_id: string; name: string; reason: string }
/** 客人视角的菜（/api/guest/menu 的裁剪字段；kcal 已是每餐口径） */
export interface GuestDish {
  id: string; name: string; category: string; cover: string;
  minutes?: number | null; servings?: number; times: number; rating: number | null; kcal?: number | null;
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
  video?: { backend: string; model: string; available: boolean };
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

// callContainer 默认等待时间不够长——生图/AI 整理/看视频这类调用常要几十秒到一两分钟，
// 默认超时会在服务端真正算完之前就先放弃（真机反馈"没画成：cloud.callContainer:fail"，
// 单张、不并发也一样失败，查下来是这个）。慢接口在各自 api 调用点传更长的 timeoutMs。
const DEFAULT_TIMEOUT_MS = 30000;

export async function request<T>(path: string, method: Method = "GET", data?: object, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  if (isWeapp) {
    ensureCloud();
    // callContainer 的 TS 定义在部分版本缺 config/path/timeout 字段，这里收窄成本地接口
    const call = (Taro.cloud as unknown as {
      callContainer: (opt: object) => Promise<ContainerResp>;
    }).callContainer;
    // 云托管缩零冷启动：容器"生火"要十几秒，首次请求常撞 102002 超时。
    // 只对 GET 自动重试（幂等）；POST/PUT/DELETE 不重试——传旨/记餐重发会重复提交。
    const attempts = method === "GET" ? 3 : 1;
    let res: ContainerResp | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        res = await call({
          config: { env: CLOUD_ENV },
          path,
          method,
          data,
          timeout: timeoutMs,
          header: { "X-WX-SERVICE": SERVICE, "content-type": "application/json" },
        });
        break;
      } catch (e) {
        const msg = (e as { errMsg?: string })?.errMsg || "";
        if (i < attempts - 1 && /102002|超时|timeout/i.test(msg)) {
          if (i === 0) Taro.showToast({ title: "厨房生火中，稍等…", icon: "none", duration: 3500 });
          await new Promise(r => setTimeout(r, 3500));
          continue;
        }
        throw new Error(msg || "网络请求失败");
      }
    }
    if (!res) throw new Error("网络请求失败");
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

/**
 * 拍照/选图后上传 /api/cutout。云端没有 rembg，返回圆框直裁或 SegmentFood
 * 抠图结果（单结果，无需双选）。
 *
 * 鉴权/大文件传输的坑，踩了三轮才找对方向，记录清楚别再回头踩：
 * ① wx.uploadFile 直连 CLOUDRUN_HTTP_BASE 域名——裸 HTTP 请求，微信不会往里注入
 *    X-WX-OPENID（那个头只有走 callContainer 桥接才会自动加），配了
 *    YIDANSHI_OWNER_OPENID 后被 owner_gate 当陌生人拦下，报「需要主人令牌」。
 * ② 换成 callContainer 手工拼 multipart——身份是有了，但官方文档写明 callContainer
 *    「文本请求限 100KiB」；真机实测哪怕把照片压到几十 KB 依然报 -606001，说明卡住的
 *    根本不是体积，是这条通道官方就不建议用来传文件（"callContainer 有请求大小
 *    限制，不建议用于文件上传"）。
 * ③ 现在的做法：大文件传输还是交给 ① 里证明过完全没问题的 wx.uploadFile，鉴权问题
 *    单独解决——先走一次 callContainer（小请求，身份正常验）换一个几分钟内有效的
 *    签名令牌，再拿这个令牌走 wx.uploadFile 直传（?upload_token=…，server 端
 *    owner_gate 认这个令牌）。两条路各自做自己擅长的事，不互相将就。
 */
export async function uploadCutout(
  filePath: string,
  opts: { alreadyCut?: boolean; mode?: string; circle?: { cx: number; cy: number; r: number } } = {},
) {
  const formData: Record<string, string> = {
    already_cut: String(!!opts.alreadyCut),
    mode: opts.mode ?? "auto",
  };
  // 取景圆相对坐标（对准盘子的构图引导；实测不提升抠图精度，作用是让合成的俯拍盘子贴得稳）
  if (opts.circle) {
    formData.cx = String(opts.circle.cx);
    formData.cy = String(opts.circle.cy);
    formData.r = String(opts.circle.r);
  }
  if (!isWeapp) return uploadViaUploadFile(`${LOCAL_BASE}/api/cutout`, filePath, formData);
  const { token } = await request<{ token: string }>("/api/cutout-token", "POST");
  const url = `${CLOUDRUN_HTTP_BASE}/api/cutout?upload_token=${encodeURIComponent(token)}`;
  // 云端容器配置很小（0.25 vCPU/512MB），手机原图不压缩直传对它是负担——这跟
  // callContainer 那个 -606001 是两码事（那是通道本身不认，这是资源友好），
  // 传输量本来就没必要那么大：cutout.py 最终卡片只有 1024px，收到 1800px 绰绰有余，
  // 单档压缩，不用像 callContainer 时代那样卡死一个精确字节数上限。
  let uploadPath = filePath;
  try {
    uploadPath = (await Taro.compressImage({ src: filePath, compressedWidth: 1800, quality: 85 })).tempFilePath;
  } catch { /* 压缩失败（罕见）就传原图，wx.uploadFile 本身能扛住大文件 */ }
  return uploadViaUploadFile(url, uploadPath, formData);
}

// 插画生成改"提交任务 + 轮询"：单个请求一路等到生图完成，撞的是微信平台自己的
// callContainer 调用超时（错误码 102002），真机实测过把 request() 的 timeout 参数拉到
// 90s 依然 102002——那是平台硬上限，不是本地能调大的数字。改成提交后立刻拿到 job_id，
// 每隔几秒问一次状态（单次查询请求本身很快，不会撞超时），总轮询窗口给够长。
// 从生产环境直接实测过两次真实生成耗时：77s、84s（图片尺寸大小对耗时几乎没影响，
// 模型本身就是这个量级）——轮询窗口至少要留够这个的 2 倍余量，不然网络稍微一抖就撞线。
async function pollIllustrateJob(jobId: string, intervalMs = 3000, maxAttempts = 60): Promise<{ url: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const job = await request<{ status: string; url: string | null; error: string | null }>(
      `/api/ai/illustrate-status?job_id=${encodeURIComponent(jobId)}`, "GET");
    if (job.status === "done" && job.url) return { url: job.url };
    if (job.status === "error") throw new Error(job.error || "生成失败");
  }
  throw new Error("画得有点久，还没出来——过一会再回来看看，后台可能还在继续画");
}

// ---------- 接口（与 web/src/api.ts 对应） ----------
export const api = {
  recipes: () => request<{ categories: string[]; recipes: Recipe[] }>("/api/recipes"),
  recipe: (id: string) => request<Recipe>(`/api/recipes/${id}`),
  saveRecipe: (r: Partial<Recipe>) =>
    request<Recipe>(r.id ? `/api/recipes/${r.id}` : "/api/recipes", r.id ? "PUT" : "POST", r),
  deleteRecipe: (id: string) => request<{ ok: boolean }>(`/api/recipes/${id}`, "DELETE"),
  random: (category?: string, opts?: { avoidDays?: number; maxMinutes?: number; difficulty?: string; usePantry?: boolean; exclude?: string[] }) =>
    request<Recipe>(`/api/random${qs({
      category,
      avoid_days: opts?.avoidDays || undefined,
      max_minutes: opts?.maxMinutes || undefined,
      difficulty: opts?.difficulty || undefined,
      use_pantry: opts?.usePantry ? 1 : undefined,
      exclude: opts?.exclude?.length ? opts.exclude.join(",") : undefined,
    })}`),
  // locked：菜 <3 道时后端不给荐（样本太少荐不准），带 need=还差几道，前端渲染进度钩子
  suggest: () => request<{ suggestions: Suggestion[]; date: string; locked?: { need: number } }>("/api/suggest"),
  ingredient: (name: string) => request<IngInfo>(`/api/ingredient/${encodeURIComponent(name)}`),
  ingredientNames: () => request<{ names: string[]; defaults: Record<string, number> }>("/api/ingredient-names"),
  pantry: () => request<{ items: string[] }>("/api/pantry"),
  savePantry: (items: string[]) => request<{ items: string[] }>("/api/pantry", "PUT", { items }),
  weekreport: () => request<WeekReport>("/api/weekreport"),
  meals: () => request<Meal[]>("/api/meals"),
  addMeal: (m: object) => request<Meal>("/api/meals", "POST", m),
  updateMeal: (id: string, patch: object) => request<Meal>(`/api/meals/${id}`, "PUT", patch),
  deleteMeal: (id: string) => request<{ ok: boolean }>(`/api/meals/${id}`, "DELETE"),
  // 换餐具：拿已存的抠图（cut/{photo_id}.png）重新摆盘，原地覆盖同名卡片 URL，
  // 前端不用改任何 photo_card/cover 字段，只需在渲染时加个 cache-bust 参数
  replate: (photo_id: string, tableware = "plate") =>
    request<{ card: string; tableware: string }>("/api/replate", "POST", { photo_id, tableware }),
  seedExamples: () => request<{ added: number }>("/api/seed-examples", "POST"),
  // 一键收走示例菜（主人）：只收还没记过餐的，记过餐的 kept 保留
  deleteSeedExamples: () => request<{ removed: number; kept: number }>("/api/seed-examples", "DELETE"),
  guestLink: (reset = false) => request<{ token: string }>(`/api/guest-link${reset ? "?reset=true" : ""}`, "POST"),
  guestMenu: (t: string) =>
    request<{ categories: string[]; recipes: GuestDish[] }>(`/api/guest/menu?t=${encodeURIComponent(t)}`),
  // items 带 name：菜若已被主人收回，服务端 dropped 里才能回显菜名而不是裸 id
  // client_id：点单幂等键——同 client_id 重试返回相同回执，弱网下不再重复下单；响应 id 用于客人回执查状态
  guestOrder: (t: string, from: string, note: string, items: { id: string; note: string; name?: string }[], clientId?: string) =>
    request<{ ok: boolean; id: string | null; accepted: { recipe_id: string; name: string; note: string }[]; dropped: string[] }>(
      "/api/guest/order", "POST", { t, from, note, items, client_id: clientId }),
  // 客人查自己单的状态（公开口，凭口令）：只回 done/done_date，单内容不回传
  guestOrderStatus: (t: string, ids: string[]) =>
    request<{ orders: { id: string; done: boolean; done_date?: string }[] }>(
      `/api/guest/order-status?t=${encodeURIComponent(t)}&ids=${encodeURIComponent(ids.join(","))}`),
  orders: () => request<Order[]>("/api/orders"),
  orderDone: (id: string, done = true) => request<Order>(`/api/orders/${id}`, "PUT", { done }),
  shopping: () => request<{ items: ShopItem[] }>("/api/shopping"),
  saveShopping: (items: ShopItem[]) => request<{ items: ShopItem[] }>("/api/shopping", "PUT", { items }),
  aiStatus: () => request<AiStatus>("/api/ai/status"),
  /** 贴教程文案/链接 → LLM 整理成结构化菜谱（参数形状与 web/src/api.ts 一致） */
  aiExtract: (text: string, source: string, url?: string) =>
    request<{ name: string; category: string; ingredients: Ingredient[]; steps: string[]; tips: string[]; kcal: number | null; minutes: number | null; difficulty?: string | null; source: string; video_can_retry: boolean }>(
      "/api/ai/extract", "POST", { text, source, url }, 90000),
  /** 看视频出菜谱：真花钱、真慢（约一两分钟），只应该在用户主动点了「看视频再试一次」时调 */
  aiExtractVideo: (url: string) =>
    request<{ name: string; category: string; ingredients: Ingredient[]; steps: string[]; tips: string[]; kcal: number | null; minutes: number | null; difficulty?: string | null; source: string; video_can_retry: boolean }>(
      "/api/ai/extract-video", "POST", { url }, 150000),
  /** 逐张生成插画（食材图标/步骤图），前端按张循环调用以显示进度，与 web/src/api.ts 一致——
   * 提交任务后轮询状态，不再是一个请求从头等到尾（见 pollIllustrateJob 注释） */
  aiIllustrate: async (recipe_id: string, kind: "ing" | "step", index: number) => {
    const { job_id } = await request<{ job_id: string }>("/api/ai/illustrate-start", "POST", { recipe_id, kind, index });
    return pollIllustrateJob(job_id);
  },
  config: () => request<ConfigPayload>("/api/config"),
  saveConfig: (c: object) => request<ConfigPayload>("/api/config", "PUT", c),
};

/** 所有请求失败统一 toast（页面里 catch 后调用） */
export function toastErr(e: unknown, fallback = "出错了") {
  const msg = (e as Error)?.message || fallback;
  Taro.showToast({ title: msg, icon: "none" });
}
