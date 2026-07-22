import { useEffect, useState } from "react";
import { getToken } from "../token";

type Cfg = Record<string, any>;
interface ConfigPayload {
  llm: Cfg; imagegen: Cfg; goal: Cfg;
  status: { backend: string; model: string; available: boolean; imagegen: { backend: string; model: string; available: boolean } };
  secrets: Record<string, boolean>;
  owner_token?: boolean;
}
interface BackupInfo { name: string; size_mb: number; time: string }

async function getConfig(): Promise<ConfigPayload> {
  return (await fetch("/api/config")).json();
}

function BackupSection() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/backup").then(r => r.json()).then(d => setBackups(d.backups)).catch(() => {});
  }, []);

  async function run() {
    setBusy(true);
    try {
      const r = await fetch("/api/backup", { method: "POST" });
      setBackups((await r.json()).backups);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="hint" style={{ marginTop: 0 }}>
        把 <code>data/</code>（菜谱、记录、照片）打包成 zip 存到 <code>data/backups/</code>，保留最近 5 份；密钥不入包。
        {backups[0] && <><br />上次备份：{backups[0].time}（{backups[0].size_mb} MB · 共 {backups.length} 份）</>}
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn ghost" disabled={busy} onClick={run}>{busy ? "备份中…" : "立即备份"}</button>
      </div>
    </>
  );
}

function MenuPosterSection() {
  // 新标签页直开图片接口；设了主人令牌就带 query token（owner_gate 支持 ?token=）
  const open = (style: string) => {
    const t = getToken();
    window.open(`/api/menuposter?style=${style}${t ? `&token=${encodeURIComponent(t)}` : ""}`, "_blank");
  };
  return (
    <>
      <div className="hint" style={{ marginTop: 0 }}>
        把整本食单排成一张纸上长图——题签、分帖、菜照、档案戳、候膳、落款，存下来就能晒。
        按「给谁看」选一种题签：
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn ghost" onClick={() => open("family")}>家宴食单</button>
        <button className="btn ghost" onClick={() => open("couple")}>二人小灶</button>
        <button className="btn ghost" onClick={() => open("solo")}>一人食帖</button>
      </div>
    </>
  );
}

function GuestLinkSection() {
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);

  async function make(reset = false) {
    const r = await fetch(`/api/guest-link${reset ? "?reset=true" : ""}`, { method: "POST" });
    const { token } = await r.json();
    setLink(`${location.origin}/#/guest/${token}`);
    setCopied(false);
  }
  useEffect(() => { make(); }, []);

  return (
    <>
      <div className="hint" style={{ marginTop: 0 }}>
        发给家人朋友，对方打开就是你的只读食单，能点菜不能改。点单会出现在你的食单页顶部。
        同一 Wi-Fi 直接可用；给外地的人用需要内网穿透（如 Cloudflare Tunnel）。
      </div>
      <input readOnly value={link} style={{ marginTop: 8 }} onFocus={e => e.target.select()} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn ghost" onClick={() => {
          navigator.clipboard?.writeText(link).then(() => setCopied(true));
        }}>{copied ? "已复制 ✓" : "复制链接"}</button>
        <button className="btn ghost danger" onClick={() => { if (confirm("重置后旧链接立即失效，确定？")) make(true); }}>重置链接</button>
      </div>
    </>
  );
}

export default function Settings() {
  const [cfg, setCfg] = useState<ConfigPayload | null>(null);
  const [llm, setLlm] = useState<Cfg>({});
  const [img, setImg] = useState<Cfg>({});
  const [llmKey, setLlmKey] = useState("");
  const [imgKey, setImgKey] = useState("");
  const [goalKcal, setGoalKcal] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getConfig().then(c => { setCfg(c); setLlm(c.llm); setImg(c.imagegen); setGoalKcal(c.goal?.kcal ? String(c.goal.kcal) : ""); });
  }, []);

  if (!cfg) return <div className="loading">加载中</div>;

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const secrets: Record<string, string> = {};
      if (llmKey && llm.api_key_env) secrets[llm.api_key_env] = llmKey;
      if (imgKey && img.api_key_env) secrets[img.api_key_env] = imgKey;
      const r = await fetch("/api/config", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm, imagegen: img, secrets, goal: { kcal: goalKcal ? Number(goalKcal) : "" } }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      const nc: ConfigPayload = await r.json();
      setCfg(nc); setLlm(nc.llm); setImg(nc.imagegen); setLlmKey(""); setImgKey("");
      setMsg("已保存，立即生效");
    } catch (e) {
      setMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const S = cfg.status;
  const keyState = (env?: string) => env ? (cfg!.secrets[env] ? "已配置，留空则不改" : "未配置，粘贴 key") : "先填环境变量名";

  return (
    <>
      <span className="seal">设</span>
      <h1>设置</h1>

      <div className="aibox">
        <div className="t">通道状态：文字 {S.available ? `✓ ${S.backend}${S.model ? ` (${S.model})` : ""}` : "✗ 不可用"}
          ；生图 {S.imagegen.available ? `✓ ${S.imagegen.model || S.imagegen.backend}` : "✗ 不可用"}</div>
      </div>

      <h1 style={{ fontSize: 18, marginTop: 24 }}>文字 AI（整理菜谱 / 估热量）</h1>
      <label className="f">通道</label>
      <select value={llm.backend ?? ""} onChange={e => setLlm({ ...llm, backend: e.target.value })}>
        <option value="">自动探测本机 claude / codex CLI（推荐，零配置）</option>
        <option value="claude-cli">claude CLI</option>
        <option value="codex-cli">codex CLI</option>
        <option value="openai">OpenAI 兼容 API（DeepSeek / Qwen 等）</option>
      </select>
      {llm.backend === "openai" && (
        <>
          <label className="f">Base URL</label>
          <input value={llm.base_url ?? ""} onChange={e => setLlm({ ...llm, base_url: e.target.value })}
            placeholder="https://api.deepseek.com/v1" />
          <div className="row">
            <div>
              <label className="f">模型</label>
              <input value={llm.model ?? ""} onChange={e => setLlm({ ...llm, model: e.target.value })} placeholder="deepseek-chat" />
            </div>
            <div>
              <label className="f">Key 环境变量名</label>
              <input value={llm.api_key_env ?? ""} onChange={e => setLlm({ ...llm, api_key_env: e.target.value })} placeholder="DEEPSEEK_API_KEY" />
            </div>
          </div>
          <label className="f">API Key（{keyState(llm.api_key_env)}）</label>
          <input type="password" value={llmKey} onChange={e => setLlmKey(e.target.value)} autoComplete="off" />
        </>
      )}

      <h1 style={{ fontSize: 18, marginTop: 28 }}>生图 AI（插画 / 精修）</h1>
      <label className="f">Base URL（OpenAI 兼容 /images/generations）</label>
      <input value={img.base_url ?? ""} onChange={e => setImg({ ...img, backend: "openai-images", base_url: e.target.value })}
        placeholder="https://ark.cn-beijing.volces.com/api/v3" />
      <div className="row">
        <div>
          <label className="f">生图模型</label>
          <input value={img.model ?? ""} onChange={e => setImg({ ...img, model: e.target.value })} placeholder="doubao-seedream-…" />
        </div>
        <div>
          <label className="f">精修模型（可空，省钱用 lite）</label>
          <input value={img.edit_model ?? ""} onChange={e => setImg({ ...img, edit_model: e.target.value })} placeholder="留空 = 同生图模型" />
        </div>
      </div>
      <div className="row">
        <div>
          <label className="f">Key 环境变量名</label>
          <input value={img.api_key_env ?? ""} onChange={e => setImg({ ...img, api_key_env: e.target.value })} placeholder="ARK_API_KEY" />
        </div>
        <div>
          <label className="f">API Key（{keyState(img.api_key_env)}）</label>
          <input type="password" value={imgKey} onChange={e => setImgKey(e.target.value)} autoComplete="off" />
        </div>
      </div>
      <label className="toggle" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, color: "var(--dim)", fontSize: 14 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={img.extra?.watermark === false}
          onChange={e => setImg({ ...img, extra: { ...(img.extra ?? {}), watermark: !e.target.checked } })} />
        去除平台水印（Seedream 支持）
      </label>

      <h1 style={{ fontSize: 18, marginTop: 28 }}>健康</h1>
      <label className="f">每日参考热量（kcal，留空则不显示对照）</label>
      <input type="number" inputMode="numeric" value={goalKcal} onChange={e => setGoalKcal(e.target.value)}
        placeholder="如 1800" style={{ maxWidth: 160 }} />
      <div className="hint">设了之后食历顶部会显示「今日 ≈N / 目标」。只做参考对照，数值都是估算，看趋势就好。</div>

      {msg && <div className="hint" style={{ marginTop: 12 }}>{msg}</div>}
      <div style={{ marginTop: 18 }}>
        <button className="btn" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存设置"}</button>
      </div>

      <h1 style={{ fontSize: 18, marginTop: 28 }}>访问口令</h1>
      <div className="hint" style={{ marginTop: 0, lineHeight: 1.9 }}>
        {cfg.owner_token
          ? <>已开启 ✓ 主人接口都要口令。手机换设备时用魔法链接 <code>http://电脑IP:18100/#/?token=你的令牌</code> 打开一次即可（令牌存本地、自动从地址栏抹掉；用 <code>#/</code> 形式令牌不会进服务器日志）。</>
          : <>当前<b>未设口令</b>——同一 Wi-Fi 局域网自用没问题。若要把服务开到公网（内网穿透 / 端口转发），先在 <code>data/secrets.env</code> 里加一行 <code>YIDANSHI_TOKEN=一串随机字符</code> 并重启，之后主人接口就要口令了；访客点菜链接不受影响。</>}
      </div>

      <h1 style={{ fontSize: 18, marginTop: 28 }}>纸上食单</h1>
      <MenuPosterSection />

      <h1 style={{ fontSize: 18, marginTop: 28 }}>点菜链接</h1>
      <GuestLinkSection />

      <h1 style={{ fontSize: 18, marginTop: 28 }}>备份</h1>
      <BackupSection />

      <h1 style={{ fontSize: 18, marginTop: 28 }}>数据</h1>
      <div className="hint" style={{ lineHeight: 2 }}>
        所有数据都是本机 <code>data/</code> 目录下的文件（菜谱 Markdown、记录 JSON、照片）。<br />
        备份：<code>./scripts/manage.sh backup</code>；手机访问：http://电脑IP:18100 加入主屏。<br />
        密钥保存在 <code>data/secrets.env</code>，不入 git、不上传。
      </div>
    </>
  );
}
