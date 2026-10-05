const API_URL = 'http://localhost:3000/api/repairs'

export function getEvaluation(databaseId) {
  return request({}, `${API_URL}/${encodeURIComponent(databaseId)}/evaluation`)
}

export function submitEvaluation(databaseId, rating, comment) {
  // 使用数据库主键提交评价，评分和内容由后端再次校验并保存。
  return request({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating, comment }),
  }, `${API_URL}/${encodeURIComponent(databaseId)}/evaluation`)
}

async function request(options = {}, url = API_URL) {
  let response
  try {
    // 超时或无法连接时给出中文提示，不让网络错误中断页面。
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) })
  } catch {
    throw new Error('无法连接后端或请求超时，请确认后端已在 http://localhost:3000 启动。')
  }
  let result
  try { result = await response.json() } catch {
    throw new Error('后端返回的数据格式不正确，请稍后重试。')
  }
  if (!response.ok || !result.success) throw new Error(result.message || '请求失败，请稍后重试。')
  return result.data
}

// 将数据库字段转换为现有页面字段，编号仍使用页面的 id 展示。
export function toPageRecord(order) {
  const date = new Date(order.created_at)
  const pad = value => String(value).padStart(2, '0')
  return {
    id: order.order_no, databaseId: order.id,
    building: order.building, room: order.room, category: order.category,
    description: order.description, contact: order.contact_name,
    phone: order.contact_phone, status: order.status,
    time: Number.isNaN(date.getTime()) ? '时间未知' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

export async function getRepairs() {
  const orders = await request()
  if (!Array.isArray(orders)) throw new Error('后端工单列表格式不正确，请稍后重试。')
  return orders.map(toPageRecord)
}

export async function updateRepairStatus(databaseId, status) {
  // URL 使用数据库主键，不使用界面显示的报修编号。
  const order = await request({
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }, `${API_URL}/${encodeURIComponent(databaseId)}/status`)
  return toPageRecord(order)
}

export async function createRepair(form) {
  // POST 使用后端约定的字段；编号、状态和时间由后端生成。
  const order = await request({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      building: form.building.trim(), room: form.room.trim(), category: form.category,
      description: form.description.trim(), contact_name: form.contact.trim(), contact_phone: form.phone.trim(),
    }),
  })
  return toPageRecord(order)
}
