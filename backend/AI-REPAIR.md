# V2.0 AI 智能报修助手

## 范围

只在学生报修表单中按需分析故障描述，不创建工单、不修改状态、不派单、不写数据库。
合法类别直接复用 repair-categories.js，与原值完全相同：水电、家具、网络、门窗、其他。
学生手动点击采用推荐类别才修改表单类别，随时可以忽略或继续手动选择。
分析失败不阻止普通报修、照片上传、评价、时间轴、通知及统计。

## 显式配置模式

未配置 AI_MODE，或设置为 off 时，分析接口返回 503，不影响系统其他功能。

- AI_MODE=rules：本地规则演示，不读取模型密钥、不访问外部服务。
  界面标识“规则演示（非大模型）”，接口 mode=rules、mode_label=规则演示。
- AI_MODE=remote：真实模型接口。
  界面标识“真实 AI 分析”，接口 mode=remote。配置缺失或服务失败直接返回错误，绝不静默降级到 rules。

真实模式必填的后端环境变量：
- AI_PROVIDER=chat-completions
- AI_ENDPOINT：提供商支持 JSON 输出的完整 Chat Completions HTTPS 地址
- AI_MODEL：提供商实际可用的模型标识，不内置假定模型
- AI_API_KEY：只放在后端进程环境，不使用 VITE_ 前缀，不写入前端或版本库
- AI_TIMEOUT_MS：可选，默认 8000，范围 1–20000 毫秒；包含响应体读取时间

协议使用 Node 内置 fetch、Bearer 认证、messages 和 response_format:json_object。
不安装 SDK。提供商必须支持此协议和 JSON 输出。
例如 DeepSeek 的 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、
[JSON 输出说明](https://api-docs.deepseek.com/guides/json_mode/)；模型名称由管理员按提供商文档填写。
Endpoint 不允许用户名、密码、查询参数或 fragment，禁止自动重定向，避免认证信息意外转发。
仅测试代码可显式允许本机 HTTP 模拟服务；生产配置要求 HTTPS。

## 接口

POST /api/ai/analyze-repair，JSON {description:"故障描述"}。
仅有效学生会话可用，继承现有 Origin、X-Auth-Request:1 和 JSON 约束。

description trim 后 8–500 字符，遵守原报修描述上限。
后端只取此字段，忽略客户端额外的姓名、电话、宿舍、Cookie、照片、身份和密钥字段。
对描述中可识别的手机、邮箱、证件、标注姓名、部分宿舍格式及当前显示名做基础脱敏，再发送模型。
自由文本脱敏无法识别所有个人信息，界面明确提醒不要输入个人资料；不声称完全匿名。

成功 data 字段：
```json
{
  "mode": "rules",
  "mode_label": "规则演示",
  "recommended_category": "水电",
  "possible_causes": ["设施或部件可能老化、磨损或损坏。"],
  "advice": "后端审核过的安全建议",
  "safety_adjusted": false,
  "reference_only": true
}
```
remote 另返回所配置模型的标识，不返回 endpoint 或 Key。

未登录/会话失效 401；非学生/来源不符 403；输入非法 400；限流 429；
未启用/配置不正确 503；上游网络、状态、JSON、类别/结构错误 502；超时 504。
提供商返回 401 不会冒充本站登录失效，不会导致学生被错误退出。
错误内容是固定提示，不反射上游响应、输入、地址凭据、完整异常或密钥。

## 输出与安全策略

模型只返回 {category,cause_codes}：
- category 必须为共享合法枚举。
- cause_codes 是 1–3 个不重复代码，限定 wear、connection、blockage、power、network、alignment、unknown。
- 拒绝额外字段、任意原因文本、维修步骤、未知代码、超长内容、截断结果和非 JSON。
- 响应体最大 32KiB，模型输出 JSON 最大 2048 字符，max_tokens=256。
- 原因由模型选择的代码映射为后端审核短句；处理建议始终为后端安全预设，不直接展示模型自由生成操作。
  这是有意限制精细度的安全边界，不把规则结果冒充模型回答。
- 对燃气、电气异常、严重漏水等，后端强制保守类别/原因与停止使用、远离风险、联系专业人员的提示。
  remote 的安全调整仍在真实调用成功之后执行，并以 safety_adjusted 明示；不是服务失败后的演示回退。
- 所有模式均标注“AI 建议仅供参考”，不替代现场专业判断。

每用户默认 10 分钟 5 次，每连接 IP 10 分钟 20 次（含失败调用）。
同一用户同时最多 1 个调用，全局最多 3 个。429 提供 Retry-After，不自动重试，不循环计费。
限流为单进程内存实现，重启重置；未来多实例需共享限流/预算控制。
客户端断开会中止上游 fetch；等待期间用户停用或会话失效时不返回分析结果。
不记录完整故障描述、模型提示、API Key 或模型原始错误。

## 前端生命周期

组件只在学生新报修表单挂载，不对描述变化自动调用。
支持加载、错误、规则/真实模式标签、采用、忽略；均以文本渲染，不使用 v-html。
描述变更会清除旧结果并丢弃对应晚到结果；退出或页面卸载清空结果。
沿用请求层账号代数和中止机制，避免旧账号响应或旧 401 污染下一账号。
AI 在进行时仍可正常提交报修，不要求等待分析。

## 测试与真实库保护

```powershell
npm.cmd --prefix backend test
node --test frontend/test/client.test.js
npm.cmd --prefix frontend run build
node frontend/scripts/browser-smoke.mjs
```

后端 59/59（原 49 项 + AI 10 项），前端请求 8/8，构建通过；Chrome 原流程及 AI 交互合计 10 组通过。
真实调用协议使用本地模拟 AI HTTP 服务，密钥为运行时生成的虚拟值；
覆盖权限、输入、枚举、输出长度/格式、安全策略、隐私字段、上游失败、超时、限流、会话失效、失败后正常报修。
浏览器显式使用 rules，并在测试中显式关闭模式模拟服务不可用，不调用外部或付费模型。
所有数据库、上传目录和浏览器配置在系统临时目录；不迁移真实数据库，没有新增数据库迁移。
本轮没有读取实际密钥文件或进程密钥值，也没有做真实提供商联调。

正式接入前请由管理员在服务端设置 Key，选择实际可用模型，复核提供商数据保留及费用策略。
不需要把 Key 发到聊天中。生产还需手工验证 HTTPS、模型协议兼容及安全建议是否符合校内流程。
