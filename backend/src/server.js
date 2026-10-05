import { openDatabase, databasePath } from './database.js'
import { createApp } from './app.js'
import { resolve } from 'node:path'

const port = Number(process.env.PORT || 3000)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 到 65535 的整数')
// 测试可指定独立数据库；正常启动仍使用原有正式数据库。
const activeDatabasePath = process.env.DB_PATH ? resolve(process.env.DB_PATH) : databasePath
const db = openDatabase(activeDatabasePath)
const server = createApp(db).listen(port, () => {
  console.log(`宿舍报修系统后端启动成功：http://localhost:${port}`)
  console.log(`SQLite 数据库已就绪：${activeDatabasePath}`)
  console.log(`健康检查：http://localhost:${port}/api/health`)
})
server.on('error', error => {
  console.error('后端启动失败：', error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : error.message)
  db.close()
  process.exitCode = 1
})
// 正常停止服务器时关闭数据库，已写入的工单会保留在磁盘上。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { db.close(); process.exitCode = 0 }))
}
