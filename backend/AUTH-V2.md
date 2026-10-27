# V2.0 阶段 1B：迁移与账号认证

本文记录阶段 1B 认证实现。阶段 1C 已统一接入业务权限，现行接口与角色规则请同时阅读 PERMISSIONS-V2.md。前端尚未接入登录。

## 数据库与迁移

新增 users、sessions、schema_migrations，repair_orders 增加可空 student_id / assigned_worker_id 外键。
历史归属保持 NULL，不根据联系人或电话回填；原工单、评价、主键、序列及状态规则保留。
唯一用户名（大小写不敏感）和会话摘要主键自带索引，另有归属、负责人/状态、会话用户及过期索引。

openDatabase 完成原 V1 建表后调用 migrateDatabase。V2 DDL、ALTER TABLE、索引及版本记录全部在 BEGIN IMMEDIATE 事务内执行，异常全部回滚；无非事务化的 V2 操作。
原 V1 CREATE TABLE IF NOT EXISTS 初始化仍位于 V2 事务之前，以保持原逻辑。重复调用按版本跳过，字段增加前再检查 table_info。
迁移失败立即关闭连接并阻止服务启动，不继续使用半迁移结构。

**普通服务下次启动会迁移其 DB_PATH。当前阶段不要对正式库启动服务或运行管理员初始化。**
先在独立路径验证，下一阶段确认并备份正式库（有 WAL 时需一致性备份）后再执行。
不提供自动回滚到旧结构；失败事务回滚，成功后的应急恢复使用已验证备份。

## 配置与 API

- AUTH_ALLOWED_ORIGINS：逗号分隔的精确信任源，禁止通配符、路径、末尾斜线。
- 开发默认信任 localhost / 127.0.0.1 的 5173、3000 端口。使用其他端口需显式配置。
- NODE_ENV=production 时必须显式配置 HTTPS 来源；Cookie 自动加 Secure。生产必须由 HTTPS 提供服务。
- 不信任 X-Forwarded-For，限流使用实际连接 IP。反向代理接入需下一阶段明确可信代理，不能直接打开 trust proxy。
- 阶段 1C 起所有 /api 路由统一使用可信源凭据 CORS，移除业务接口的通配符来源。

POST /api/auth/register、/login、/logout 必须同时携带：
1. Origin：配置的精确信任源；缺失、null、恶意源拒绝。
2. X-Auth-Request: 1；跨源浏览器请求需通过预检。
3. Content-Type: application/json。
浏览器明确报告 Sec-Fetch-Site: cross-site 时也拒绝。可信源必须是自己控制的前端，不包含不可信网站。
以上用于包括登录和退出在内的 CSRF/Origin 防护，不能只靠 SameSite。

跨源前端 fetch 还需 credentials: 'include'，以收发 HttpOnly Cookie。本阶段未修改前端。
Cookie 名 dorm_session，HttpOnly、SameSite=Lax、Path=/api，8 小时固定有效期；生产 Secure。
Cookie Path 已覆盖 /api，供下一阶段业务接口鉴权使用；目前仍仅认证接口读取会话。
认证响应 Cache-Control: no-store。会话在 SQLite 持久化，每次 /me 检查过期、当前用户及启用状态。

- POST /api/auth/register：{ username, password, display_name }，成功 201；不自动登录。
  role 可省略或为 student，其他角色请求返回 400。忽略其他非白名单字段。
- POST /api/auth/login：{ username, password }，成功 200，设置 Cookie；错误/停用统一 401。
- GET /api/auth/me：成功返回白名单用户字段；无效或过期会话 401。
- POST /api/auth/logout：JSON 对象（可为空），删除服务端会话并清除 Cookie；未登录重复调用仍成功。
- API 保持 success / message / data 风格。非法输入 400，重复用户名 409，来源失败 403，限流 429。

用户名 trim 后转小写，3–32 位 ASCII 字母数字、下划线、点、短横线，首位须字母数字。
显示名称 trim 后 1–50 字符，不含控制字符。密码不裁剪，12–128 个 JS 字符，最多 512 UTF-8 字节，不能全为空白。
密码采用异步 crypto.scrypt（N=131072,r=8,p=1,64 字节派生值），16 字节独立随机盐，保存版本参数，timingSafeEqual 验证。
会话令牌 32 字节随机值，SQLite 仅存 SHA-256 摘要；密码绝不使用直接 SHA-256。
登录轮换当前有效会话，退出删除摘要；过期记录在成功登录时清理。
注册每 IP 每 15 分钟 5 次，登录 10 次，均包括失败请求；两者独立计数。最多同时处理 2 个密码请求，超出 429。
限流为单进程内存实现，重启会重置，不适用于未来多实例部署。

## 本地管理员初始化

从 backend 目录执行（先将 DB_PATH 设为独立测试库）：

```powershell
$env:DB_PATH = Join-Path $env:TEMP 'dorm-admin-sandbox.sqlite'
node scripts/init-admin.js
```

交互输入用户名、显示名称和两次密码，密码不回显。不要把密码写入命令、源码、脚本文件或日志。
自动化可使用 --stdin，从私有标准输入管道提供账号 JSON；不要把真实密码写进命令行文本、命令历史或仓库。
脚本不接受密码命令行参数、不读取硬编码密码，不在服务启动时执行。
DB_PATH 未设置时目标为正式 backend/data/repairs.sqlite，因此**当前阶段仅使用独立路径**。
已有任何管理员（含停用管理员）或同名账号时拒绝创建，不覆盖密码、不重新启用账号。
不提供 HTTP 管理员注册。脚本错误输出固定文案，不回显输入或数据库错误详情。

## 验证及下一阶段

从 backend 执行 npm.cmd test；仅使用系统临时目录数据库，测试检查正式库及其辅助文件指纹。
测试覆盖迁移重复执行、DDL 失败回滚、旧字段/评价/序列保留、认证、并发重复注册、限流、来源校验、管理员脚本和 V1 回归。

下一阶段：统一使用 readSession；后端验证角色和归属；限制原业务 API、统计和评价读取；
新工单归属必须取服务端账号；维修接单同时条件更新负责人和状态。外键仅保证用户存在，学生/维修角色由业务层检查。
完成前端接入时清理跨账号缓存。未来密码重置应撤销用户全部会话；管理员恢复使用单独受控流程。
