// 一箪食小程序的后端坐标（与 docs/r18-cloud-design.md 契约一致）

/** 微信云托管环境 ID */
export const CLOUD_ENV = "prod-d7g7gzmcm6b602bda";

/**
 * 云托管服务名：必须与微信云托管控制台里创建的服务名一致，
 * 否则 callContainer 会报「服务不存在」。契约约定为 yidanshi。
 */
export const SERVICE = "yidanshi";

/** h5 / 本地联调时直连本机 FastAPI 服务 */
export const LOCAL_BASE = "http://127.0.0.1:18100";

/**
 * 云托管服务的公网访问域名（可选）。
 * 控制台「服务设置 → 公网访问」开启后填入，形如：
 *   https://yidanshi-xxxxxx-<env>.ap-shanghai.run.tcloudbase.com
 * 配了之后：
 *   - 照片上传（/api/cutout）走 Taro.uploadFile —— 需在小程序后台把该域名
 *     加进「uploadFile 合法域名」；
 *   - 服务端返回的相对路径照片（/photos/…）也用它拼成完整地址（同时要把它
 *     加进「downloadFile 合法域名」）。云上照片若已入 COS，则字段本身就是
 *     完整 https URL，只需把 COS 域名配进 downloadFile 合法域名。
 * 不配时：上传退化为 callContainer 手工拼 multipart（免域名配置，但大图有
 * 请求体积风险，chooseMedia 已用 compressed 压过一道）。
 */
export const CLOUDRUN_HTTP_BASE = "https://yidanshi-284630-10-1456112658.sh.run.tcloudbase.com";
