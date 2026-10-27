let generation = 0
let unauthorized = () => {}
const pending = new Set()

export class ApiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code }
}
export const requestGeneration = () => generation
export const isCancelled = error => error?.code === 'STALE'
export function onUnauthorized(handler) { unauthorized = handler }
export function resetRequests() {
  generation++
  for (const controller of pending) controller.abort()
  pending.clear()
}

export async function request(path, { method = 'GET', body, ignoreUnauthorized = false, responseType = 'json', timeoutMs = 10000 } = {}) {
  const started = generation
  const controller = new AbortController()
  pending.add(controller)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const writing = !['GET', 'HEAD'].includes(method)
  try {
    const response = await fetch('/api' + path, {
      method, credentials: 'include', signal: controller.signal,
      headers: writing ? { 'Content-Type': 'application/json', 'X-Auth-Request': '1' } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (started !== generation) throw new ApiError('请求已过期', 0, 'STALE')
    if (response.ok && responseType === 'blob') {
      const blob = await response.blob()
      if (started !== generation) throw new ApiError('请求已过期',0,'STALE')
      return blob
    }
    let result
    try { result = await response.json() } catch {
      if (started !== generation) throw new ApiError('请求已过期', 0, 'STALE')
      if (response.status === 401 && !ignoreUnauthorized) unauthorized()
      throw new ApiError('后端返回的数据格式不正确，请稍后重试', response.status)
    }
    if (started !== generation) throw new ApiError('请求已过期', 0, 'STALE')
    if (!response.ok || !result.success) {
      if (response.status === 401 && !ignoreUnauthorized) unauthorized()
      const fallback = { 401: '登录已失效，请重新登录', 403: '当前账号无权操作',
        404: '工单不存在或已不属于当前账号', 409: '数据已变化，请刷新后重试', 429: '操作频繁，请稍后重试' }
      throw new ApiError(result.message || fallback[response.status] || '请求失败，请稍后重试', response.status)
    }
    return result.data
  } catch (error) {
    if (started !== generation && error?.status !== 401) throw new ApiError('请求已过期', 0, 'STALE')
    if (error instanceof ApiError) throw error
    throw new ApiError('无法连接后端或请求超时，请稍后重试')
  } finally { clearTimeout(timeout); pending.delete(controller) }
}
