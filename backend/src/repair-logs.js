import { notifyRepairEvent } from './notifications.js'
import { fail, positiveId, visibleOrder } from './permissions.js'

// Synchronous callbacks only: never yield while holding a SQLite transaction.
export function withRepairTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

export function appendRepairLog(db, type, actor, before, after) {
  if (!db.isTransaction) throw new Error('repair logs must share the business transaction')
  const result = db.prepare(`INSERT INTO repair_logs (
    repair_order_id, event_type, actor_id, actor_display_name, actor_role, occurred_at,
    from_status, to_status, from_worker_id, to_worker_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    after.id, type, actor.id, actor.display_name, actor.role, new Date().toISOString(),
    before?.status ?? null, after.status, before?.assigned_worker_id ?? null, after.assigned_worker_id,
  )
  notifyRepairEvent(db, type, before, after, Number(result.lastInsertRowid))
}

export function timelineHandler(db) {
  return (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return fail(res, 400, '工单 id 必须是正整数数据库主键')
    // Permission and log reads see the same database snapshot.
    db.exec('BEGIN')
    let data
    try {
      const order = visibleOrder(db, req.user, id)
      if (!order) {
        db.exec('ROLLBACK')
        return fail(res, 404, '工单不存在')
      }
      if (req.user.role === 'worker' && order.assigned_worker_id === null) {
        // Do not expose events, identities, counts, or history completeness in the public pool.
        data = { events: [], redacted: true, history_incomplete: null }
      } else {
        const rows = db.prepare(`SELECT id, event_type, actor_id, actor_display_name, actor_role,
          occurred_at, from_status, to_status, from_worker_id, to_worker_id
          FROM repair_logs WHERE repair_order_id = ? ORDER BY occurred_at ASC, id ASC`).all(id)
        data = {
          redacted: false,
          history_incomplete: !rows.some(row => row.event_type === 'created'),
          events: rows.map(row => ({
            id: row.id, event_type: row.event_type, occurred_at: row.occurred_at,
            actor: { id: row.actor_id, display_name: row.actor_display_name, role: row.actor_role },
            summary: { from_status: row.from_status, to_status: row.to_status,
              from_worker_id: row.from_worker_id, to_worker_id: row.to_worker_id },
          })),
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
    res.json({ success: true, data })
  }
}
