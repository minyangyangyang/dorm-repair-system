import express from 'express'
import cors from 'cors'
import { randomUUID } from 'node:crypto'

const fields = { building: '宿舍楼', room: '房间号', category: '故障类别', description: '问题描述', contact_name: '联系人', contact_phone: '联系电话' }
const categories = ['水电', '家具', '网络', '门窗', '其他']
// 后端最终决定状态规则；已完成没有下一步，不允许跳级、回退或重复设置。
const nextStatus = new Map([['待处理', '已接单'], ['已接单', '维修中'], ['维修中', '已完成']])
const statuses = ['待处理', '已接单', '维修中', '已完成']

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

  app.patch('/api/repairs/:id/status', (req, res) => {
    const id = Number(req.params.id)
    if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: '工单 id 必须是正整数数据库主键' })
    }
    const order = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(id)
    if (!order) return res.status(404).json({ success: false, message: '工单不存在' })
    if (!req.is('application/json')) return res.status(415).json({ success: false, message: '请使用 application/json 格式提交' })
    const status = req.body?.status
    if (Array.isArray(req.body) || !statuses.includes(status)) {
      return res.status(400).json({ success: false, message: '状态必须为待处理、已接单、维修中或已完成' })
    }
    if (nextStatus.get(order.status) !== status) {
      return res.status(409).json({ success: false, message: `不能从“${order.status}”变为“${status}”：状态不可跳级、回退或重复设置，已完成工单不可再操作` })
    }
    // 将旧状态放入 UPDATE 条件，防止同时操作时覆盖其他请求的修改。
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(order.updated_at) + 1)).toISOString()
    const result = db.prepare('UPDATE repair_orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(status, updatedAt, id, order.status)
    if (result.changes !== 1) return res.status(409).json({ success: false, message: '工单状态已变化，请重新读取后再操作' })
    const updated = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(id)
    res.json({ success: true, message: `工单状态已更新为“${status}”`, data: updated })
  })

  // 两个评价接口共用主键校验和工单存在性检查。
  function findEvaluationOrder(req, res, next) {
    const id = Number(req.params.id)
    if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ success: false, message: '工单 id 必须是正整数数据库主键' })
    }
    const order = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(id)
    if (!order) return res.status(404).json({ success: false, message: '工单不存在' })
    req.repairOrder = order
    next()
  }

  app.get('/api/repairs/:id/evaluation', findEvaluationOrder, (req, res) => {
    const evaluation = db.prepare('SELECT * FROM evaluations WHERE repair_order_id = ?').get(req.repairOrder.id)
    res.json({ success: true, message: evaluation ? '评价查询成功' : '该工单尚未评价', data: evaluation || null })
  })

  app.post('/api/repairs/:id/evaluation', findEvaluationOrder, (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ success: false, message: '请使用 application/json 格式提交' })
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ success: false, message: '请求内容必须是 JSON 对象' })
    if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
      return res.status(400).json({ success: false, message: '评分必须为 1～5 的整数' })
    }
    // 评价文字可不填，传入时必须是文本；限制原始长度，避免大量空格绕过校验。
    const comment = body.comment === undefined ? '' : body.comment
    if (typeof comment !== 'string' || comment.length > 500) {
      return res.status(400).json({ success: false, message: '评价内容必须是文本，且不超过 500 字' })
    }
    const order = req.repairOrder
    if (order.status !== '已完成') return res.status(409).json({ success: false, message: '只有已完成的工单才能评价' })
    if (db.prepare('SELECT id FROM evaluations WHERE repair_order_id = ?').get(order.id)) {
      return res.status(409).json({ success: false, message: '该工单已经评价，不能重复提交' })
    }
    try {
      const result = db.prepare('INSERT INTO evaluations (repair_order_id, rating, comment, created_at) VALUES (?, ?, ?, ?)')
        .run(order.id, body.rating, comment.trim(), new Date().toISOString())
      const evaluation = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(result.lastInsertRowid)
      res.status(201).json({ success: true, message: '维修评价提交成功', data: evaluation })
    } catch (error) {
      // UNIQUE 是最终防线：其他请求抢先提交时仍然不产生第二条评价。
      if (db.prepare('SELECT id FROM evaluations WHERE repair_order_id = ?').get(order.id)) {
        return res.status(409).json({ success: false, message: '该工单已经评价，不能重复提交' })
      }
      throw error
    }
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
