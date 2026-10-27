import { appendRepairLog } from './repair-logs.js'
import { Router } from 'express'
import { hashPassword, normalizeUsername, publicUser, validateAccount } from './accounts.js'
import { readSession } from './auth.js'
import { fail, nextUpdatedAt, positiveId, requireRoles } from './permissions.js'

const workerFields = 'id, username, display_name, role, is_active, created_at'

export function createAdminRouter(db) {
  const router = Router()
  router.use(requireRoles('admin'))
  let creating = 0

  router.get('/workers', (req, res) => {
    const data = db.prepare(`SELECT ${workerFields} FROM users WHERE role = 'worker' ORDER BY id DESC`).all()
    res.json({ success: true, data })
  })

  router.post('/workers', async (req, res) => {
    const invalid = validateAccount(req.body)
    if (invalid) return fail(res, 400, invalid)
    if (Object.hasOwn(req.body, 'role') && req.body.role !== 'worker') return fail(res, 400, '此接口仅允许创建维修人员账号')
    const username = normalizeUsername(req.body.username)
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return fail(res, 409, '用户名已存在')
    if (creating >= 2) return fail(res, 429, '账号创建繁忙，请稍后重试')
    creating++
    try {
      const passwordHash = await hashPassword(req.body.password)
      // Hashing yields to other requests; revalidate the administrator before writing.
      const session = readSession(db, req)
      if (!session) return fail(res, 401, '未登录或登录已失效')
      if (session.user.role !== 'admin') return fail(res, 403, '当前角色无权执行此操作')
      let result
      try {
        result = db.prepare(`INSERT INTO users (username, password_hash, display_name, role, created_at)
          VALUES (?, ?, ?, 'worker', ?)`).run(username, passwordHash, req.body.display_name.trim(), new Date().toISOString())
      } catch (error) {
        if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return fail(res, 409, '用户名已存在')
        throw error
      }
      const user = db.prepare(`SELECT ${workerFields} FROM users WHERE id = ?`).get(result.lastInsertRowid)
      res.status(201).json({ success: true, message: '维修人员账号创建成功', data: publicUser(user) })
    } finally { creating-- }
  })

  router.patch('/workers/:id', (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return fail(res, 400, '账号 id 必须是正整数')
    if (!req.body || Array.isArray(req.body) || req.body.is_active !== 0 ||
        Object.keys(req.body).some(key => key !== 'is_active')) return fail(res, 400, '仅支持通过 is_active: 0 停用维修账号')
    db.exec('BEGIN IMMEDIATE')
    try {
      const worker = db.prepare(`SELECT ${workerFields} FROM users WHERE id = ? AND role = 'worker'`).get(id)
      if (!worker) {
        db.exec('ROLLBACK')
        return fail(res, 404, '维修人员账号不存在')
      }
      db.prepare("UPDATE users SET is_active = 0 WHERE id = ? AND role = 'worker'").run(id)
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
      db.exec('COMMIT')
      res.json({ success: true, message: '维修账号已停用，现有会话已撤销', data: { ...worker, is_active: 0 } })
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  })
  return router
}

export function assignOrder(db) {
  return (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return fail(res, 400, '工单 id 必须是正整数数据库主键')
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        !Number.isSafeInteger(body.assigned_worker_id) || body.assigned_worker_id < 1 ||
        !['待处理', '已接单', '维修中', '已完成'].includes(body.expected_status) ||
        !(body.expected_assigned_worker_id === null ||
          (Number.isSafeInteger(body.expected_assigned_worker_id) && body.expected_assigned_worker_id > 0)) ||
        (body.expected_updated_at !== undefined && typeof body.expected_updated_at !== 'string')) {
      return fail(res, 400, '须提供维修人员 id、expected_status 和 expected_assigned_worker_id，可选 expected_updated_at')
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const order = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(id)
      if (!order) {
        db.exec('ROLLBACK')
        return fail(res, 404, '工单不存在')
      }
      if (!['待处理', '已接单'].includes(order.status) ||
          (order.status === '待处理' && order.assigned_worker_id !== null) ||
          order.status !== body.expected_status ||
          order.assigned_worker_id !== body.expected_assigned_worker_id ||
          (body.expected_updated_at !== undefined && body.expected_updated_at !== order.updated_at) ||
          order.assigned_worker_id === body.assigned_worker_id) {
        db.exec('ROLLBACK')
        return fail(res, 409, '工单状态或负责人已变化，或当前状态不允许派单')
      }
      // The write lock prevents target disable/reassignment racing this validation.
      const worker = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'worker' AND is_active = 1").get(body.assigned_worker_id)
      if (!worker) {
        db.exec('ROLLBACK')
        return fail(res, 400, '目标必须为启用的维修人员账号')
      }
      const result = db.prepare(`UPDATE repair_orders SET assigned_worker_id = ?, status = '已接单', updated_at = ?
        WHERE id = ? AND status = ? AND assigned_worker_id IS ? AND updated_at = ?`)
        .run(worker.id, nextUpdatedAt(order), id, order.status, order.assigned_worker_id, order.updated_at)
      if (result.changes !== 1) {
        db.exec('ROLLBACK')
        return fail(res, 409, '工单已变化，请重新读取后操作')
      }
      const updated = db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(id)
      appendRepairLog(db, order.status === '待处理' ? 'assigned' : 'reassigned', req.user, order, updated)
      db.exec('COMMIT')
      res.json({ success: true, message: '派单成功', data: updated })
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }
}
