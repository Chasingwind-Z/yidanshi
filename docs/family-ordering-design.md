# 家庭点餐 + 实时提醒 · 设计

> 定位：这是**功能**，不是美食社交。家人/朋友通过小程序给「这个厨房」点菜，
> 点单落主人收件箱，主人做饭。多人可点（家人常在、朋友临时），主人实时收提醒。

## 一、现状（已有底座，别重造）

后端 `server/app.py:569-642` 已实现一套亲友点菜 v0：

| 接口 | 作用 | 谁能调 |
|---|---|---|
| `POST /api/guest-link?reset=` | 主人生成/重置**点菜链接 token**（存 `config.guest.token`） | 主人 |
| `GET  /api/guest/menu?t=` | 凭 token 看菜单（只读，含每餐 kcal/评分/次数） | 任何人凭 token |
| `POST /api/guest/order` | 提交点单（`from` 名字 + `note` 留言 + `items` 菜 id） | 任何人凭 token |
| `GET  /api/orders` | 主人看收件箱（倒序） | 主人 |
| `PUT  /api/orders/{oid}` | 标记这单已做 | 主人 |

关键：guest 三接口在 `_PUBLIC_API` 白名单里，**不校验 owner openid**——
朋友的微信 openid 不是主人也能点。多人点菜天然成立，无需给每个家人绑 openid、
建成员表。谁点的靠 `from` 名字区分即可（v1 足够，别过度工程化）。

## 二、真正要新做的只有两件

> 2026-07-21 增补：竞品吸收结论见 docs/competitor-absorption.md——措辞禁用
> 订单/购物车/结算（叫「想吃/点菜/传旨」）；角色只有主人/客人两种；客人一屏完成
> 选菜→备注→留名→传出。**每道菜可带备注**（少放辣…）：`POST /api/guest/order`
> 的 items 现兼容两种格式——旧 `["菜id"]` / 新 `[{"id":"菜id","note":"少放点辣"}]`，
> 落库 items 为 `[{recipe_id, name, note}]`（note ≤60 字，已实测通过）。

### P1 · 小程序点菜（无推送，零新凭证，可立刻做）
纯前端 + 复用现有后端，不碰密钥、不走审核。

1. **主人侧（设置页）**：一个「点菜链接」区 → 调 `/api/guest-link` 拿 token →
   通过小程序 `onShareAppMessage` **转发成小程序卡片**，卡片 query 带 `?t=<token>`。
   发给老婆/朋友即可。附「重置链接」（旧链接作废，等于踢掉所有旧访客）。
2. **访客侧（新「点菜」页）**：打开卡片 → 小程序从 `options.query.t` 取 token →
   进点菜页（复用 `/api/guest/menu`）→ 选菜 + 填名字 + 留言 → 提交
   （复用 `/api/guest/order`）。没 token 就提示「找主人要点菜链接」。
3. **主人侧（新「收件箱」页 / 或首页红点）**：拉 `/api/orders`，
   谁点了啥、留言、点「已做」。
4. miniapp 的 `api.ts` guest 接口同样走 `callContainer`（公网也走云托管），
   guest 接口非 owner 也放行 → 朋友 openid 能点。

> P1 做完，「老婆在公司点、你开 App 看到」就通了——只差「不开 App 也弹提醒」。

### P2 · 实时提醒（两条路，推荐 Server酱）
zzf 问"能不能像公众号那样推送"——字面上不行（服务号需企业主体+认证，个人注册不了；
个人订阅号发不了推送）。但**收提醒的永远只有主人一个人**，所以推荐借道：

**路线 A（推荐）· Server酱**：主人微信关注 Server酱 的公众号拿 SendKey →
后端在 guest_order 成功后 POST 一条 → 主人微信「服务通知」即时弹。
免审核、免 AppSecret、免攒额度；缺点=发信人显示第三方、免费版有每日条数上限（个人够用）。
新增 env：`SERVERCHAN_SENDKEY`（只配云端；发送失败静默，不阻断点单）。

**路线 B · 微信订阅消息**（原生但重，作为备选）：

- 小程序推送只能用**订阅消息**。个人「工具」类小程序现实中只能拿**一次性订阅**
  （长期订阅要特定类目、难批）。规则：**收消息的人（你）每点一次授权 = 攒一条可发额度**。
- 落地流程：
  1. 小程序后台申请**「订单/服务通知」类目消息模板**，过审拿 `template_id`。
  2. 后端用 **AppSecret** 换 `access_token`（缓存 ~2h）：
     `GET api.weixin.qq.com/cgi-bin/token`。
  3. 主人在「收件箱/设置」点「开启点菜提醒」→ `wx.requestSubscribeMessage({tmplIds})`
     授权，攒 N 条额度。额度快用完时再点「攒提醒额度」。
  4. 访客提交点单 → 后端 `POST cgi-bin/message/subscribe/send`（`touser=主人 openid`，
     填模板字段：点单人/菜品/时间/留言）→ 你微信「服务通知」里弹出。
- **诚实约束**：做不到「无限静默推送」。每条提醒消耗一次你点授权攒的额度，
  用完得再点一下。这是微信规则不是偷懒。可用「攒 10 条」按钮把体验做顺。
- **AppSecret 我不经手**：调用代码我写好，你**亲自**把 AppSecret 填进云托管
  环境变量（跟别的密钥一样，只是这个连「帮你填」都不做）。

## 三、数据 / 改动清单

**P1**
- 前端 `miniapp/`：新增「点菜」页 + 「收件箱」页；设置页加「点菜链接 + 转发卡片」；
  `app` 的 `onLaunch/onShow` 读 `options.query.t` 存全局，点菜页取用。
- 后端：基本零改。可选给 `orders` 记录补个 `openid`（从 `X-WX-OPENID` 取，
  仅留痕，不做权限）便于日后统计。

**P2**
- 后端新增 `server/wxpush.py`：`get_access_token()`（缓存）+ `notify_owner_order()`；
  在 `guest_order` 成功后触发（失败静默，不阻断点单）。
  新增 env：`YIDANSHI_APPID`、`YIDANSHI_APPSECRET`、`YIDANSHI_SUBSCRIBE_TMPL_ID`。
- 前端：收件箱页加「开启/续攒 点菜提醒」按钮（`requestSubscribeMessage`）。

## 四、需要你定 / 提供

1. **P1 现在就开做？**（安全、无凭证、无审核，做完即"你能看到点单"）——建议先做。
2. **收件箱放哪**：独立底 tab？还是并进首页 + 未读红点？（我倾向首页红点，tab 不加）
3. **P2 何时做**：要你先在小程序后台申请消息模板（我给你模板字段清单）+ 提供
   AppSecret 到云托管。你准备好了我再接推送代码。
