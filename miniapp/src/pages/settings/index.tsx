// 设置（移植 web/src/pages/Settings.tsx 的子集：每日热量目标、AI 通道状态展示、
// 点菜链接生成+复制。砍掉：AI 通道/生图配置编辑、访问口令说明、备份区、数据说明——
// 这些属于服务器运维，留在 Web 端）
import { useEffect, useState } from "react";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import { Button, Input, Text, View } from "@tarojs/components";
import { api, toastErr, type AiStatus, type ConfigPayload } from "../../api";
import { Loading } from "../../components/common";
import { CLOUDRUN_HTTP_BASE, LOCAL_BASE } from "../../config";
import "./index.scss";

const isWeapp = process.env.TARO_ENV === "weapp";

function GuestLinkSection({ token, remake }: { token: string; remake: (reset: boolean) => void }) {
  const webBase = isWeapp ? CLOUDRUN_HTTP_BASE : LOCAL_BASE;
  const link = token ? (webBase ? `${webBase}/#/guest/${token}` : token) : "";

  function copy() {
    if (!link) return;
    Taro.setClipboardData({ data: link }).then(() =>
      Taro.showToast({ title: webBase ? "链接已复制" : "已复制点菜口令（未配 Web 域名）", icon: "none" }));
  }

  async function reset() {
    const { confirm } = await Taro.showModal({
      title: "重置点菜卡片",
      content: "重置后，之前发出的点菜卡片和链接都会失效，确定？",
      confirmText: "重置",
      cancelText: "再想想",
    });
    if (confirm) remake(true);
  }

  return (
    <>
      <View className="hint nomt">
        把点菜卡片发给家里人或来做客的朋友，对方点开就能选想吃的菜、留讲究（少放辣…），
        不能动你的菜谱。有人点了菜，食单页顶上会亮出来。
      </View>
      {isWeapp && (
        <Button className={`btn sharebtn ${token ? "" : "disabled"}`} openType="share" hoverClass="btn-hover">
          发点菜卡片给家里人 ✉
        </Button>
      )}
      <View className="linkbox">{link || "生成中…"}</View>
      <View className="row acts-sm">
        <View className="btn ghost" hoverClass="btn-hover" onClick={copy}>复制网页链接</View>
        <View className="btn ghost danger" hoverClass="btn-hover" onClick={reset}>重置</View>
      </View>
      <View className="btn ghost inboxbtn" hoverClass="btn-hover"
        onClick={() => Taro.navigateTo({ url: "/pages/inbox/index" })}>收到的点菜 ›</View>
    </>
  );
}

export default function Settings() {
  const [cfg, setCfg] = useState<ConfigPayload | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [goalKcal, setGoalKcal] = useState("");
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState("");

  const makeToken = (reset: boolean) =>
    api.guestLink(reset).then(d => setToken(d.token)).catch(toastErr);

  // 「发点菜卡片」转发：卡片直达点菜页并带上口令
  useShareAppMessage(() => ({
    title: "来我家点菜呀 🍚",
    path: `/pages/order/index?t=${token}`,
  }));

  useEffect(() => {
    api.config().then(c => {
      setCfg(c);
      setGoalKcal(c.goal?.kcal ? String(c.goal.kcal) : "");
    }).catch(toastErr);
    api.aiStatus().then(setStatus).catch(() => {});
    makeToken(false);
  }, []);

  if (!cfg) return <View className="page"><Loading /></View>;

  async function save() {
    setSaving(true);
    try {
      // 与 Web 端 PUT /api/config 同构：llm/imagegen 原样带回，只改 goal
      const nc = await api.saveConfig({
        llm: cfg!.llm, imagegen: cfg!.imagegen, secrets: {},
        goal: { kcal: goalKcal ? Number(goalKcal) : "" },
      });
      setCfg(nc);
      setGoalKcal(nc.goal?.kcal ? String(nc.goal.kcal) : "");
      Taro.showToast({ title: "已保存，立即生效", icon: "none" });
    } catch (e) {
      toastErr(e, "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="page">
      <Text className="seal">设</Text>
      <View className="h1">设置</View>

      <View className="papercard dashed aibox">
        <View className="t">
          通道状态：文字 {status ? (status.available ? `✓ ${status.backend}${status.model ? ` (${status.model})` : ""}` : "✗ 不可用") : "…"}
          ；生图 {status?.imagegen ? (status.imagegen.available ? `✓ ${status.imagegen.model || status.imagegen.backend}` : "✗ 不可用") : "✗ 不可用"}
        </View>
        <View className="dimtext">AI 通道在服务端配置（云端走 DeepSeek），这里只看状态</View>
      </View>

      <View className="h2">健康</View>
      <View className="f">每日参考热量（kcal，留空则不显示对照）</View>
      <View className="goalrow">
        <Input className="ipt goalipt" placeholderClass="ph" type="number" value={goalKcal}
          onInput={e => setGoalKcal(e.detail.value)} placeholder="如 1800" />
      </View>
      <View className="hint">设了之后食历顶部会显示「今日 ≈N / 目标」。只做参考对照，数值都是估算，看趋势就好。</View>
      <View className="acts">
        <View className={`btn ${saving ? "disabled" : ""}`} hoverClass="btn-hover"
          onClick={() => { if (!saving) save(); }}>{saving ? "保存中…" : "保存设置"}</View>
      </View>

      <View className="h2">家人点菜</View>
      <GuestLinkSection token={token} remake={r => makeToken(r)} />
    </View>
  );
}
