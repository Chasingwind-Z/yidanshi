// 页面通用小件：加载态 / 失败重试（对齐 Web R17-j）/ 五星评分条 / 晒图弹层
import { useState } from "react";
import Taro from "@tarojs/taro";
import { Image, ScrollView, Text, View } from "@tarojs/components";

export function Loading({ text = "加载中" }: { text?: string }) {
  return (
    <View className="loading">
      <View className="spin" />
      <Text>{text}</Text>
    </View>
  );
}

export function ErrRetry({ what, err, onRetry }: { what: string; err: string; onRetry: () => void }) {
  return (
    <View className="empty">
      <View className="empty-ico">🍚</View>
      <Text>{what}没能读出来</Text>
      <View className="dimtext err-detail">{err}</View>
      <View className="btn retry-btn" onClick={onRetry}>重试</View>
    </View>
  );
}

/** 晒图弹层（教程卡 / 纸上食单共用）：加载服务端渲染的 PNG 长图，
 *  weapp 里长按走 Image 原生菜单（保存 / 发给朋友），h5 里浏览器长按同理。 */
export function PosterSheet({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  return (
    <View className="postscrim" catchMove onClick={onClose}>
      <View className="postersheet" onClick={e => e.stopPropagation()}>
        <View className="postersheet-head">
          <Text className="postersheet-title">{title}</Text>
          <View className="postersheet-close" onClick={onClose}>✕</View>
        </View>
        <ScrollView scrollY className="postersheet-scroll">
          {state === "loading" && <Loading text="研墨铺纸中" />}
          {state === "err" && (
            <View className="empty">
              <View className="empty-ico">🍚</View>
              <Text>图没能取回来，稍后再试</Text>
            </View>
          )}
          <Image src={url} mode="widthFix" showMenuByLongpress className="postersheet-img"
            style={state === "err" ? { display: "none" } : undefined}
            onLoad={() => setState("ok")} onError={() => setState("err")} />
          {/* 显式保存原图：长按保存不显眼且有人会用截屏（分辨率折半）——一个正经按钮存原图 */}
          {state === "ok" && process.env.TARO_ENV === "weapp" && (
            <View className="btn postersheet-save" hoverClass="btn-hover" onClick={async () => {
              try {
                const dl = await Taro.downloadFile({ url });
                await Taro.saveImageToPhotosAlbum({ filePath: dl.tempFilePath });
                Taro.showToast({ title: "原图已存进相册", icon: "none" });
              } catch (e) {
                const msg = (e as { errMsg?: string })?.errMsg || "";
                if (msg.includes("auth")) {
                  const { confirm } = await Taro.showModal({
                    title: "需要相册权限", content: "去设置里允许保存到相册?",
                    confirmText: "去设置", cancelText: "算了",
                  });
                  if (confirm) Taro.openSetting();
                } else {
                  Taro.showToast({ title: "没存上，长按图片也能保存", icon: "none" });
                }
              }
            }}>保存原图到相册</View>
          )}
        </ScrollView>
        {state === "ok" && <View className="postersheet-hint">长按图片可保存或发给朋友</View>}
      </View>
    </View>
  );
}

export function Stars({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <View className="stars">
      {[1, 2, 3, 4, 5].map(n => (
        <View
          key={n}
          className={`star ${value !== null && n <= value ? "on" : ""}`}
          onClick={() => onChange(value === n ? null : n)}
        >
          {n <= (value ?? 0) ? "★" : "☆"}
        </View>
      ))}
    </View>
  );
}
