# 微信小程序部署手册（R18 · 微信云托管）

面向自己的一步步实操手册。目标：把一箪食做成微信小程序，后端跑在**微信云托管**上，
只有你（扫码登录的那个微信号）能看到和管理自己的食单。

> **本地 Web 完全不受影响。** 云端是另起一套容器（FastAPI 同一份 `server/`），
> 你电脑上 launchd 跑的 `:18100` 本地服务照旧，`data/` 里的数据一个字节都不动。
> 云端的数据放在云托管的 MySQL 和 COS 里，两边各存各的。

设计契约细节见 [r18-cloud-design.md](r18-cloud-design.md)。整个流程大约 30–60 分钟，
第一次会慢一点，主要时间花在「开通云资源」和「等构建」。

---

## 0. 名词对照（先混个眼熟）

| 名词 | 是什么 |
|---|---|
| **AppID** | 小程序的身份证，`wx550675e89dfff867`（已填在 `miniapp/project.config.json`） |
| **云托管环境 ID** | 云资源的容器，`prod-d7g7gzmcm6b602bda`（已填在 `miniapp/src/config.ts` 的 `CLOUD_ENV`） |
| **服务名** | 云托管里那个跑后端的服务，**必须叫 `yidanshi`**（小程序按这个名字找后端） |
| **MySQL 插件** | 云托管自带的托管数据库，存菜谱/记录 |
| **COS** | 腾讯云对象存储，存照片 |
| **openid** | 微信给「你这个人 + 这个小程序」的唯一 ID，用来认出谁是主人 |

---

## 1. 前置清单：要准备的凭证 → 对应哪个环境变量

**下面所有值都不写进代码、不进 git**，而是部署时填进云托管的「环境变量」里。
本手册只列变量名和用途，不含任何真实值。

| 环境变量 | 用途 | 从哪拿 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 云端做 AI 整理菜谱（云上没有本机 claude/codex CLI，改走 DeepSeek） | <https://platform.deepseek.com> → API keys |
| `ALIYUN_AK_ID` | 阿里云 AccessKey ID，云端抠图（SegmentFood；rembg 不进云镜像） | <https://ram.console.aliyun.com> → AccessKey |
| `ALIYUN_AK_SECRET` | 阿里云 AccessKey Secret（同上，成对） | 同上，创建时给一次，务必存好 |
| `COS_SECRET_ID` | 腾讯云 API 密钥 ID，照片上传 COS | <https://console.cloud.tencent.com/cam/capi> |
| `COS_SECRET_KEY` | 腾讯云 API 密钥 Key（同上，成对） | 同上 |
| `COS_BUCKET` | COS 桶名，形如 `yidanshi-1300000000`（**含 appid 后缀**） | 建桶后在 COS 控制台看 |
| `COS_REGION` | COS 桶所在地域，形如 `ap-shanghai` | 建桶时选的地域 |
| `YIDANSHI_OWNER_OPENID` | 主人认证：只有 openid 等于它的人才是主人（**第 6 步拿到后再填**） | 部署后调 `/api/whoami` 得到 |

**平台自动注入、你不用管的：**

| 环境变量 | 说明 |
|---|---|
| `MYSQL_ADDRESS` / `MYSQL_USERNAME` / `MYSQL_PASSWORD` | 云托管开了 MySQL 插件后自动注入，后端据此连库（库名 `yidanshi`，不存在会自动建） |
| `PORT` | 云托管容器用 80，Dockerfile 已默认，不用填 |

> 阿里云那对 AK 想更稳妥可以用子账号 + 只授 `AliyunVIAPIFullAccess`；腾讯云同理只授 COS 相关权限。
> 不勉强，主账号 AK 也能用，但泄露风险大，别提交进任何仓库。

---

## 2. 先自检本地凭证（配一个测一个）

凭证配进 `data/secrets.env`（每行 `KEY=值`，`#` 开头是注释；这个文件 git 忽略，不会外泄），
然后跑自检脚本，逐项看通没通：

```bash
cd ~/Code/yidanshi
python3 scripts/cloud_preflight.py
```

输出示例（✓ 通 / ✗ 不通 / ⚠ 通了但要处理 / ⊝ 未配置跳过）：

```
 ✓ DeepSeek         key 有效，deepseek-v4-flash 可用
 ⚠ 阿里云 SegmentFood  AK 对，但没权限：Unauthorized
       去 RAM 给该 AK 的用户加 AliyunVIAPIFullAccess 授权，再重跑本检查
 ⊝ 腾讯云 COS          未配置 COS_SECRET_ID/KEY/REGION/BUCKET
 ⊝ MySQL            本地未配置（云上由平台注入，本地无需）
 ✓ 本地 Web           http://127.0.0.1:18100/api/recipes 200
```

- 这个脚本**只读探测，绝不上传/写/删任何云端资源，也绝不打印任何密钥值**。什么都没配也能干净跑完。
- **阿里云出现 ⚠ Unauthorized**：AK 本身是对的，但还没授权抠图服务——去
  [RAM 控制台](https://ram.console.aliyun.com) 给该 AK 所属用户加 `AliyunVIAPIFullAccess`，再重跑。
- **MySQL 本地显示 ⊝ 是正常的**：本地不连库，云上才由平台注入连接串。
- 目标：把要用的项都跑到 ✓（COS 要等第 3 步建好桶、把四个变量填进 `secrets.env` 后才会从 ⊝ 变 ✓）。

---

## 3. 开通云资源

### 3.1 开 MySQL 插件

1. 打开 [微信云托管控制台](https://cloud.weixin.qq.com/) → 选环境 `prod-d7g7gzmcm6b602bda`。
2. 左侧「数据库」→ 开通 MySQL（选最小规格即可，个人自用够）。
3. 开通后，它会**自动**给同环境的服务注入 `MYSQL_ADDRESS/MYSQL_USERNAME/MYSQL_PASSWORD`。
   你不用手抄这三个值，也不用建库——后端首次连接会自动建 `yidanshi` 库和三张表。

### 3.2 建 COS 桶并开公有读

1. 打开 [COS 控制台](https://console.cloud.tencent.com/cos) → 创建存储桶。
2. 桶名随意（会自动带 appid 后缀，如 `yidanshi-1300000000`），地域建议和云托管同区（如 `ap-shanghai`）。
3. **访问权限：设为「公有读私有写」**。照片链接要能被小程序直接 `downloadFile` 拉取，
   不开公有读的话，小程序里照片会 403 加载不出来。
4. 记下桶名 → `COS_BUCKET`，地域 → `COS_REGION`。
5. 密钥在 [访问管理 → API 密钥](https://console.cloud.tencent.com/cam/capi) 拿 → `COS_SECRET_ID` / `COS_SECRET_KEY`。

把这四个填进本地 `data/secrets.env`，再跑一次 `python3 scripts/cloud_preflight.py`，
COS 应从 ⊝ 变 ✓（403=密钥/权限问题，404=桶名或地域填错）。

---

## 4. 打包后端代码

云托管「本地代码」方式部署，需要一个 zip。**只打包已提交进 git 的内容**（`data/` 已被
git 忽略，所以密钥不会进包，正合适——密钥走第 5 步的环境变量）：

```bash
cd ~/Code/yidanshi
git archive -o ~/Desktop/yidanshi-deploy.zip HEAD
```

> **注意**：`git archive HEAD` 只打包**已 commit** 的代码。如果你改了后端还没提交，
> 先 `git commit` 再 archive，否则改动不会进包。桌面若已有 `yidanshi-deploy.zip`
> 且代码没再改过，可直接用。

---

## 5. 云托管建服务 + 部署

1. 云托管控制台 → 「服务管理」→ 新建服务，**服务名必须填 `yidanshi`**
   （和 `miniapp/src/config.ts` 里的 `SERVICE` 一致，否则小程序报「服务不存在」）。
2. 部署方式选「本地代码」→ 上传第 4 步的 `yidanshi-deploy.zip`。
3. 关键配置：
   - **监听端口**：`80`
   - **Dockerfile 路径**：`Dockerfile`（包根目录，已在仓库里）
   - **环境变量**：填下面 **7 个**（值从你的 `data/secrets.env` 抄过去；MySQL 三个不用填，平台自动注入）：
     ```
     DEEPSEEK_API_KEY
     ALIYUN_AK_ID
     ALIYUN_AK_SECRET
     COS_SECRET_ID
     COS_SECRET_KEY
     COS_BUCKET
     COS_REGION
     ```
     `YIDANSHI_OWNER_OPENID` 这一轮**先不填**（第 6 步拿到 openid 再加）。
4. 点部署，等构建（几分钟）。构建日志出现 `uvicorn running` 即起来了。

> 没填 `YIDANSHI_OWNER_OPENID` 时，后端不设主人门（谁都能调），这是**故意的**——
> 为的是让你下一步能顺利拿到自己的 openid。拿到并回填后，就只有你是主人了。

---

## 6. 部署后自检 + 拿 openid 锁定主人

### 6.1 临时开公网访问，验证后端活着

1. 云托管服务 → 「服务设置 → 公网访问」→ 开启，会得到一个临时域名，形如
   `https://yidanshi-xxxxxx-prod-xxx.ap-shanghai.run.tcloudbase.com`。
2. 浏览器或 curl 访问：
   ```bash
   curl https://<你的公网域名>/api/recipes   # 应返回菜谱 JSON 数组（哪怕是 [] 也算通）
   curl https://<你的公网域名>/api/whoami    # 直接访问没有微信身份，openid 为 null，正常
   ```
   `/api/recipes` 有响应 = 后端 + MySQL 通了。

### 6.2 拿到你自己的 openid

`/api/whoami` 只有**经小程序 `callContainer` 调用**时，云托管才会注入 `X-WX-OPENID`。
所以要在微信开发者工具里调它：

1. 先做完第 7 步（把小程序导入开发者工具、编译起来）。
2. 在开发者工具的「调试器 → Console」里执行：
   ```js
   wx.cloud.callContainer({
     config: { env: "prod-d7g7gzmcm6b602bda" },
     path: "/api/whoami",
     method: "GET",
     header: { "X-WX-SERVICE": "yidanshi" },
   }).then(r => console.log("我的 openid =", r.data.openid))
   ```
3. 控制台打印出的那串就是你的 openid，复制它。

### 6.3 回填并重新部署

1. 云托管服务 → 环境变量 → 新增 `YIDANSHI_OWNER_OPENID` = 上一步的 openid。
2. 重新部署（改环境变量需要重新发布才生效）。
3. 从此：只有你的微信号（openid 匹配）是主人，能读写菜谱/记录/设置；
   其他人调主人接口一律 401，只放行访客点菜链接。

> 验证锁定成功：换个没授权的场景调 `/api/recipes` 应返回 401「需要主人令牌」。

---

## 7. 微信开发者工具：编译小程序 + 真机预览

1. 编译前端产物：
   ```bash
   cd ~/Code/yidanshi/miniapp
   npm install
   npm run build:weapp      # 产物输出到 miniapp/dist/
   ```
2. 打开[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) →
   导入项目 → 目录选 **`~/Code/yidanshi/miniapp`**（`project.config.json` 已把
   `miniprogramRoot` 指向 `dist/`，AppID 也已填 `wx550675e89dfff867`）。
3. 工具里点「编译」，模拟器能跑起来后，点「预览」扫码上真机看。
4. 改了小程序代码后：重跑 `npm run build:weapp`，开发者工具会自动刷新
   （或用 `npm run dev:weapp` 开 watch 持续编译）。

### 7.1 小程序后台要配的合法域名

- **`callContainer` 方式（默认，免配域名）**：`miniapp/src/config.ts` 里 `CLOUDRUN_HTTP_BASE` 留空时，
  接口和上传都走 `wx.cloud.callContainer`，**不需要**在后台配 request/uploadFile 合法域名。
  照片只要入了 COS（COS 配齐时字段就是完整 https URL），只需把 **COS 桶域名**
  （`<桶名>.cos.<地域>.myqcloud.com`）加进小程序后台 →「开发管理 → 开发设置 →
  服务器域名 → downloadFile 合法域名」，照片才能显示。
- **如果你在 `config.ts` 填了 `CLOUDRUN_HTTP_BASE`（走公网域名直连）**：则把该云托管公网域名
  同时加进 request / uploadFile / downloadFile 三处合法域名。个人自用建议就用默认的
  callContainer 方式，少配域名少踩坑。

---

## 8. 常见坑排查表

| 症状 | 多半原因 | 怎么修 |
|---|---|---|
| 小程序里照片 403 / 加载不出来 | COS 桶没开公有读，或域名没进 downloadFile 合法域名 | 桶设「公有读私有写」；把 COS 桶域名加进 downloadFile 合法域名 |
| `callContainer` 报「服务不存在 / service not found」 | 云托管服务名不是 `yidanshi`，或环境 ID 不对 | 服务名必须 `yidanshi`；核对 `config.ts` 的 `CLOUD_ENV` |
| AI 整理菜谱报「没有可用的 AI 通道」 | 云端没填 `DEEPSEEK_API_KEY` | 环境变量补上，重新部署；本地自检 DeepSeek 要 ✓ |
| 抠图不工作，只出圆框直裁 | 阿里云没授权，或没填 `ALIYUN_AK_*` | 给 AK 加 `AliyunVIAPIFullAccess`；自检阿里云要 ✓（⚠=没授权） |
| 主接口一直 401 | `YIDANSHI_OWNER_OPENID` 填的不是你当前小程序的 openid | 重新用 6.2 的方法取一次 openid，核对后回填、重新部署 |
| 部署后 `/api/recipes` 500 | MySQL 插件没开，或连接串异常 | 确认 MySQL 插件已开通、和服务同环境；看构建/运行日志 |
| 谁都能改我的菜谱 | 还没填 `YIDANSHI_OWNER_OPENID`（无主人门） | 走完第 6 步回填并重新部署 |

---

## 9. 更新 / 回滚

**改了后端代码，重新上线：**

```bash
cd ~/Code/yidanshi
git commit -am "……"                              # 先提交
git archive -o ~/Desktop/yidanshi-deploy.zip HEAD  # 重新打包
# 云托管控制台 → yidanshi 服务 → 新建版本 → 上传新 zip → 部署
```

**回滚**：云托管每次部署是一个「版本」，控制台里选历史版本「重新部署」即可回到上一版。
数据在 MySQL/COS 里，回滚代码不影响已存的菜谱和照片。

**改了小程序前端**：`cd miniapp && npm run build:weapp`，开发者工具重新预览 / 上传体验版。

---

## 附：部署前最后核对

- [ ] `python3 scripts/cloud_preflight.py`：DeepSeek / 阿里云 / COS 该用的都 ✓
- [ ] 云托管 MySQL 插件已开、和服务同环境
- [ ] 服务名是 `yidanshi`，端口 80，7 个环境变量都填了
- [ ] 拿到 openid 并回填 `YIDANSHI_OWNER_OPENID`、重新部署过
- [ ] COS 桶公有读已开、桶域名进了 downloadFile 合法域名
- [ ] 真机预览：食单/记一餐/买菜/食历能翻，拍照能记录
