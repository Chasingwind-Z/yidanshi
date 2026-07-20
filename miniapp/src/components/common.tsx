// 页面通用小件：加载态 / 失败重试（对齐 Web R17-j）/ 五星评分条
import { Text, View } from "@tarojs/components";

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
