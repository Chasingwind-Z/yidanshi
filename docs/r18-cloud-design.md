# R18 设计契约：小程序 + 微信云托管（多 agent 共用）

坐标：AppID/云托管环境 ID 见 miniapp/src/config.ts（部署者各填各的）· 服务名约定 `yidanshi`。
原则：**本地 Web 部署零行为变化**（zzf 天天在用）；所有云能力走环境变量开关，默认=现状。

## 架构

```
小程序(Taro) ──wx.cloud.callContainer──▶ 云托管容器(FastAPI, 同一套 server/)
                                          ├─ MySQL(云托管插件)     ← 菜谱/记录/杂项文档
                                          ├─ COS                  ← 照片
                                          ├─ DeepSeek(v4-flash)   ← AI 整理（云端无 claude-cli）
                                          └─ 阿里云 SegmentFood    ← 抠图（rembg 不进云镜像）
本地 Web(现状) ──▶ launchd :18100，文件存储 + rembg + claude-cli，全部不变
```

## 环境变量契约（唯一开关面）

| 变量 | 未设时 | 设了时 |
|---|---|---|
| `YIDANSHI_DB_URL` | 文件存储（现状） | SQLAlchemy URL（测试 `sqlite:///…`，云上 `mysql+pymysql://…`） |
| `MYSQL_ADDRESS/MYSQL_USERNAME/MYSQL_PASSWORD` | — | 云托管 MySQL 插件注入的标准变量；`YIDANSHI_DB_URL` 缺席时由此拼出（库名 `yidanshi`，不存在则建） |
| `COS_SECRET_ID/COS_SECRET_KEY/COS_REGION/COS_BUCKET` | 照片存本地（现状） | 照片上传 COS，字段里存完整 https URL |
| `DEEPSEEK_API_KEY` | — | llm 自动链新增一环：无 claude/codex CLI 时 → openai 通道 base_url `https://api.deepseek.com`、模型 **`deepseek-v4-flash`**（注意 deepseek-chat 已下线） |
| `ALIYUN_AK_ID/ALIYUN_AK_SECRET` | 云端抠图只有圆框直裁 | 启用 SegmentFood 抠图 |
| `YIDANSHI_OWNER_OPENID` | — | 云端鉴权：callContainer 注入的 `X-WX-OPENID` == 此值 → 主人；≠ → 只放行 /api/guest/*；新增 GET /api/whoami 回显 openid 供 zzf 首次获取 |
| `YIDANSHI_TOKEN` | 现状 | 原样保留（Web 端口令），与 openid 鉴权并存（任一通过即主人） |
| `PORT` | 18100 本地 | 云托管容器用 80 |

## 存储层（server/storage.py 重构）

- 公开函数签名**不变**（list_recipes/get_recipe/save_recipe/delete_recipe/list_meals/add_meal/update_meal/delete_meal/recipe_stats/slugify/coerce_grams/valid_id…），app.py 尽量零改动。
- 内部两个实现：`_FileStore`（现状代码原样搬入，含 R17 的原子写/校验）与 `_DbStore`（SQLAlchemy Core）。模块加载时按 `YIDANSHI_DB_URL` 选一个。
- 表：`recipes`(id PK, name, category, cover, source, created, kcal, minutes, difficulty, servings, ingredients/steps/tips 存 JSON 文本)；`meals`(id PK, recipe_id, date, rating, note, photo_card, kcal, recipe_name)；`kvdocs`(name PK, body JSON 文本) 承载 orders/shopping/pantry/config/食材缓存——app.py 里直接读写 *_FILE 的地方要改走 storage 提供的 `read_doc(name)/write_doc(name, obj)`（文件模式下就是原来的 json 文件，路径/格式不变）。
- R17 的校验语义（_ID_RE 小写、评分 1-5、日期格式、快照字段）两个实现都必须成立。

## 照片层（新 server/photostore.py）

- `save(kind, name, data) -> url`：COS 配齐 → 上传 `photos/<kind>/<name>`，回 `https://<bucket>.cos.<region>.myqcloud.com/...`；否则写本地 `data/photos/<kind>/<name>`，回 `/photos/<kind>/<name>`（现状）。
- monthcard/合成等**读**照片处：字段值是 http(s) 开头就 urllib 拉字节，否则按本地路径（现状）。

## 云端抠图（新 server/segfood.py）

- 懒加载 alibabacloud_imageseg20191230；AK 未配或库缺失 → 返回 None。
- cutout 流程改为：rembg 可用（本地）→ 用 rembg；否则 segfood 可用 → 用它；都没有 → 只出圆框直裁结果并在响应里注明。

## 云镜像

- `server/requirements-cloud.txt`：fastapi/uvicorn/PyYAML/pillow/pypinyin/python-multipart/SQLAlchemy/PyMySQL/cos-python-sdk-v5/alibabacloud_imageseg20191230（**无 rembg/onnxruntime**）。
- `Dockerfile`：python:3.11-slim，装 cloud requirements，`CMD uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-80}`。
- `container.config.json`：minNum 0 / maxNum 1 / cpu 0.25 / mem 0.5 / containerPort 80。
- 确认 server/ 在无 rembg 环境可 import（rembg 已是函数内懒加载，验证别退化）。

## 小程序（新目录 miniapp/，Taro 4 + React + TS）

- 页面 v1：食单(index)、菜谱详情、记一餐、食历、买菜、设置（guest 点菜后续）。TabBar 同 Web：食单/记一餐/买菜/食历。
- `src/api.ts`：统一 `request(path, method, data)`——weapp 环境走 `Taro.cloud.callContainer({config:{env:CLOUD_ENV}, path, header:{'X-WX-SERVICE':SERVICE}, …})`（两常量在 src/config.ts）；h5 dev 走 fetch `http://127.0.0.1:18100`（本地联调用）。
- 主题：把 web/src/index.css 的宣纸配色（--bg #f4efe3 / --card #fdfaf3 / --ink #2f2a22 / --dim #6f6454 / --accent #b0392b）搬进 app.scss。
- `project.config.json` 填部署者自己的 appid。photos 域名后续在小程序后台配 downloadFile 合法域名。
- v1 拍照：Taro.chooseMedia + 上传 /api/cutout（云端=圆框/segfood）。插画生成、导出长图不进 v1。

## 验收线

1. 本地回归：launchd 服务重启后全部主接口 200，data/ 数据不动。
2. 存储对等：同一操作序列打在 文件模式 与 sqlite URL 模式 上，产出一致（脚本 scripts/test_storage_parity.py）。
3. 云镜像可构建可启动（无 rembg 环境 import 通过 + uvicorn 起得来）。
4. miniapp `npx taro build --type weapp` 编译通过。
