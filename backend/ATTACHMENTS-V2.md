# V2.0 故障照片附件

## 最小实现与接口

工单仍先以原 JSON API 创建；成功后单独 POST /api/repairs/:id/attachments。
没有引入 multipart 依赖：沿用现有 Cookie、JSON、Origin 和 X-Auth-Request:1 防护。
附件请求为 {files:[{mime:"image/png",data:"标准 base64"}]}，每次 1–3 张。
请求本身最大 21MiB（包括 base64 的约 1/3 传输膨胀），单张解码后最大 5MiB。
仅该附件路由使用大请求限制；原业务 JSON 仍限 32KB。认证和归属检查发生在大请求体解析之前。

- POST /api/repairs/:id/attachments：仅当前工单所属学生可上传，201 返回本批元数据。
- GET /api/repairs/:id/attachments：返回 [{id,repair_order_id,mime_type,byte_size,created_at}]。
- GET /api/repairs/:id/attachments/:attachmentId/content：受保护二进制响应。
- 学生仅本人；管理员全部；维修人员仅当前负责。待接单池不能读取图片或图片列表。
- 工单 ID 使用数据库主键，沿用现有权限逻辑；跨工单套用附件 ID 返回 404。
- 未登录 401，角色禁止上传 403，私有工单/图片不存在 404，非法格式 400，超大 413，超过每单 3 张 409。
- 不提供公开静态上传目录或绕过权限的图片地址。

前端以 credentials:include 获取图片 Blob 后生成本地对象 URL，不把 Cookie 或照片写入 localStorage。
下载设置真实 Content-Type、nosniff、private/no-store、受限 CSP 和固定安全内联文件名。
图片响应禁止共享缓存；每次重新下载都重新检查当前会话与工单权限。

## 本地存储和迁移

版本 4 新增 repair_attachments：
id、repair_order_id、uploader_id、storage_name、mime_type、byte_size、created_at。
只保存元数据，二进制保存在本地。每单索引和数据库插入触发器保护最多 3 张，重复及并发上传不会超额。
原工单、评价、时间轴、通知不改变；旧工单附件列表为空，详情正常提示未上传。

默认目录为 backend/uploads（已加入 backend/.gitignore）。
UPLOAD_DIR 可指定绝对路径；推荐放在 Git 工作区之外。若自定义到工作区内，需同时配置对应忽略规则。
目录在实际上传时才创建，不在普通读取或测试初始化时创建。不会静态公开。
文件名由 16 随机字节和检测所得扩展名构成，客户端原文件名不参与路径或元数据。
使用 wx 排他创建，避免覆盖；目录由部署账号控制，不应允许不可信本地账号写入或放置链接。

检查 JPEG 帧/扫描标记、PNG 签名与 IHDR/IDAT/IEND 块边界、WebP RIFF/VP8/VP8L/VP8X/动画帧结构，
不相信扩展名或客户端 MIME；声明类型与检测类型冲突也拒绝。
SVG、HTML、脚本、截断头部等不通过。额外限制单边 20000、总像素 4000 万，避免极端尺寸资源消耗。
这是格式特征/结构检查，不是完整图像解码、转码或病毒扫描。
参考：[PNG 结构规范](https://www.w3.org/TR/png/)、[WebP 容器规范](https://developers.google.com/speed/webp/docs/riff_container)。

## 文件与数据库一致性

在 BEGIN IMMEDIATE 内检查总数、排他创建本批文件、写入/fsync、插入元数据，成功后提交。
可捕获的写入或 SQL 失败会回滚元数据，并只删除本请求已创建的文件，不删除原有照片或工单。
数据库成功提交后即使 HTTP 响应异常，也保留已关联文件。
该同步流程批量最多 15MiB，避免跨异步等待持有 SQLite 写锁；大规模使用可另行改为流式存储。

SQLite 与文件系统无法实现完全原子提交。进程被强制终止、断电、磁盘故障时可能留下未关联文件，
或者出现数据库/磁盘备份时间不一致；自动清理也可能因磁盘权限失败。
未自动扫描或删除真实目录。运维应同时备份数据库和照片，异常恢复时先备份再对照 storage_name 人工核查孤立文件。
不得用清空上传目录的方式修复。原数据库和历史数据本阶段未迁移。

## 前端结果与资源生命周期

ImagePicker 支持选填、预览和移除。RepairPhotos 独立加载，可重试，支持点击查看大图。
照片加载失败不阻断原详情、评价、时间轴等组件。
工单成功/图片失败明确分别提示；保留重试入口，不重复创建工单。
若上传结果因网络超时未确认，重试前先检查已有附件；已有照片时提示人工核对，避免盲目重复上传。
可选择保留工单并结束本次照片上传。
预览移除、详情关闭、组件销毁、退出时撤销对象 URL。编码和下载均复用账号代数检查，丢弃旧账号异步结果。

## 测试与临时联调

项目根目录：
```powershell
npm.cmd --prefix backend test
node --test frontend/test/client.test.js
npm.cmd --prefix frontend run build
node frontend/scripts/browser-smoke.mjs
```

浏览器脚本显式传入临时数据库和同一临时工作目录下的 uploads，输出实际路径/端口并自动关闭服务。
后端测试同样传入独立 directory，未使用默认或真实上传目录。
小型 PNG/JPEG/WebP 固定测试样本保存在 backend/test-support/photos.json；运行测试不需要 Pillow 或新依赖。

验证结果：后端 49/49；前端请求 7/7；构建通过；Chrome 9 组联调通过。
包含三种格式、动画 WebP 结构、无照片、恶意内容/MIME/大小、3 张总量与并发、学生/维修/管理员权限、
文件清理、原工单/评价/日志/通知保留，以及上传失败恢复、大图、375px 无溢出和退出 URL 清理。
injected attachment failure / browser attachment failure 是临时库内预期故障注入。

人工仍建议检查：真实手机大照片/旋转方向和不同浏览器、生产 HTTPS 与反向代理请求体/超时限制、
上传目录权限/磁盘配额/联合备份恢复。本版本不压缩重编码、不移除 EXIF，照片原有元数据会保留。
