import { reactive, readonly } from 'vue'
import { request, requestGeneration, resetRequests, onUnauthorized, isCancelled } from './api/client.js'

const state = reactive({ user: null, checking: true, ending: false, version: 0, notice: '', error: '' })
export const session = readonly(state)
function clearUser(message = '') {
  resetRequests()
  state.user = null
  state.version++
  state.notice = message
}
onUnauthorized(() => clearUser('登录已失效，请重新登录'))

export async function restoreSession() {
  resetRequests()
  const started = requestGeneration()
  state.checking = true
  state.error = ''
  try {
    const user = await request('/auth/me', { ignoreUnauthorized: true })
    if (started === requestGeneration()) { state.user = user; state.version++ }
  } catch (error) {
    if (started === requestGeneration() && !isCancelled(error)) {
      state.user = null
      if (error.status !== 401) state.error = error.message
    }
  } finally { if (started === requestGeneration()) state.checking = false }
}

export async function login(account) {
  resetRequests()
  state.notice = ''; state.error = ''
  const started = requestGeneration()
  const user = await request('/auth/login', { method: 'POST', body: account, ignoreUnauthorized: true })
  if (started === requestGeneration()) { state.user = user; state.version++; state.error = '' }
}
export function register(account) {
  return request('/auth/register', { method: 'POST', body: account, ignoreUnauthorized: true })
}
export async function logout() {
  state.ending = true
  state.error = ''
  clearUser()
  try { await request('/auth/logout', { method: 'POST', body: {}, ignoreUnauthorized: true }) }
  catch (error) { if (!isCancelled(error)) state.error = '退出请求未确认：' + error.message + '。请重试退出。' }
  finally { state.ending = false }
}
