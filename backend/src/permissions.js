import { readSession } from './auth.js'

export const fail = (res, status, message) => res.status(status).json({ success: false, message })

export function requireSession(db) {
  return (req, res, next) => {
    const session = readSession(db, req)
    if (!session) return fail(res, 401, '未登录或登录已失效')
    req.user = session.user
    next()
  }
}

export function requireRoles(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : fail(res, 403, '当前角色无权执行此操作')
}

export function positiveId(value) {
  const id = Number(value)
  return /^\d+$/.test(String(value)) && Number.isSafeInteger(id) && id > 0 ? id : null
}

// All record visibility is constrained in SQL, including detail and evaluation lookup.
export function orderScope(user, statistics = false) {
  if (user.role === 'admin') return { sql: '1 = 1', params: [] }
  if (user.role === 'student') return { sql: 'student_id = ?', params: [user.id] }
  if (user.role === 'worker') return {
    sql: statistics ? 'assigned_worker_id = ?' :
      "(assigned_worker_id = ? OR (status = '待处理' AND assigned_worker_id IS NULL))",
    params: [user.id],
  }
  return { sql: '0 = 1', params: [] }
}

const publicPendingFields = ['id', 'order_no', 'category', 'status', 'created_at', 'updated_at', 'assigned_worker_id']
const privateFields = ['building', 'room', 'description', 'contact_name', 'contact_phone', 'student_id']

function projection(user) {
  if (user.role !== 'worker') return '*'
  // Unassigned rows must not even load personal data from SQLite.
  return [...publicPendingFields, ...privateFields.map(field =>
    `CASE WHEN assigned_worker_id IS NOT NULL THEN ${field} END AS ${field}`)].join(', ')
}

function serializeOrder(user, row) {
  if (user.role !== 'worker' || row.assigned_worker_id !== null) return row
  return Object.fromEntries(publicPendingFields.map(field => [field, row[field]]))
}

export function visibleOrders(db, user) {
  const scope = orderScope(user)
  return db.prepare(`SELECT ${projection(user)} FROM repair_orders WHERE ${scope.sql} ORDER BY id DESC`)
    .all(...scope.params).map(row => serializeOrder(user, row))
}

export function visibleOrder(db, user, id) {
  const scope = orderScope(user)
  const row = db.prepare(`SELECT ${projection(user)} FROM repair_orders WHERE id = ? AND (${scope.sql})`)
    .get(id, ...scope.params)
  return row ? serializeOrder(user, row) : null
}

export function nextUpdatedAt(order) {
  return new Date(Math.max(Date.now(), Date.parse(order.updated_at) + 1)).toISOString()
}
