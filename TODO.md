# 一箪食 · 路线图

按 Goal 推进。G0–G7 首轮已完成（2026-07-18），剩余项集中在「待人工确认 / 待真实使用」。

## G0 项目骨架 ✅

- [x] 技术栈：FastAPI + Vite React PWA + 文件数据库
- [x] 目录结构：`server/`、`web/`、`data/{recipes,meals.json,photos}`
- [x] 数据 schema：菜谱 md（frontmatter + 食材/步骤/贴士）、meals.json
- [x] 空菜单页跑通

## G1 抠图美化管线 ✅

- [x] rembg（isnet-general-use）抠碗盘 → 透明 PNG，3–4 秒/张
- [x] 深色底 + 居中 + 投影菜卡合成（`server/cutout.py`）
- [x] 兜底：上传已抠透明 PNG（iPhone 长按抠图）
- [x] 3 张真实照片验证 → `docs/cutout-samples/`；已知弱场景：白盘白底（可换 `YIDANSHI_MODEL=birefnet-general`）

## G2 菜谱库 + 记一餐 ✅

- [x] 菜谱 CRUD（页面编辑 + 直接改 md 文件双通道）
- [x] 记一餐：上传→抠图→选/建菜谱→日期/评分/备注；封面自动设置
- [x] 吃饭时间线 + 菜谱详情页
- [x] 端到端验证（cutout API → meals API → 页面展示）

## G3 菜单页 Taste 风格 ✅

- [x] 分类侧栏 + 菜卡列表（照片/品味/做过几次/查看做法）
- [x] 深色主题（等宽数字、描边 chip、灰蓝 accent）
- [x] 「随便来一份」随机推荐

## G4 插画教程卡 ✅（出图待确认）

- [x] AB 风版式：居中菜名 by zzf、食材图标栏、编号步骤、小贴士
- [x] 无插画降级：emoji 食材图标 + 纯文字步骤（当前效果见 docs/screenshots/recipe.png）
- [x] 插画管线：`scripts/gen_illust_prompts.py` 生成统一画风 prompt 清单，出图放回 `data/photos/illust/<id>/` 即自动显示
- [x] 教程录入流：`docs/recipe-ingest.md`（教程丢给 AI → 结构化 md）
- [ ] 为 2 道菜实际生成 AI 插画（拟委派 Codex image_gen，**待 zzf 确认**）

## G5 部署自用 ✅

- [x] launchd 常驻（`./scripts/manage.sh install`，服务 com.zzf.yidanshi，端口 18100）
- [x] PWA：manifest + 「箪」字图标，手机同 Wi-Fi 访问 `http://<IP>:18100` 加主屏
- [x] 备份：`./scripts/manage.sh backup` → ~/Backups/
- [ ] 连续记录一周真实晚饭（**待真实使用**）

## G6 开源打磨 + 首发 ✅（发布待确认）

- [x] README：效果截图、快速开始、数据即文件说明
- [x] 示例菜谱 `examples/recipes/`（3 道）
- [x] 部署脚本：serve.sh / manage.sh / dev.sh
- [x] 小红书首发帖草稿：`docs/xiaohongshu-draft.md`
- [ ] 发帖（**待 zzf 确认**，建议真实使用 1–2 周、截图换真数据后再发）

## G7 微信小程序移植评估 ✅

- [x] `docs/miniprogram-eval.md`：成本、抠图三方案、数据/UI 映射、触发条件

---

## 已定决策（背景）

- 载体：先自托管 Web 验证，后搬小程序（2026-07-17）
- 教程页：复刻「我的Taste」的 AI 插画卡片风
- 定位：「每个人自己的 Taste」；竞品缺口 = Taste 只展示作者菜谱、「简单吃点」是决策器且评论区 146 赞求个人菜谱录入、Mealie/Tandoor 无美化卡片和中文语境
- 数据必须是 AI 助手可直接读写的本地文件（Markdown/JSON）
