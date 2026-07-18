# 一箪食 yidanshi

> 一箪食，一瓢饮，在陋巷……不改其乐。——《论语·雍也》

记录自己做的每一顿饭，沉淀成一份好看的个人食单。

你是不是也这样：每周做饭，做法都是现找教程，做完就忘了怎么做的？
一箪食帮你把「做过的饭」变成资产。

| 今天吃什么 | 做法教程卡 | 吃饭时间线 |
|---|---|---|
| ![菜单](docs/screenshots/menu.png) | ![教程卡](docs/screenshots/recipe.png) | ![时间线](docs/screenshots/timeline.png) |

## 功能

- 📷 **拍照即记录** — 做完饭拍一张，本地 [rembg](https://github.com/danielgatis/rembg) 自动抠出碗盘、合成深色底菜卡（3–4 秒/张，不花钱不上传云端；也可直接上传 iPhone 相册长按抠好的透明图）
- 📖 **自己的菜单** — 一碗饭 / 一碗面 / 一碗汤 / 一碗菜分类浏览，每道菜有品味评分、做过几次；「随便来一份」帮你决定今天吃什么
- 🎨 **教程卡** — 食材图标 + 编号步骤 + 小贴士的做法卡片，支持为每道菜生成统一画风的 AI 插画（`scripts/gen_illust_prompts.py` 产出 prompt 清单，出图后放回目录即自动显示）
- 🤖 **AI 友好的数据** — 菜谱是 `data/recipes/*.md`，记录是 `data/meals.json`。把社交媒体教程丢给 AI 助手按 [docs/recipe-ingest.md](docs/recipe-ingest.md) 整理成文件即完成录入，页面上也能直接编辑
- 🏠 **自托管** — 跑在自己电脑上，手机浏览器加到主屏当 App 用（PWA）

## 快速开始

```bash
git clone https://github.com/Chasingwind-Z/yidanshi && cd yidanshi

# 后端（Python 3.10+）
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt

# 前端（Node 18+）
cd web && npm install && cd ..

# 跑起来（首次会自动下载抠图模型 ~180MB）
./scripts/serve.sh          # http://localhost:18100
```

macOS 想常驻后台：`./scripts/manage.sh install`（launchd 开机自启，`status` / `log` / `backup` / `uninstall` 子命令齐全）。手机在同一 Wi-Fi 下访问 `http://<电脑IP>:18100`，浏览器「添加到主屏幕」即可。

开发模式：`./scripts/dev.sh`（后端 :18100 + 前端热更新 :5173）。

## 数据即文件

```
data/
├── recipes/lusun-niupai.md   # 一道菜 = 一个 Markdown（frontmatter + 食材/步骤/贴士）
├── meals.json                # 吃饭记录
└── photos/                   # 原图 / 抠图 / 菜卡 / 插画
```

没有数据库。备份 = 打包 data/（`./scripts/manage.sh backup`）；迁移 = 拷目录；批量编辑 = 让 AI 助手直接改文件。示例菜谱见 [examples/recipes](examples/recipes)。

抠图默认 `isnet-general-use` 模型，追求更高质量：`YIDANSHI_MODEL=birefnet-general`（~930MB）。

## 灵感

来自微信小程序「我的Taste」（by 抖音博主 AB）——它展示的是作者自己的菜谱，而一箪食让每个人都能拥有自己的版本。微信小程序版移植评估见 [docs/miniprogram-eval.md](docs/miniprogram-eval.md)。

## License

[MIT](LICENSE)
