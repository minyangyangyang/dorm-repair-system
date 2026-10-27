import { request } from './client.js'
const orderPath = id => '/repairs/' + encodeURIComponent(id)
export const getStatistics = () => request('/statistics')
export const getEvaluation = id => request(orderPath(id) + '/evaluation')
export const submitEvaluation = (id, rating, comment) => request(orderPath(id) + '/evaluation', {
  method: 'POST', body: { rating, comment },
})
export function toPageRecord(order) {
  const date = new Date(order.created_at)
  const pad = value => String(value).padStart(2, '0')
  return {
    id: order.order_no, databaseId: order.id, createdAt: order.created_at, updatedAt: order.updated_at,
    building: order.building, room: order.room, category: order.category, description: order.description,
    contact: order.contact_name, phone: order.contact_phone, status: order.status,
    studentId: order.student_id, assignedWorkerId: order.assigned_worker_id,
    time: Number.isNaN(date.getTime()) ? '时间未知' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}
export async function getRepairs() {
  const rows = await request('/repairs')
  if (!Array.isArray(rows)) throw new Error('工单列表格式不正确')
  return rows.map(toPageRecord)
}
export const getRepair = async id => toPageRecord(await request(orderPath(id)))
export const acceptRepair = async id => toPageRecord(await request(orderPath(id) + '/accept', { method: 'POST', body: {} }))
export const updateRepairStatus = async (id, status) => toPageRecord(await request(orderPath(id) + '/status', { method: 'PATCH', body: { status } }))
export const createRepair = async form => toPageRecord(await request('/repairs', { method: 'POST', body: {
  building: form.building.trim(), room: form.room.trim(), category: form.category,
  description: form.description.trim(), contact_name: form.contact.trim(), contact_phone: form.phone.trim(),
} }))
export const getWorkers = () => request('/admin/workers')
export const createWorker = account => request('/admin/workers', { method: 'POST', body: account })
export const disableWorker = id => request('/admin/workers/' + encodeURIComponent(id), { method: 'PATCH', body: { is_active: 0 } })
export const assignRepair = async (record, workerId) => toPageRecord(await request(orderPath(record.databaseId) + '/assignment', {
  method: 'PATCH', body: { assigned_worker_id: Number(workerId),
    expected_status: record.status, expected_assigned_worker_id: record.assignedWorkerId,
    expected_updated_at: record.updatedAt },
}))

export const getTimeline = id => request(orderPath(id) + '/timeline')
