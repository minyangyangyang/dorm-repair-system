# 宿舍报修管理系统后端

提供工单查询、创建和状态更新接口，前端已接入这些接口。使用 Express、CORS 和 Node.js 内置 SQLite，要求 Node.js 24.4 或更新版本（当前开发环境为 24.4.1）。内置 SQLite 在此版本可能显示 ExperimentalWarning，不影响本项目的正常启动。

## 启动

在项目根目录打开 PowerShell：

```powershell
cd backend
npm.cmd install
npm.cmd start
```

默认地址为 `http://localhost:3000`，按 Ctrl+C 停止。开发时可使用 `npm.cmd run dev` 自动重启。如果端口被占用，可先执行 `$env:PORT = '3001'` 再启动。服务器启动时自动创建 `data/repairs.sqlite` 和 `repair_orders` 表，不需要单独安装或启动 SQLite 服务。数据库路径不随终端工作目录变化。

数据库、依赖目录均由 backend/.gitignore 忽略，不提交 Git。数据库文件仍会保留在电脑上；重启不会清空工单。没有预置业务工单，自动测试会写入一条明确标注的测试工单。

## API

成功响应使用 `success: true`；工单放在 `data` 中。失败响应使用 `success: false` 和中文 `message`。

### GET /api/health

浏览器打开 `http://localhost:3000/api/health`，正常返回：

```json
{ "success": true, "message": "宿舍报修系统后端运行正常" }
```

### GET /api/repairs

浏览器打开 `http://localhost:3000/api/repairs`。返回所有工单，按数据库 id 倒序排列，空列表为 `{ "success": true, "data": [] }`。

### POST /api/repairs

在 Postman 或类似工具中选择 POST，地址 `http://localhost:3000/api/repairs`，Body 选择 raw / JSON，填写：

```json
{
  "building": "3号楼",
  "room": "302",
  "category": "水电",
  "description": "卫生间水龙头漏水，请安排检查。",
  "contact_name": "演示同学",
  "contact_phone": "13800000000"
}
```

也可以在另一个 PowerShell 终端执行：

```powershell
$repair = @{
  building = '3号楼'
  room = '302'
  category = '水电'
  description = '卫生间水龙头漏水，请安排检查。'
  contact_name = '演示同学'
  contact_phone = '13800000000'
} | ConvertTo-Json
Invoke-RestMethod -Uri 'http://localhost:3000/api/repairs' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($repair))
```

六项都必须是非空文本（纯空格也会被拒绝），描述最多 500 字，其余字段最多 50 字。故障类别只接受水电、家具、网络、门窗、其他；联系电话接受 11 位大陆手机号码。

编号、主键、状态和时间均由服务器控制，客户端传入同名字段会被忽略。新工单固定为“待处理”。编号由 UTC 日期和 UUID 组成，表上的 UNIQUE 约束保证不会保存重复编号。时间采用 UTC ISO 8601 格式（末尾 Z），后续前端联调时可转换为本地显示时间。

HTTP 状态：成功查询 200，成功创建 201，非法字段或 JSON 400，非 JSON 请求 415，请求过大 413，未知接口 404，内部错误 500。状态更新接口见下文。

## 数据表 repair_orders

### PATCH /api/repairs/:id/status

`:id` 使用数据库整数主键（不是 BX 开头的报修编号）。JSON 请求示例：`{ "status": "已接单" }`。

后端只允许待处理 → 已接单 → 维修中 → 已完成逐步流转。成功返回 200 和完整工单，并更新 `updated_at`。非法状态名称返回 400；不存在的工单返回 404；跳级、回退、重复设置或操作已完成工单返回 409。规则位于 `src/app.js` 的 `nextStatus` 和 PATCH 路由中，UPDATE 同时匹配旧状态，防止并发覆盖。

使用 Postman 创建一条工单，记下返回的 `data.id`，向 `http://localhost:3000/api/repairs/该id/status` 依次 PATCH 已接单、维修中、已完成。刷新页面或重启后端后 GET，状态应仍然为已完成。再次 PATCH 待处理或已完成，应返回 409；发送未知状态应返回 400；使用不存在的正整数 id 应返回 404。

自动测试还覆盖全部状态组合、更新时间、非法操作不改变数据库、并发重复操作及完成后的重启持久化。

| 字段 | 类型及约束 | 用途 |
| --- | --- | --- |
| id | INTEGER PRIMARY KEY AUTOINCREMENT | 数据库主键 |
| order_no | TEXT NOT NULL UNIQUE | 报修编号 |
| building | TEXT NOT NULL，不能为空 | 宿舍楼 |
| room | TEXT NOT NULL，不能为空 | 房间号 |
| category | TEXT NOT NULL，限定五种类别 | 故障类别 |
| description | TEXT NOT NULL，不能为空 | 问题描述 |
| contact_name | TEXT NOT NULL，不能为空 | 联系人 |
| contact_phone | TEXT NOT NULL，不能为空 | 联系电话 |
| status | TEXT NOT NULL，默认待处理，限定四种状态 | 当前状态 |
| created_at | TEXT NOT NULL | 提交时间 |
| updated_at | TEXT NOT NULL | 更新时间 |

四种状态为待处理、已接单、维修中、已完成。所有字段都有 NOT NULL 约束，业务字段还经过 API 校验。使用参数化 SQL，将用户输入作为数据处理。

## 自动测试及人工检查

```powershell
npm.cmd test
```

测试会在 3107 端口启动真实后端，使用实际 `data/repairs.sqlite`。检查自动建库建表、健康检查、CORS、非法输入拒绝、创建、读取、重启后保留及数据库约束。每次运行会保留两条测试工单，不会清除现有记录；请确保 3107 端口空闲。

人工测试时先查 health，再 POST 正常工单，记录返回的编号，再 GET 列表。停止并重启后再次 GET，确认编号仍然存在。把 description 改为空字符串或纯空格，再 POST 应收到 400 和中文提示，列表记录数量不增加。

## 文件用途

- `src/server.js`：启动服务、输出提示、处理端口错误和正常停止。
- `src/database.js`：确定数据库路径、自动建目录和表。
- `src/app.js`：JSON、CORS、三个 API、字段校验和错误响应。
- `test/api.test.js`：真实服务器和数据库的集成测试。
- `package.json` / `package-lock.json`：命令、依赖和安装版本。
- `.gitignore`：忽略数据库、依赖和日志。
- `data/repairs.sqlite`：运行时自动生成的持久化数据库。

技术参考：[Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)、[Express CORS 文档](https://expressjs.com/en/resources/middleware/cors/)。
