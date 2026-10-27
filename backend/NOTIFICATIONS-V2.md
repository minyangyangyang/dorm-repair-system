# V2.0 站内消息通知

## 迁移与事务

迁移版本 3 新增 notifications，不修改原工单、评价、维修日志或状态机。
字段为 id、recipient_id、event_type、repair_order_id、source_log_id、title、content、created_at、read_at。
外键关联用户、工单和来源日志；UNIQUE(recipient_id,source_log_id) 防止同一来源事件给同一账号重复插入。
索引覆盖 (recipient_id,created_at DESC,id DESC)；另有 WHERE read_at IS NULL 的未读部分索引。

沿用原迁移事务、幂等版本记录，不重建旧表、不回放历史日志、不补发历史通知。
appendRepairLog 只增加一次通知派发调用；事务仍由原业务流程控制。
业务状态、维修日志及通知一同提交；通知写失败三者一起回滚。非法、重复、竞争失败的操作不产生新事件或通知。
无公开创建/删除通知 API；读取和已读全部限定当前会话用户，管理员也不能查看别人的消息。
固定文案仅包含数据库工单主键和事件结果，不存手机号、宿舍、故障描述、账号密码或会话信息。

## 触发规则

| 业务事件 | 接收用户 |
| --- | --- |
| 新工单提交 | 事件当时全部启用管理员 |
| 维修人员接单 | 工单所属学生 |
| 管理员派单 | 工单所属学生、新负责人 |
| 管理员改派 | 原负责人、新负责人 |
| 开始维修 | 工单所属学生 |
| 维修完成 | 工单所属学生，提示可以评价 |

仅向存在、启用且角色正确的账号发送；student_id 为 NULL 或不再是启用学生时不发学生通知。
改派撤销通知是原负责人应知的任务变更，不代表其仍能访问工单；点击后重新校验当前权限，通常返回 404。
学生不额外收到改派通知；维修人员自主接单不额外收到自身操作通知。
停用账号不收新通知；已存在通知保留，不在登录时补发之前错过的事件。

## API

均位于 /api/notifications，复用现有登录、凭据、CSRF/Origin 防护。

- GET /api/notifications?page=1&limit=20
  返回 data:{items,page,limit,has_more}，默认 20 条，limit 1–50，page 1–1000。
  按 created_at DESC,id DESC 排序，仅查询本人；忽略客户端指定的用户身份参数。
  items 字段为 id、event_type、repair_order_id、title、content、created_at、read_at。
- GET /api/notifications/unread-count
  返回 data:{count}，仅统计本人的 read_at IS NULL。
- PATCH /api/notifications/:id/read，JSON {}
  返回更新后的本人消息。COALESCE 保留第一次已读时间，重复调用幂等。
- PATCH /api/notifications/read-all，JSON {}
  返回 data:{updated}，只更新本人的未读消息；重复调用 updated 为 0。

成功仍为 {success:true,data:...}；未登录/停用/过期 401；非法参数 400；
不存在和他人消息统一 404；不可信来源/缺少防护头 403。不提供 POST 创建通知接口。

## 前端

Dashboard 增加所有角色共用的消息入口和未读角标，MessageCenter 显示本人消息、时间和已读状态。
支持手动刷新、分页、单条/全部已读、关联工单查看。不会因点击消息直接信任其工单访问权限。
关联工单重新 GET /repairs/:id，403/404 显示已改派或无权限的友好提示；成功后复用 RepairDetails 与时间轴。
刷新期间禁止对旧列表执行已读/打开操作，防止异步结果覆盖；退出或 401 时原 Dashboard 销毁，消息和角标清空。
请求层原有 AbortController、账号代数检查继续阻止晚到响应（包括旧消息、旧未读数）污染下一账号。
不使用 WebSocket、浏览器推送、localStorage 或定时器。角标在登录、页面导航、本人业务操作和消息操作时刷新；
其他账号产生的新消息需要用户打开/刷新消息中心才能获取，不承诺实时推送。

## 验证与联调

项目根目录：
```powershell
npm.cmd --prefix backend test
node --test frontend/test/client.test.js
npm.cmd --prefix frontend run build
node frontend/scripts/browser-smoke.mjs
```

全部使用系统临时目录数据库。浏览器脚本自动创建隔离数据库、临时浏览器配置和空闲端口，
通过 API_PROXY_TARGET 连接临时后端，并打印实际路径及端口；不连接正式库，结束关闭测试服务。
后端 43/43（原 34 项 + 通知 9 项）；前端请求 5/5；前端构建及无头 Chrome 8 组通过。
覆盖通知接收者、事务故障回滚、失败不通知、本人访问、幂等已读、分页稳定排序、历史无归属、旧版本升级、
不回放历史、账号切换旧响应、改派后链接拒绝、单条/全部已读角标和原三角色/时间轴流程。
故障注入日志 injected notification failure / injected log failure 属于预期测试。

正式库本轮保持未迁移；正常后端启动会自动应用目标 DB_PATH 的未执行迁移，请待明确确认并备份后再处理正式库。
后续数据量增大可增加游标分页及归档策略；当前无自动删除消息策略，也不做历史补发。
