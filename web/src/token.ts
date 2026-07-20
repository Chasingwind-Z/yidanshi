// 主人令牌（可选）：后端设了 YIDANSHI_TOKEN 才生效；没设时全程无感、不加任何 header。
// 令牌存 localStorage，通过全局包一层 fetch 给同源 /api/ 请求自动带上 X-Token。
const KEY = "yidanshi_token";

export function getToken(): string {
  return localStorage.getItem(KEY) || "";
}
export function setToken(t: string): void {
  if (t.trim()) localStorage.setItem(KEY, t.trim());
  else localStorage.removeItem(KEY);
}

/** 从 URL 捕获一次性令牌（主人魔法链接 ?token=xxx 或 #/xxx?token=xxx），存下并从地址栏抹掉 */
export function captureTokenFromUrl(): void {
  const q = new URLSearchParams(location.search).get("token");
  const h = location.hash.includes("token=")
    ? new URLSearchParams(location.hash.split("?")[1] || "").get("token")
    : null;
  const t = q || h;
  if (t) {
    setToken(decodeURIComponent(t));
    const clean = location.hash.replace(/([?&])token=[^&]*/, "$1").replace(/[?&]$/, "");
    history.replaceState(null, "", location.pathname + (clean || "#/"));
  }
}

/** 全局包一层 fetch：同源 /api/ 请求带 X-Token；遇 401 广播事件让 UI 弹令牌框 */
export function installFetchAuth(): void {
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isApi = url.startsWith("/api/") || url.startsWith(location.origin + "/api/");
    const tok = getToken();
    if (isApi && tok) {
      init = { ...init, headers: { ...(init?.headers as Record<string, string>), "X-Token": tok } };
    }
    const res = await orig(input, init);
    if (isApi && res.status === 401) window.dispatchEvent(new Event("yidanshi-auth-required"));
    return res;
  };
}
