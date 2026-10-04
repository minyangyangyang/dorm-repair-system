# 宿舍报修管理系统前端

使用 Vue 3 + Vite，包含学生端和维修人员端演示身份切换。当前工单读取和学生提交已接入 Express + SQLite；维修状态操作仍只保存在当前页面，刷新后恢复数据库中的状态。

## 启动

在项目根目录打开两个 PowerShell 终端：

后端：

```powershell
cd backend
npm.cmd install
npm.cmd start
```

前端：

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

后端需要位于 `http://localhost:3000`。前端打开 Vite 在终端显示的地址，通常是 `http://localhost:5173`。已经安装依赖时可跳过 install。

## 数据流程和代码位置

- `src/api/repairs.js` 使用原生 fetch，GET 获取工单，POST 提交六项表单字段，检查响应并转换后端字段。
- `src/App.vue` 的 `onMounted(loadRepairs)` 在页面首次加载及刷新后获取真实记录。两种身份共用 `records`，不再使用预置模拟工单。
- `submit()` 保留前端校验，调用 `createRepair()`，成功后将后端返回的工单放入列表顶部并跳转到“我的报修”。失败时保留表单内容。
- `order_no` 映射为页面显示的 `id`，数据库主键另外存为 `databaseId`；`contact_name`、`contact_phone` 映射为 `contact`、`phone`；`created_at` 转换为浏览器本地时间。
- 查询失败显示中文错误和“重新读取”按钮；提交时禁用表单和提交按钮，避免重复点击。超时设置为 10 秒，不会自动重试 POST。

## 人工测试

1. 同时启动后端和前端，学生进入“我的报修”，确认显示 SQLite 中已有的工单。
2. 提交空表单和错误手机号，确认被阻止。
3. 填写有效内容，提交后确认显示中文成功提示、新编号和“待处理”。
4. 刷新浏览器，重新进入“我的报修”，确认新编号仍然存在。
5. 切换维修人员，进入“维修工单”，确认同一编号、联系人和电话均正确，状态和类别筛选可用。
6. 停止后端并刷新浏览器，确认出现读取失败提示；进入提交页面尝试提交，确认出现提交失败提示且填写内容保留。
7. 重启后端，点击“重新读取”，确认恢复显示。

构建检查：`npm.cmd run build`。本阶段没有状态更新 API、登录或按用户划分工单；演示身份均查看同一份数据库工单。
