import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openDatabase } from '../src/database.js'
import { createApp } from '../src/app.js'
import { hashPassword, verifyPassword } from '../src/accounts.js'
import { loginClient, testAccount, testOrigin } from '../test-support/accounts.js'

const realDirectory = new URL('../data/', import.meta.url)
const fingerprint = () => Object.fromEntries(readdirSync(realDirectory).filter(name => name.startsWith('repairs.sqlite')).sort()
  .map(name => [name, createHash('sha256').update(readFileSync(new URL(name, realDirectory))).digest('hex')]))
const before = fingerprint()
test.after(() => assert.deepEqual(fingerprint(), before, '正式数据库和辅助文件不得被修改'))
const credentials = testAccount('fixture')
let fixtureHash
test.before(async () => { fixtureHash = await hashPassword(credentials.password) })

async function setup(t) {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'dorm-permissions-')), 'test.sqlite'))
  const accounts = {}
  for (const [name, role] of [['admin', 'admin'], ['student1', 'student'], ['student2', 'student'], ['worker1', 'worker'], ['worker2', 'worker']]) {
    const result = db.prepare('INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, fixtureHash, name, role, new Date().toISOString())
    accounts[name] = { id: Number(result.lastInsertRowid), username: name, password: credentials.password }
  }
  const server = createApp(db, { auth: { loginLimit: 100, registerLimit: 100 } }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close() })
  const clients = {}
  async function request(actor, method, path, body, headers = {}) {
    let fetcher = globalThis.fetch
    if (actor) {
      if (!clients[actor]) clients[actor] = await loginClient(base, accounts[actor])
      fetcher = clients[actor]
    }
    const response = await fetcher(base + path, { method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = await response.json()
    const serialized = JSON.stringify(data)
    assert.equal(serialized.includes('password_hash'), false)
    assert.equal(serialized.includes('token_hash'), false)
    assert.equal(serialized.includes(credentials.password), false)
    return { status: response.status, data, headers: response.headers }
  }
  function seed({ owner = null, worker = null, status = '待处理', evaluation = false } = {}) {
    const now = new Date().toISOString()
    const result = db.prepare(`INSERT INTO repair_orders
      (order_no, building, room, category, description, contact_name, contact_phone, status,
       created_at, updated_at, student_id, assigned_worker_id)
      VALUES (?, '私人宿舍', '私人房号', '水电', '私人自由文本', '私人联系人', '13800000000', ?, ?, ?, ?, ?)`)
      .run('TEST-' + db.prepare('SELECT count(*) AS n FROM repair_orders').get().n, status, now, now,
        owner ? accounts[owner].id : null, worker ? accounts[worker].id : null)
    const id = Number(result.lastInsertRowid)
    if (evaluation) db.prepare('INSERT INTO evaluations (repair_order_id, rating, comment, created_at) VALUES (?, 5, ?, ?)')
      .run(id, '历史评价原文', now)
    return id
  }
  const order = id => ({ ...db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(id) })
  async function assign(id, worker, snapshot = order(id)) {
    return request('admin', 'PATCH', `/api/repairs/${id}/assignment`, {
      assigned_worker_id: accounts[worker].id, expected_status: snapshot.status,
      expected_assigned_worker_id: snapshot.assigned_worker_id, expected_updated_at: snapshot.updated_at,
    })
  }
  return { db, base, accounts, request, seed, order, assign }
}

test('未登录业务接口统一 401，健康检查公开', async t => {
  const { request } = await setup(t)
  for (const [method, path, body] of [
    ['GET', '/api/repairs'], ['GET', '/api/repairs/1'], ['GET', '/api/statistics'],
    ['GET', '/api/repairs/1/evaluation'], ['POST', '/api/repairs', {}],
    ['POST', '/api/repairs/1/evaluation', {}], ['PATCH', '/api/repairs/1/status', {}],
    ['POST', '/api/repairs/1/accept', {}], ['PATCH', '/api/repairs/1/assignment', {}],
    ['GET', '/api/admin/workers'], ['POST', '/api/admin/workers', {}], ['PATCH', '/api/admin/workers/1', {}],
  ]) assert.equal((await request(null, method, path, body)).status, 401)
  assert.equal((await request(null, 'GET', '/api/health')).status, 200)
})

test('学生列表、详情和创建归属由会话控制，伪造身份无效', async t => {
  const { request, seed, accounts } = await setup(t)
  const own = seed({ owner: 'student1' })
  const other = seed({ owner: 'student2' })
  const legacy = seed()
  const listed = await request('student1', 'GET', '/api/repairs?student_id=' + accounts.student2.id)
  assert.deepEqual(listed.data.data.map(row => row.id), [own])
  assert.equal((await request('student1', 'GET', `/api/repairs/${own}`)).status, 200)
  for (const id of [other, legacy, 999999]) {
    assert.equal((await request('student1', 'GET', `/api/repairs/${id}`)).status, 404)
    assert.equal((await request('student1', 'GET', `/api/repairs/${id}/evaluation`)).status, 404)
    assert.equal((await request('student1', 'POST', `/api/repairs/${id}/evaluation`, { rating: 5 })).status, 404)
  }
  const created = await request('student1', 'POST', '/api/repairs', {
    building: '3栋', room: '101', category: '水电', description: '灯泡故障', contact_name: '同学',
    contact_phone: '13800000000', student_id: accounts.student2.id, assigned_worker_id: accounts.worker1.id,
    status: '已完成', order_no: 'FORGED', role: 'admin',
  })
  assert.equal(created.status, 201)
  assert.equal(created.data.data.student_id, accounts.student1.id)
  assert.equal(created.data.data.assigned_worker_id, null)
  assert.equal(created.data.data.status, '待处理')
  assert.notEqual(created.data.data.order_no, 'FORGED')
  assert.equal((await request('student2', 'GET', `/api/repairs/${created.data.data.id}`)).status, 404)
})

test('学生仅能读取和提交本人已完成评价，管理员不可代评，维修人员无评价权限', async t => {
  const { request, seed, db } = await setup(t)
  const done = seed({ owner: 'student1', worker: 'worker1', status: '已完成' })
  const pending = seed({ owner: 'student1' })
  assert.equal((await request('student1', 'GET', `/api/repairs/${pending}/evaluation`)).status, 409)
  assert.equal((await request('student1', 'POST', `/api/repairs/${pending}/evaluation`, { rating: 5 })).status, 409)
  assert.equal((await request('student2', 'POST', `/api/repairs/${done}/evaluation`, { rating: 5 })).status, 404)
  for (const actor of ['admin', 'worker1']) {
    assert.equal((await request(actor, 'POST', `/api/repairs/${done}/evaluation`, { rating: 5 })).status, 403)
  }
  assert.equal((await request('worker1', 'GET', `/api/repairs/${done}/evaluation`)).status, 403)
  const parallel = await Promise.all([1, 2].map(() => request('student1', 'POST', `/api/repairs/${done}/evaluation`, { rating: 5, comment: '自己的评价' })))
  assert.deepEqual(parallel.map(item => item.status).sort(), [201, 409])
  assert.equal(db.prepare('SELECT count(*) AS n FROM evaluations WHERE repair_order_id = ?').get(done).n, 1)
  assert.equal((await request('student1', 'GET', `/api/repairs/${done}/evaluation`)).data.data.comment, '自己的评价')
  assert.equal((await request('admin', 'GET', `/api/repairs/${done}/evaluation`)).status, 200)
})

test('学生与管理员不能更新维修状态，维修人员不能创建报修或管理账号', async t => {
  const { request, seed, accounts } = await setup(t)
  const id = seed({ owner: 'student1' })
  for (const actor of ['student1', 'admin']) {
    assert.equal((await request(actor, 'PATCH', `/api/repairs/${id}/status`, { status: '已接单', role: 'worker' })).status, 403)
    assert.equal((await request(actor, 'POST', `/api/repairs/${id}/accept`, {})).status, 403)
  }
  for (const actor of ['student1', 'worker1']) {
    assert.equal((await request(actor, 'GET', '/api/admin/workers')).status, 403)
    assert.equal((await request(actor, 'POST', '/api/admin/workers', testAccount('forged_worker'))).status, 403)
    assert.equal((await request(actor, 'PATCH', `/api/admin/workers/${accounts.worker2.id}`, { is_active: 0 })).status, 403)
    assert.equal((await request(actor, 'PATCH', `/api/repairs/${id}/assignment`, { assigned_worker_id: accounts.worker1.id })).status, 403)
  }
  for (const actor of ['worker1', 'admin']) assert.equal((await request(actor, 'POST', '/api/repairs', {})).status, 403)
})

test('维修人员接单前列表和详情不含任何私人字段，接单后仅本人可读取', async t => {
  const { request, seed, order, accounts } = await setup(t)
  const id = seed({ owner: 'student1' })
  seed({ owner: 'student2', worker: 'worker2', status: '已接单' })
  const pendingFields = ['assigned_worker_id', 'category', 'created_at', 'id', 'order_no', 'status', 'updated_at'].sort()
  const listed = await request('worker1', 'GET', '/api/repairs')
  assert.deepEqual(listed.data.data.map(row => row.id), [id])
  assert.deepEqual(Object.keys(listed.data.data[0]).sort(), pendingFields)
  const detail = await request('worker1', 'GET', `/api/repairs/${id}`)
  assert.deepEqual(Object.keys(detail.data.data).sort(), pendingFields)
  const accepted = await request('worker1', 'POST', `/api/repairs/${id}/accept`, {})
  assert.equal(accepted.status, 200)
  assert.equal(accepted.data.data.assigned_worker_id, accounts.worker1.id)
  assert.equal(accepted.data.data.contact_phone, '13800000000')
  assert.equal((await request('worker1', 'GET', `/api/repairs/${id}`)).data.data.contact_name, '私人联系人')
  assert.equal((await request('worker2', 'GET', `/api/repairs/${id}`)).status, 404)
  assert.equal(order(id).status, '已接单')
})

test('两个维修人员竞争接单仅一个成功，重复接单不变更工单', async t => {
  const { request, seed, order } = await setup(t)
  const id = seed({ owner: 'student1' })
  // Warm up real sessions so the tested requests race the acceptance, not password hashing.
  await request('worker1', 'GET', '/api/repairs')
  await request('worker2', 'GET', '/api/repairs')
  const result = await Promise.all(['worker1', 'worker2'].map(actor => request(actor, 'PATCH', `/api/repairs/${id}/status`, { status: '已接单' })))
  assert.deepEqual(result.map(row => row.status).sort(), [200, 409])
  const accepted = order(id)
  for (const actor of ['worker1', 'worker2']) assert.equal((await request(actor, 'POST', `/api/repairs/${id}/accept`, {})).status, 409)
  assert.deepEqual(order(id), accepted)
  assert.equal((await request('worker1', 'POST', '/api/repairs/999999/accept', {})).status, 409)
})

test('维修人员不能操作他人工单，状态流转严格且改派后原负责人立即失去权限', async t => {
  const { request, seed, order, assign } = await setup(t)
  const id = seed({ owner: 'student1', worker: 'worker1', status: '已接单' })
  assert.equal((await request('worker2', 'PATCH', `/api/repairs/${id}/status`, { status: '维修中' })).status, 404)
  const initial = order(id)
  assert.equal((await assign(id, 'worker2')).status, 200)
  const reassigned = order(id)
  assert.equal(reassigned.status, '已接单')
  assert.ok(Date.parse(reassigned.updated_at) > Date.parse(initial.updated_at))
  assert.equal((await request('worker1', 'PATCH', `/api/repairs/${id}/status`, { status: '维修中' })).status, 404)
  assert.equal((await request('worker1', 'GET', `/api/repairs/${id}`)).status, 404)
  for (const status of ['待处理', '已完成', '已接单']) {
    assert.equal((await request('worker2', 'PATCH', `/api/repairs/${id}/status`, { status })).status, 409)
  }
  assert.equal((await request('worker2', 'PATCH', `/api/repairs/${id}/status`, { status: '维修中' })).status, 200)
  assert.equal((await assign(id, 'worker1')).status, 409)
  assert.equal((await request('worker2', 'PATCH', `/api/repairs/${id}/status`, { status: '已完成' })).status, 200)
  const done = order(id)
  for (const status of ['待处理', '已接单', '维修中', '已完成']) {
    assert.equal((await request('worker2', 'PATCH', `/api/repairs/${id}/status`, { status })).status, 409)
  }
  assert.deepEqual(order(id), done)
})

test('管理员创建/查看/停用维修账号，拒绝修改其他角色和公开注册高权限角色', async t => {
  const { request, db, accounts } = await setup(t)
  const account = testAccount('new_worker')
  const created = await request('admin', 'POST', '/api/admin/workers', account)
  assert.equal(created.status, 201)
  assert.equal(created.data.data.role, 'worker')
  const id = created.data.data.id
  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id)
  assert.equal(await verifyPassword(account.password, stored.password_hash), true)
  assert.equal(stored.password_hash.includes(account.password), false)
  assert.equal((await request('admin', 'POST', '/api/admin/workers', account)).status, 409)
  for (const role of ['admin', 'student']) {
    assert.equal((await request('admin', 'POST', '/api/admin/workers', { ...testAccount('invalid_role'), role })).status, 400)
  }
  assert.equal((await request('admin', 'POST', '/api/admin/workers', { ...account, username: 'invalid', password: 'short' })).status, 400)
  const list = await request('admin', 'GET', '/api/admin/workers')
  assert.equal(list.data.data.length, 3)
  assert.equal(list.data.data.every(user => user.role === 'worker'), true)
  for (const body of [{ is_active: 1 }, { is_active: false }, { is_active: 0, role: 'admin' }]) {
    assert.equal((await request('admin', 'PATCH', `/api/admin/workers/${id}`, body)).status, 400)
  }
  for (const target of [accounts.admin.id, accounts.student1.id, 999999]) {
    assert.equal((await request('admin', 'PATCH', `/api/admin/workers/${target}`, { is_active: 0 })).status, 404)
  }
})

test('停用维修账号撤销全部会话，原会话与再次登录均不可用', async t => {
  const { request, db, accounts, seed } = await setup(t)
  const id = seed({ worker: 'worker1', status: '已接单' })
  assert.equal((await request('worker1', 'GET', '/api/repairs')).status, 200)
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(accounts.worker1.id).n, 1)
  assert.equal((await request('admin', 'PATCH', `/api/admin/workers/${accounts.worker1.id}`, { is_active: 0 })).status, 200)
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(accounts.worker1.id).n, 0)
  assert.equal((await request('worker1', 'GET', '/api/repairs')).status, 401)
  assert.equal((await request('worker1', 'PATCH', `/api/repairs/${id}/status`, { status: '维修中' })).status, 401)
  assert.equal((await request('worker1', 'POST', '/api/auth/login', accounts.worker1)).status, 401)
  assert.equal((await request('admin', 'PATCH', `/api/admin/workers/${accounts.worker1.id}`, { is_active: 0 })).status, 200)
})

test('管理员派单和改派校验旧快照、目标账号、状态，竞争派单返回 409', async t => {
  const { request, seed, order, assign, accounts, db } = await setup(t)
  const id = seed()
  const initial = order(id)
  assert.equal((await request('admin', 'PATCH', `/api/repairs/${id}/assignment`, { assigned_worker_id: accounts.worker1.id })).status, 400)
  const races = await Promise.all([assign(id, 'worker1', initial), assign(id, 'worker2', initial)])
  assert.deepEqual(races.map(item => item.status).sort(), [200, 409])
  const first = order(id)
  assert.equal(first.status, '已接单')
  assert.equal(first.student_id, null)
  const next = first.assigned_worker_id === accounts.worker1.id ? 'worker2' : 'worker1'
  assert.equal((await assign(id, next)).status, 200)
  assert.equal((await assign(id, next)).status, 409)
  assert.equal((await assign(id, next, initial)).status, 409)
  const unassigned = seed()
  const snapshot = order(unassigned)
  for (const target of [accounts.student1.id, accounts.admin.id, 999999]) {
    assert.equal((await request('admin', 'PATCH', `/api/repairs/${unassigned}/assignment`, {
      assigned_worker_id: target, expected_status: snapshot.status, expected_assigned_worker_id: null,
    })).status, 400)
  }
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(accounts.worker1.id)
  assert.equal((await assign(unassigned, 'worker1')).status, 400)
  assert.deepEqual(order(unassigned), snapshot)
  for (const status of ['维修中', '已完成']) {
    const closed = seed({ status })
    const previous = order(closed)
    assert.equal((await request('admin', 'PATCH', `/api/repairs/${closed}/assignment`, {
      assigned_worker_id: accounts.worker2.id, expected_status: '已接单', expected_assigned_worker_id: null,
    })).status, 409)
    assert.deepEqual(order(closed), previous)
  }
})

test('历史工单不认领、不回退，管理员能分配待处理历史工单并读取历史评价', async t => {
  const { request, seed, assign, order, db } = await setup(t)
  const pending = seed()
  const inProgress = seed({ status: '维修中' })
  const done = seed({ status: '已完成', evaluation: true })
  const originalDone = order(done)
  const originalProgress = order(inProgress)
  const evaluations = db.prepare('SELECT * FROM evaluations').all()
  assert.equal((await request('student1', 'GET', '/api/repairs')).data.data.length, 0)
  assert.equal((await request('admin', 'GET', '/api/repairs')).data.data.length, 3)
  assert.equal((await request('admin', 'GET', `/api/repairs/${done}/evaluation`)).data.data.comment, '历史评价原文')
  assert.equal((await assign(pending, 'worker1')).status, 200)
  assert.equal(order(pending).student_id, null)
  assert.equal((await request('worker1', 'GET', `/api/repairs/${inProgress}`)).status, 404)
  assert.deepEqual(order(inProgress), originalProgress)
  assert.deepEqual(order(done), originalDone)
  assert.deepEqual(db.prepare('SELECT * FROM evaluations').all(), evaluations)
})

test('列表与统计在 SQL 层按角色过滤，维修统计排除公共待接单池', async t => {
  const { request, seed, db } = await setup(t)
  seed({ owner: 'student1', worker: 'worker1', status: '已完成' })
  seed({ owner: 'student1', worker: 'worker1', status: '已接单' })
  seed({ owner: 'student2', worker: 'worker2', status: '维修中' })
  seed({ owner: 'student2' })
  seed()
  seed({ status: '已完成' })
  // Observe actual SQL: fail if a list/statistics request attempts an unscoped order read.
  const originalPrepare = db.prepare
  const sqls = []
  db.prepare = function (sql) {
    if (/FROM repair_orders/i.test(sql)) {
      assert.equal(/WHERE /i.test(sql), true)
      sqls.push(sql)
    }
    return originalPrepare.call(this, sql)
  }
  try {
    for (const [actor, total, completed] of [['student1', 2, 1], ['student2', 2, 0], ['worker1', 2, 1], ['worker2', 1, 0], ['admin', 6, 2]]) {
      const result = await request(actor, 'GET', '/api/statistics?student_id=999&role=admin')
      assert.equal(result.status, 200)
      assert.equal(result.data.data.total, total)
      assert.equal(result.data.data.completed, completed)
      assert.equal(Object.values(result.data.data.statusDistribution).reduce((a, b) => a + b, 0), total)
      await request(actor, 'GET', '/api/repairs')
    }
    assert.equal(sqls.some(sql => /WHERE student_id = \?/i.test(sql)), true)
    assert.equal(sqls.some(sql => /WHERE assigned_worker_id = \?/i.test(sql)), true)
  } finally { db.prepare = originalPrepare }
})

test('所有业务写接口复用 Origin/专用请求头防护，凭据预检支持 PATCH', async t => {
  const { request, seed, accounts, base, order } = await setup(t)
  const id = seed({ owner: 'student1' })
  for (const [actor, method, path, body] of [
    ['student1', 'POST', '/api/repairs', {}],
    ['student1', 'POST', `/api/repairs/${id}/evaluation`, { rating: 5 }],
    ['worker1', 'POST', `/api/repairs/${id}/accept`, {}],
    ['worker1', 'PATCH', `/api/repairs/${id}/status`, { status: '已接单' }],
    ['admin', 'POST', '/api/admin/workers', testAccount('blocked_worker')],
    ['admin', 'PATCH', `/api/admin/workers/${accounts.worker1.id}`, { is_active: 0 }],
    ['admin', 'PATCH', `/api/repairs/${id}/assignment`, {
      assigned_worker_id: accounts.worker1.id, expected_status: '待处理', expected_assigned_worker_id: null,
    }],
  ]) {
    for (const headers of [{ Origin: '' }, { Origin: 'https://evil.example' }, { 'X-Auth-Request': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await request(actor, method, path, body, headers)).status, 403)
    }
  }
  assert.equal(order(id).status, '待处理')
  const response = await globalThis.fetch(base + `/api/repairs/${id}/status`, {
    method: 'OPTIONS', headers: { Origin: testOrigin, 'Access-Control-Request-Method': 'PATCH',
      'Access-Control-Request-Headers': 'Content-Type,X-Auth-Request' },
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), testOrigin)
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true')
  assert.equal(response.headers.get('access-control-allow-methods').includes('PATCH'), true)
})
