# V2.0 阶段 1C：后端角色权限与派单

## 当前范围

在现有 Express / SQLite / Cookie 会话上接入权限，不修改前端、不执行真实库迁移。
/api/auth/register、login 和 /api/health 公开；logout 保持幂等；其余业务路由统一 requireSession。
无会话、过期、停用为 401；角色禁止为 403；私有资源越权读取/更新为 404；状态或版本竞争为 409。
所有 /api 响应 no-store；凭据 CORS 仅允许 AUTH_ALLOWED_ORIGINS 的精确信任源。
OPTIONS 仅执行浏览器预检，不返回业务数据。

## 角色范围

| 操作 | 学生 | 维修人员 | 管理员 |
| --- | --- | --- | --- |
| 创建报修 | 仅本人，服务端填写 student_id | 禁止 | 禁止 |
| 工单列表/详情 | 仅本人 | 未分配待处理 + 本人负责 | 全部，含历史 |
| 统计 | 仅本人 | 仅本人负责，不含公共待接单池 | 全部 |
| 接单/推进维修 | 禁止 | 接单池接单，本人任务顺序推进 | 禁止直接推进 |
| 评价读取 | 本人已完成 | 禁止 | 可查看 |
| 评价提交 | 本人已完成且未评价 | 禁止 | 禁止 |
| 账号管理与派单 | 禁止 | 禁止 | 创建/查看/停用维修账号；派单/改派 |

列表、详情、评价所属工单、统计都在 SQL 中限制范围，不使用客户端传入身份或查询参数决定范围。
未分配工单只返回 id、order_no、category、status、created_at、updated_at、assigned_worker_id。
接单前不返回 building、room、description、contact_name、contact_phone、student_id；SQL 投影也不读取其值。
接单后仅当前负责人及学生所有者、管理员能查看完整工单。

## 现有 API 变化

- GET /api/repairs：原 data 数组及排序保留，改为角色范围；维修待接单行采用上述安全字段。
- POST /api/repairs：只允许学生。忽略客户端 student_id / assigned_worker_id / 状态 / 编号，归属从会话生成。
- GET /api/statistics：返回字段、零值分布、完成率算法保留，查询加角色条件。
- PATCH /api/repairs/:id/status：只允许维修人员，body 仍为 {status}。
  status=已接单 等价于原子接单；其余状态只允许本人任务合法下一步。
- GET /api/repairs/:id/evaluation：学生仅能访问本人已完成工单（未完成返回 409），管理员可读取，维修人员 403。
- POST /api/repairs/:id/evaluation：只允许学生本人已完成工单；评分、文本长度、唯一评价规则保留。

编号映射不变：URL 的 :id 是数据库整数主键；页面展示编号仍是 order_no。
认证 API 和公开学生注册角色限制保持不变。

## 新增 API

### GET /api/repairs/:id
返回 {success:true,data:order}，与列表采用同一范围和个人信息隐藏规则。

### POST /api/repairs/:id/accept
维修人员接单，发送 JSON {}。单条条件 UPDATE 同时修改待处理→已接单、assigned_worker_id、updated_at。
WHERE 校验未分配、旧状态和旧更新时间，RETURNING 返回同一次更新结果。
**接单是竞争操作：不可用的目标统一 409，包含已被接单、重复接单和不存在的目标，不区分是否属于别人，也不返回其信息。**
GET 私有工单、普通维修状态推进仍返回 404。PATCH status=已接单 使用相同规则。

### GET /api/admin/workers
管理员查看维修账号，包含停用账号，仅返回 id、username、display_name、role、is_active、created_at。

### POST /api/admin/workers
管理员创建维修账号。JSON {username,password,display_name}；role 可省略或只能为 worker。
沿用账号输入验证和异步 scrypt 独立盐，不返回密码或哈希。重名 409，非法输入/角色 400。
哈希结束后重新验证管理员会话，最多同时处理两个创建请求。

### PATCH /api/admin/workers/:id
仅支持 JSON {is_active:0}，停用维修账号；不能操作学生或管理员。
更新账号和删除其所有会话在同一事务中执行；重复停用幂等成功。
不自动改派、回退或删除其任务。停用前应处理已接单任务；维修中任务后续需明确恢复策略，本阶段不突破禁止改派规则。

### PATCH /api/repairs/:id/assignment
管理员派单，JSON 示例结构：
```json
{
  "assigned_worker_id": 7,
  "expected_status": "待处理",
  "expected_assigned_worker_id": null,
  "expected_updated_at": "读取到的 updated_at"
}
```
前三个字段必填；expected_updated_at 可选，前端应总是提交，防止负责人变更又恢复后的旧快照覆盖。
从详情/列表取得当前快照后再提交；不接受仅传新负责人进行盲目覆盖。
目标必须是启用的 worker。待处理且未分配→已接单并绑定；已接单可改派但状态不变；同一负责人重复指派、维修中、已完成或旧快照不匹配均 409。
BEGIN IMMEDIATE 内校验旧状态、负责人、目标启用状态，再用状态+负责人+更新时间条件 UPDATE。
竞争派单不会隐式变成改派；失败不改变时间或任务。

## 历史数据和迁移

本阶段无新增数据库迁移。沿用 1B 可空归属字段；真实库未迁移。
不认领、不根据手机号/姓名/宿舍回填学生，不重建工单/评价表。
管理员可查看、分配历史待处理工单；历史维修中且无负责人的任务保持原状，不回退或强行改派。
历史已完成工单、评价的所有字段和主键保持不变。

## 前端接入要求

本阶段未修改 frontend；旧前端尚无登录，直接调用业务接口将收到 401，这是权限接入的必要变化。
所有请求需 credentials:'include'；所有写方法需 JSON、可信 Origin 和 X-Auth-Request:1。
Origin 由浏览器生成，前端不要尝试手工设置；开发时 localhost 与 127.0.0.1 应保持一致。
后端精确信任源、Cookie HttpOnly / SameSite=Lax / Path=/api 保留；生产 HTTPS、Secure 和配置要求保留。
维修任务区分接单池与本人任务；接单池缺少隐私字段，应显示接单后可见，不能把缺失字段视为接口故障。
学生未完成工单不请求评价；退出或 401 时清理工单、详情、评价和统计缓存。
409 应刷新工单再决定下一步；改派提交快照字段。
下一阶段再实现登录界面、角色导航和管理员管理界面；前端隐藏按钮不能代替后端授权。

## 测试

backend 目录运行 npm.cmd test。所有写入均在系统临时数据库中，测试真实登录账号，不通过放宽权限兼容旧测试。
保留原状态组合、非法输入、评分/文本约束、重复评价、重启持久化、统计异常回滚测试，补充角色矩阵、SQL 限制、隐私、抢单、派单、改派、停用会话、历史与 CSRF。
真实数据库及辅助文件由测试指纹检查；服务或管理员脚本不能指向正式数据库，直到下一阶段确认。
