# V2.0 阶段 1D：前端登录与三角色界面

## 使用与安全

前端请求统一使用相对 /api、credentials:include。写请求自动添加 JSON Content-Type 和 X-Auth-Request:1，Origin 由浏览器生成。
开发代理默认指向 http://localhost:3000，保留原 Origin。前后端主机名保持一致；默认开发地址使用 http://localhost:5173。
如改前端端口或主机，应同步设置后端 AUTH_ALLOWED_ORIGINS。生产需同源反向代理 /api；Vite 开发代理不包含在构建产物中。
生产 HTTPS、Secure Cookie 及可信源配置仍按 backend/AUTH-V2.md 执行。

不使用 localStorage/sessionStorage 保存账号、密码或会话。Cookie 由后端设置且 HttpOnly。
启动 /auth/me 恢复会话；401 清理身份并返回登录；错误密码 401 留在登录表单显示错误。
退出先销毁角色页面，再撤销会话。请求层使用 AbortController 和递增代数丢弃旧响应（包括晚到 401、响应体解析中切换账号）。
退出请求失败会提示重试退出，不能宣称服务端已成功撤销。

## 角色功能

- 学生：仅注册学生账号；提交报修、本人列表/详情/评价/统计。未完成不请求评价。
- 维修：分为待接单和我的维修任务。待接单不渲染宿舍、联系人、描述、详情；POST /repairs/:id/accept 接单后刷新，任务按已接单→维修中→已完成推进。
- 管理员：全部工单含历史归属标识；查看全量统计、只读评价；创建/查看/确认停用维修账号。
  派单/改派仅在待处理或已接单工单出现，选择启用且不同于当前负责人的账号。
  提交 assigned_worker_id、expected_status、expected_assigned_worker_id、expected_updated_at，冲突后刷新。
- 403 显示角色权限提示；404 提示并刷新工单；409 提示变化并刷新，不自动重试写入。
- 复用 RepairDetails、EvaluationPanel、StatisticsPage。保留原 CSS，仅追加认证和管理员布局规则。

## 使用独立数据库手工联调

以下在项目根目录 PowerShell 执行。不要直接运行未指定 DB_PATH 的后端。

```powershell
$env:DB_PATH = Join-Path ([System.IO.Path]::GetTempPath()) ('dorm-v2-' + [guid]::NewGuid().ToString() + '.sqlite')
$env:AUTH_ALLOWED_ORIGINS = 'http://localhost:5173'
node backend/scripts/init-admin.js
node backend/src/server.js
```

管理员脚本交互输入账号与密码，不要把真实密码写进命令历史。
另外开一个终端运行：
```powershell
npm.cmd --prefix frontend run dev
```
访问 http://localhost:5173。首次启动只会迁移上述新建临时库，管理员由脚本创建；不会处理正式库。
如果 3000/5173 已有服务，请使用其他测试端口并同步配置 PORT、API_PROXY_TARGET、AUTH_ALLOWED_ORIGINS，不要停止已有未知服务。

## 自动验证

项目根目录执行：
```powershell
node --test frontend/test/client.test.js
npm.cmd --prefix frontend run build
npm.cmd --prefix backend test
node frontend/scripts/browser-smoke.mjs
```

浏览器脚本无需 Playwright，使用已安装 Chrome（或 Edge）和 Node 内置 DevTools WebSocket。
脚本自动创建独立临时库、随机测试密码、临时浏览器配置和空闲端口，直接以临时库实例启动后端与 Vite；
输出实际数据库/端口和移动截图路径，结束时关闭测试服务，并比较正式库及辅助文件指纹。
不要把测试数据当作正式账号；脚本不输出密码、Cookie 或密钥。

本阶段验证：前端构建成功；请求测试 4/4；后端 26/26；真实无头 Chrome 联调 7 组通过。
浏览器覆盖三角色正常流程、学生隔离、接单隐私、改派快照、状态更新、评价统计、确认停用、刷新恢复、
退出清理、401/403/404/409 提示及 375px 横向溢出检查。
403/404/409 使用临时库内的受控竞争/权限变化制造，不改变后端权限规则。
请求测试额外验证晚到成功响应、晚到 401 和响应体解析期间切换账号都不会重新展示旧数据。

仍建议人工验证：真实手机和不同浏览器、键盘/读屏体验，以及生产 HTTPS、反向代理与 Cookie 配置。
当前正式数据库仍未迁移；本阶段未修改后端权限、迁移，也未使用正式库联调。
