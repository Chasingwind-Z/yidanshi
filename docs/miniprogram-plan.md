# 小程序移植执行方案（R18，2026-07-20 定稿）

前置评估见 [miniprogram-eval.md](miniprogram-eval.md)。zzf 已定方向：**手机上要小程序，不走 Web**。
本文是可执行版：架构定稿、分阶段任务、成本、风险。

## 架构（定稿）

```
微信小程序（Taro + React + TS，逻辑从 web/src 移植）
    │  wx.cloud.callContainer —— 免域名、免 HTTPS 证书、免 ICP 备案
    ▼
微信云托管容器（现有 FastAPI 改造，Dockerfile 部署，缩容到 0 不花钱）
    ├─ 存储：Serverless MySQL「行式文件库」
    │     recipes(id PK, md TEXT)   ← 一道菜=一篇 Markdown 原文，解析逻辑照旧
    │     kv(name PK, json TEXT)    ← meals/orders/shopping/pantry/config 各占一行
    ├─ 照片：云托管对象存储（原图/抠图/菜卡/插画，CDN 加速）
    ├─ 抠图：腾讯云「图像分割」API（zzf 已定，≈¥0.01-0.1/次，不再容器跑 rembg）
    ├─ AI 整理：DeepSeek API（zzf 已定，llm.py openai 通道现成，≈¥1-2/月）
    └─ 生图：ARK Seedream 不变
```

**为什么是「行式文件库」而不是正经建表**：storage.py 的全部解析/序列化逻辑
（_parse_md/_dump_md/份数/克重/朱批）一行不用改，只把「读写文件」换成「读写行」。
数据导出 = SELECT 出来落盘就还原成 data/ 目录，随时可迁回自托管。
Web 版照常跑文件后端——同一套代码，`YIDANSHI_STORE=file|mysql` 切换。

## 分阶段

### A. 本地可做（不需要注册，进行中）
1. ✅ 本方案文档
2. storage 后端抽象：FileStore（现状）/ DbStore（行式文件库）同接口，
   photos 路径抽象成 BlobStore（本地目录 / 对象存储两个实现）
3. Taro 项目 scaffold（miniprogram/，testappid）+ 核心两页：食单、菜谱详情
   （开发期直连 http://localhost:18100，开发者工具勾「不校验合法域名」）
4. 依次移植：记一餐（拍照→上传→云端抠图）→ 食历 → 买菜/库存 → 设置
5. Dockerfile.wxcloud（去 rembg 依赖，容器瘦到 <200MB）

### B. 只有 zzf 能做（并行，都不急）
- 注册小程序个人主体（免费，实名）→ AppID；名称「一箪食」可用（不带需资质词）
- 开通云托管（同一账号下），拿环境 ID
- 腾讯云开「图像分割」API，拿 SecretId/Key；DeepSeek 充值拿 key
- 所有 key 都进云托管环境变量，不进代码（同 secrets.env 纪律）

### C. 联调发布（A+B 齐了之后）
- callContainer 接入替换 localhost；对象存储上传通路
- 抠图/AI/生图三通道联调；数据从 Mac data/ 一键导入云端（脚本）
- 类目「生活服务-其他」提审；点菜留言（UGC）接 msgSecCheck 内容安全

## 成本（低频自用估算）

| 项 | 费用 |
|---|---|
| 小程序注册 | 免费（个人主体） |
| 云托管容器 | 按量，缩容到 0 不用不花钱，低频 ≈几元/月 |
| MySQL Serverless + 对象存储 | ≈几元/月（照片几个 GB 内） |
| 抠图 API | ≈¥0.01-0.1/次 → 每月几块钱 |
| DeepSeek | ≈¥1-2/月 |
| **合计** | **≈¥10/月 以内** |

## 风险与对策

- **审核**：纯记录工具通常可过；点菜留言算 UGC，接内容安全接口即可。
  被拒兜底：v1 先去掉留言框（点菜只选菜不留言）。
- **冷启动**：缩容到 0 后首次 callContainer 有几秒冷启动；设「最小副本 0」自用可接受，
  受不了再调成 1（费用升到 ≈¥40/月档，到时再说）。
- **iOS 上照片体验**：小程序相机/相册 API 完备，圆框参考线用 canvas 重画（工作量已计入）。
- **Web 版地位**：保留（开发调试 + 桌面查看 + 开源 demo），数据以云端为准后
  Mac 版转「只读镜像 + 备份下载」。

## 触发条件的变更说明

G7 曾定「Web 版连续记录 ≥4 周再移植」。zzf 2026-07-20 明确表示手机上要小程序、
不想用 Web 版——触发条件由本人推翻，即日启动。
