import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, request, resetRequests, onUnauthorized } from '../src/api/client.js'
import { toPageRecord, assignRepair, acceptRepair } from '../src/api/repairs.js'
const response = (status, data) => ({ status, ok: status < 400, json: async () => data })

test('请求携带凭据与写操作防护，ID 映射及派单快照准确', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return response(200, { success: true, data: { id: 42, order_no: 'BX-test' } }) }
  try {
    const record = toPageRecord({ id: 42, order_no: 'BX-test', status: '已接单', assigned_worker_id: 8, updated_at: '2026-01-01T00:00:00.000Z' })
    assert.equal(record.databaseId, 42); assert.equal(record.id, 'BX-test')
    await acceptRepair(42)
    assert.equal(calls[0].url, '/api/repairs/42/accept')
    assert.equal(calls[0].options.credentials, 'include')
    assert.equal(calls[0].options.headers['X-Auth-Request'], '1')
    await assignRepair(record, 9)
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      assigned_worker_id: 9, expected_status: '已接单', expected_assigned_worker_id: 8, expected_updated_at: record.updatedAt,
    })
  } finally { globalThis.fetch = original; resetRequests() }
})

test('403/404/409 保留状态，当前请求 401 触发登录清理', async () => {
  const original = globalThis.fetch
  let cleared = 0
  onUnauthorized(() => { cleared++; resetRequests() })
  try {
    for (const status of [403, 404, 409, 401]) {
      globalThis.fetch = async () => response(status, { success: false, message: '测试错误' })
      await assert.rejects(request('/repairs'), error => error instanceof ApiError && error.status === status)
    }
    assert.equal(cleared, 1)
  } finally { globalThis.fetch = original; onUnauthorized(() => {}); resetRequests() }
})

test('退出后的晚到成功响应和晚到 401 均不得影响下一账号', async () => {
  const original = globalThis.fetch
  let cleared = 0
  onUnauthorized(() => { cleared++ })
  try {
    for (const status of [200, 401]) {
      let finish
      globalThis.fetch = () => new Promise(resolve => { finish = resolve })
      const pending = request('/repairs')
      const rejected = assert.rejects(pending, error => error.code === 'STALE')
      resetRequests()
      finish(response(status, { success: status === 200, data: [{ id: 1 }] }))
      await rejected
    }
    assert.equal(cleared, 0)
  } finally { globalThis.fetch = original; onUnauthorized(() => {}); resetRequests() }
})

test('响应体读取期间切换账号同样丢弃旧数据', async () => {
  const original = globalThis.fetch
  let finish
  let reading
  const started = new Promise(resolve => { reading = resolve })
  globalThis.fetch = async () => ({ status: 200, ok: true, json: () => { reading(); return new Promise(resolve => { finish = resolve }) } })
  try {
    const pending = request('/statistics')
    const rejected = assert.rejects(pending, error => error.code === 'STALE')
    await started
    resetRequests()
    finish({ success: true, data: { total: 999 } })
    await rejected
  } finally { globalThis.fetch = original; resetRequests() }
})
