import express from 'express'
import cors from 'cors'
import { randomUUID } from 'node:crypto'

const fields = { building: '宿舍楼', room: '房间号', category: '故障类别', description: '问题描述', contact_name: '联系人', contact_phone: '联系电话' }
const categories = ['水电', '家具', '网络', '门窗', '其他']

export function createApp(db) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '32kb' }))

  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get()
    res.json({ success: true, message: '宿舍报修系统后端运行正常' })
  })

  app.get('/api/repairs', (req, res) => {
    const orders = db.prepare('SELECT * FROM repair_orders ORDER BY id DESC').all()
    res.json({ success: true, data: orders })
  })

  app.post('/api/repairs', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ success: false, message: '请使用 application/json 格式提交' })
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ success: false, message: '请求内容必须是 JSON 对象' })
    const order = {}
    const errors = []
    for (const [key, label] of Object.entries(fields)) {
      if (typeof body[key] !== 'string' || !body[key].trim()) {
        errors.push(`${label}不能为空，且必须是文本`)
        continue
      }
      order[key] = body[key].trim()
      if (order[key].length > (key === 'description' ? 500 : 50)) errors.push(`${label}长度超出限制`)
    }
    if (order.category && !categories.includes(order.category)) errors.push('故障类别必须为水电、家具、网络、门窗或其他')
    if (order.contact_phone && !/^1[3-9]\d{9}$/.test(order.contact_phone)) errors.push('联系电话必须为有效的11位手机号码')
    if (errors.length) return res.status(400).json({ success: false, message: errors.join('；') })

    // 服务端生成编号、状态和时间，忽略客户端传入的同名字段。
    // UUID 降低编号碰撞概率，数据库 UNIQUE 约束再次保证唯一性。
    const now = new Date().toISOString()
    const orderNo = `BX${now.slice(0, 10).replaceAll('-', '')}-${randomUUID()}`
    const result = db.prepare(`INSERT INTO repair_orders
      (order_no, building, room, category, description, contact_name, contact_phone, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '待处理', ?, ?)`)
      .run(orderNo, order.building, order.room, order.category, order.description, order.contact_name, order.contact_phone, now, now)
    const created = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(result.lastInsertRowid)
    res.status(201).json({ success: true, message: '报修工单创建成功', data: created })
  })

  app.use((req, res) => res.status(404).json({ success: false, message: '接口不存在' }))
  app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'JSON 格式错误，请检查请求内容' })
    if (error.type === 'entity.too.large') return res.status(413).json({ success: false, message: '请求内容过大' })
    console.error('后端处理请求失败：', error)
    res.status(500).json({ success: false, message: '服务器处理失败，请稍后重试' })
  })
  return app
}
