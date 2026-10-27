import { Router } from 'express'
import { fail, positiveId } from './permissions.js'

// Called only after the corresponding log insert, inside its business transaction.
export function notifyRepairEvent(db, type, before, after, logId) {
  if (!db.isTransaction) throw new Error('notifications must share the business transaction')
  const recipients = new Map()
  const add = (id, role, title, content) => {
    if (id == null) return
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND role = ? AND is_active = 1').get(id, role)
    if (user) recipients.set(user.id, { title, content })
  }
  const number = '工单 #' + after.id
  if (type === 'created') {
    for (const admin of db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1").all()) {
      add(admin.id, 'admin', '有新的报修工单', number + ' 已提交，请查看并安排处理。')
    }
  }
  const studentMessages = {
    accepted: ['工单已接单', number + ' 已由维修人员接单。'],
    assigned: ['工单已派单', number + ' 已由管理员安排维修人员。'],
    started: ['工单开始维修', number + ' 已开始维修。'],
    completed: ['工单维修完成', number + ' 已维修完成，可以前往评价。'],
  }
  if (studentMessages[type]) add(after.student_id, 'student', ...studentMessages[type])
  if (type === 'assigned') {
    add(after.assigned_worker_id, 'worker', '收到维修任务', number + ' 已由管理员分配给你。')
  }
  if (type === 'reassigned') {
    // The former owner may no longer open the order, but is entitled to this revocation notice.
    add(before.assigned_worker_id, 'worker', '维修任务已改派', number + ' 已改派，你不再负责该任务。')
    add(after.assigned_worker_id, 'worker', '收到改派任务', number + ' 已由管理员改派给你。')
  }
  const now = new Date().toISOString()
  const insert = db.prepare(`INSERT INTO notifications
    (recipient_id, event_type, repair_order_id, source_log_id, title, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (const [id, message] of recipients) insert.run(id, type, after.id, logId, message.title, message.content, now)
}

export function createNotificationsRouter(db) {
  const router = Router()
  const fields = 'id, event_type, repair_order_id, title, content, created_at, read_at'
  router.get('/unread-count', (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE recipient_id = ? AND read_at IS NULL').get(req.user.id).count
    res.json({ success: true, data: { count } })
  })
  router.get('/', (req, res) => {
    const page = req.query.page === undefined ? 1 : positiveId(req.query.page)
    const limit = req.query.limit === undefined ? 20 : positiveId(req.query.limit)
    if (!page || page > 1000 || !limit || limit > 50) return fail(res, 400, 'page 须为 1–1000，limit 须为 1–50 的整数')
    const rows = db.prepare(`SELECT ${fields} FROM notifications WHERE recipient_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(req.user.id, limit + 1, (page - 1) * limit)
    res.json({ success: true, data: { items: rows.slice(0, limit), page, limit, has_more: rows.length > limit } })
  })
  router.patch('/read-all', (req, res) => {
    const result = db.prepare('UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), req.user.id)
    res.json({ success: true, data: { updated: result.changes } })
  })
  router.patch('/:id/read', (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return fail(res, 400, '消息 id 必须是正整数')
    const notification = db.prepare(`UPDATE notifications SET read_at = COALESCE(read_at, ?)
      WHERE id = ? AND recipient_id = ? RETURNING ${fields}`).get(new Date().toISOString(), id, req.user.id)
    if (!notification) return fail(res, 404, '消息不存在')
    res.json({ success: true, data: notification })
  })
  return router
}
