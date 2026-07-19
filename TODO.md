# 一箪食 · 路线图

按 Goal 推进。G0–G7 首轮已完成（2026-07-18），R2 体验迭代、R3 生图管线已完成（同日），剩余项集中在「待人工确认 / 待真实使用」。

## R3 生图管线 ✅（插画一键生成，等配 key 即用）

- [x] 风格规范 `docs/illustration-style.md`（设计 agent 产出）：以 AB 教程卡为基准定为「贴纸式厚涂卡通」，含逐字锚点前缀、食材/步骤两套模板、负面清单、芦笋牛排 6 条成品 prompt、尺寸与深色适配规则
- [x] `server/imagegen.py`：openai-images 兼容通道（豆包 Seedream / gpt-image-1 / SiliconFlow 等）+ codex-cli 通道（检测到二进制才启用）；prompt 与风格规范同源
- [x] 详情页「✨ 生成插画教程卡」：逐张生成显示进度，边画边上卡，失败可续
- [x] mock 端到端验证通过（真实出图待配 key：`data/config.json` 照抄 `deploy/config.example.json` + 设置对应环境变量）
- [x] 口语化描述整理：AI 整理 prompt 升级，随口描述的做法回忆也能规整（不发明内容、缺量写"适量"、经验归贴士）
- [ ] 配上真实生图 key 后跑一道菜全套插画，按 72px 缩图自检风格（**待 zzf 配 key**）
- [ ] codex CLI 修复：~/.local/bin/codex 软链指向的 Codex.app 已不存在（**待 zzf 重装或删软链**）

## R2 体验迭代 ✅（基于真实使用反馈 + 双设计 agent 审视）

- [x] 抠图 v2：圆框参考线（拖动/缩放对准盘子）→「AI 抠图 / 圆框直裁」双结果任选；auto 失败静默降级；透明 PNG 自动识别（前后端双检）；raw 先落盘永不丢图
- [x] AI 通道：`server/llm.py` 三后端（claude-cli 零配置复用订阅 / codex-cli / OpenAI 兼容 API 如 DeepSeek——注意 DeepSeek 无多模态）；`/api/ai/extract` 教程原文→结构化菜谱
- [x] App 内录菜谱：菜单页「＋」→ `#/new`，编辑器内置「AI 整理」粘贴框（claude-cli 实测通过）
- [x] 记录可改可删：时间线「⋯」→ 改评分/日期/备注、删除（二次确认）
- [x] UX 闭环：详情页返回键、菜卡整卡可点、空状态给按钮（含一键载入示例菜单 `/api/seed-examples`）、最近做过 chips、今天/昨天快捷、评分默认不评、🎲 分类内随机、PWA shortcuts 直达记一餐
- [x] 视觉：纯黑画布 + 抠图悬浮（drop-shadow + 盘压卡构图）、教程卡印刷感（楷体标题/栏间竖线/描线框）、线条语言三档收敛、时间线日期吸顶、空/加载态
- [ ] 自定义相机页（getUserMedia 实时圆环取景，拍时即框准）——下一轮
- [ ] 服务端自动抓链接提炼（抖音/小红书反爬+封号风险，暂用「复制文案粘贴」路线）

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

## R7 近期五件套 ✅（2026-07-18）

- [x] 翻牌子加条件：🎴 弹出「最近 7 天没做过 / 30 分钟内能做」开关（偏好记忆），条件内没菜逐级放宽绝不空手；菜谱新增耗时字段（AI 整理自动估）
- [x] 月度食单回忆卡：`/api/monthcard/YYYY-MM` Pillow 合成（印章+统计+摆盘九宫格+本月最佳+落款），食历页「本月食单卡」一键打开
- [x] 实测量回填：记完餐若该菜有"适量"类模糊量，轻提示回填实际用量（一键跳过，绝不挡路）
- [x] 热量周视图：食历顶部本周餐数 + kcal 合计（菜谱级热量自动带出，零记录成本）
- [x] 教程卡导出长图：详情页「导出长图」（html-to-image，2x 像素）

## R8 中期两件套 ✅（2026-07-18）

- [x] 点菜链接：设置页生成/复制/重置带 token 的只读食单页（#/guest/<token>，无导航无编辑），亲友勾菜「传旨」下单（称呼+留言）；点单出现在食单页顶部收件箱（菜名可跳菜谱，做完了一键归档）；错 token 403
- [x] 买菜清单：新「买菜」tab，勾选本周想做的菜 → 食材自动合并（同名合并用量、标来源菜），调料自动分区「家里可能已有」；勾选已买、清空/重选；data/shopping.json 跨设备同步
- [ ] 外网点菜：Cloudflare Tunnel / Tailscale Funnel 接入指南（**待 zzf 有真实外网需求时**）

## R9 成熟度打磨 ✅（2026-07-18）

- [x] 链接导入：/api/ai/extract 支持 url（抖音分享页扒文案实测成功 + og 标签通用兜底），AI 框直接粘抖音口令即可；非做菜内容不瞎编、反爬失败引导粘文案
- [x] 碗内食物占比修复（0.42→0.54，炒饭不再显小），平盘/浅盘同步微调
- [x] 苹果味打磨（emilkowalski/skills 的 apple-design 落地）：全站按压即时反馈（pointer-down scale .97）、页面 180ms 渐入过渡、辅助文字对比度提到 ≥4.5:1、触控目标统一 ≥44pt、focus-visible 键盘焦点、tabbar 毛玻璃 blur20+saturate160、prefers-reduced-motion 全覆盖、去 iOS 点按高亮
- [x] skill 安装：apple-design（Emil WWDC 秘籍）+ apple-hig-review（HIG 审查）+ improve-animations 入中央库，双 agent 可用
