# 持久化维修时间轴

## 数据库增量迁移

迁移版本 2 新增 repair_logs，不改动 repair_orders / evaluations 的字段、主键、数据或状态机。
表字段：id、repair_order_id、event_type、actor_id、actor_display_name、actor_role、occurred_at、
from_status、to_status、from_worker_id、to_worker_id。
工单与用户字段带外键，事件与状态带 CHECK；索引为 (repair_order_id, occurred_at, id)。

事件类型：created（提交）、accepted（接单）、assigned（派单）、reassigned（改派）、
started（开始维修）、completed（维修完成）。操作者 ID、角色及显示名称从有效会话取得，摘要仅包含状态和负责人 ID。
不保存联系人、电话、宿舍、描述、密码或 Cookie；不接受客户端自定义日志、操作者或事件时间。

日志由后端追加；无日志写入/修改/删除 HTTP 接口。数据库触发器拒绝 UPDATE / DELETE。
显示名称保留事件时快照，账号后续改名不改写旧日志。账号停用保留历史。
这些约束不等于对有权限修改 SQLite 文件或删除触发器的运维人员防篡改。

迁移、索引、触发器、版本标记仍在现有迁移事务内；重复执行跳过已应用版本。
不回填旧工单，不根据 created_at / updated_at 猜测过去的操作或操作者。
本阶段未迁移真实数据库；未来正常启动会对目标 DB_PATH 自动应用尚未执行的版本，正式库需后续明确确认并先备份。

## 事务调整的原因及范围

原接单/维修状态更新虽然是原子的单条 UPDATE，但新增独立日志 INSERT 后必须把二者包在同一事务内。
仅增加同步 withRepairTransaction 短事务包装，保留原 nextStatus、旧状态/负责人/updated_at 条件及竞争失败 409。
提交工单同样把 INSERT 和创建日志合并提交。
管理员派单/改派直接在原事务 COMMIT 前追加日志，不增加嵌套事务。
日志写入失败使业务更新回滚；业务校验/竞争失败不追加日志。已有评价和账号逻辑不变。
事件 occurred_at 使用实际写入时的服务端 UTC 时间，不借用或推算旧 updated_at。

## 接口

GET /api/repairs/:id/timeline，id 仍为数据库主键，返回现有 success / data 格式：

```json
{
  "success": true,
  "data": {
    "redacted": false,
    "history_incomplete": false,
    "events": [
      {
        "id": 1,
        "event_type": "created",
        "occurred_at": "服务端实际 UTC ISO 时间",
        "actor": { "id": 1, "display_name": "事件时显示名称", "role": "student" },
        "summary": { "from_status": null, "to_status": "待处理", "from_worker_id": null, "to_worker_id": null }
      }
    ]
  }
}
```

复用 requireSession 和 visibleOrder；未登录 401、非法主键 400、无权访问私有工单 404。
权限判断与日志读取在同一只读快照内进行。
学生仅本人，维修人员仅本人负责；管理员包括历史工单。
维修人员可见的未分配待处理工单仅返回：
```json
{ "success": true, "data": { "events": [], "redacted": true, "history_incomplete": null } }
```
不查询其日志、不返回操作者、计数、摘要或完整性信息，避免绕过接单前隐私隐藏。

完整时间轴按 occurred_at ASC, id ASC 稳定排序。
没有 created 事件即 history_incomplete:true，包括完全无日志和只记录了上线后操作的历史工单。

## 前端行为

RepairDetails 中增加独立 RepairTimeline，只有有权查看基本详情后才加载。
实际事件展示名称、浏览器本地时间（精确到秒）和操作者显示名称，派改事件另显示负责人 ID。
步骤按日志证据显示“已记录”；未来未发生步骤显示“未完成”，无时间；
已达到状态但缺少对应日志显示“缺少记录”，不得把历史缺失误标成未完成。
历史显示“不完整”说明；没有事件显示“暂无可核实的操作日志”。
时间轴失败单独提示/重试，不阻塞基本详情；关闭详情或账号切换后丢弃过期响应。
现有详情字段及其他 API 映射不变。

## 验证

项目根目录执行：
```powershell
npm.cmd --prefix backend test
node --test frontend/test/client.test.js
npm.cmd --prefix frontend run build
node frontend/scripts/browser-smoke.mjs
```

测试及浏览器脚本只使用系统临时目录 SQLite 文件，不连接真实库。
后端 34 项测试通过（原 26 项 + 新 8 项），包含所有事件、竞争/失败不记日志、六类日志故障回滚、
持久化、排序、权限、公共池隐私、只追加约束、旧版升级、重复迁移和历史保留。
故障注入测试出现 injected log failure / no such table 日志属于预期断言。
前端原有 4 项请求测试和构建通过。无头 Chrome 原 7 组流程继续通过，增加新/历史时间轴、
完整维修轨迹、时间轴单独 503 失败及重试、移动端溢出检查。

仍需注意：日志依赖服务器时钟；正式迁移需先确认和一致性备份；本阶段不导入、认领或重构历史记录。
