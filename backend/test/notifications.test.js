import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openDatabase } from '../src/database.js'
import { migrateDatabase } from '../src/migrations.js'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/accounts.js'
import { loginClient, testAccount } from '../test-support/accounts.js'

const real = new URL('../data/', import.meta.url)
const fingerprint = () => Object.fromEntries(readdirSync(real).filter(name => name.startsWith('repairs.sqlite')).sort()
  .map(name => [name, createHash('sha256').update(readFileSync(new URL(name, real))).digest('hex')]))
const before = fingerprint()
test.after(() => assert.deepEqual(fingerprint(), before, '正式数据库及辅助文件不得修改'))
const credentials = testAccount('notification_fixture')
let passwordHash
test.before(async () => { passwordHash = await hashPassword(credentials.password) })
const rows = data => data.map(row => ({ ...row }))
async function setup(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'dorm-notifications-')), 'test.sqlite')
  const db = openDatabase(path)
  const users = {}
  for (const [name, role, active] of [['student', 'student', 1], ['other', 'student', 1],
    ['worker', 'worker', 1], ['worker2', 'worker', 1], ['admin', 'admin', 1], ['admin2', 'admin', 1], ['inactive_admin', 'admin', 0]]) {
    const result = db.prepare('INSERT INTO users(username,password_hash,display_name,role,is_active,created_at) VALUES (?,?,?,?,?,?)')
      .run(name, passwordHash, name, role, active, new Date().toISOString())
    users[name] = Number(result.lastInsertRowid)
  }
  const server = createApp(db, { auth: { loginLimit: 100 } }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close() })
  const base = 'http://127.0.0.1:' + server.address().port
  const clients = {}
  async function request(actor, method, path, body, headers = {}) {
    if (actor && !clients[actor]) clients[actor] = await loginClient(base, { username: actor, password: credentials.password })
    const response = await (actor ? clients[actor] : globalThis.fetch)(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, data: await response.json() }
  }
  const create = () => request('student', 'POST', '/api/repairs', { building: '秘密宿舍', room: '101', category: '水电',
    description: '秘密故障描述', contact_name: '秘密联系人', contact_phone: '13800000000' })
  const order = id => ({ ...db.prepare('SELECT * FROM repair_orders WHERE id=?').get(id) })
  const notices = (id, recipient) => rows(db.prepare('SELECT * FROM notifications WHERE repair_order_id=?' +
    (recipient === undefined ? '' : ' AND recipient_id=?') + ' ORDER BY id').all(...(recipient === undefined ? [id] : [id, users[recipient]])))
  const accept = id => request('worker', 'POST', '/api/repairs/' + id + '/accept', {})
  const advance = (id, status) => request('worker', 'PATCH', '/api/repairs/' + id + '/status', { status })
  const assign = (id, worker, snapshot = order(id)) => request('admin', 'PATCH', '/api/repairs/' + id + '/assignment', {
    assigned_worker_id: users[worker], expected_status: snapshot.status,
    expected_assigned_worker_id: snapshot.assigned_worker_id, expected_updated_at: snapshot.updated_at,
  })
  return { db, path, users, request, create, order, notices, accept, advance, assign }
}

test('新工单仅通知现有启用管理员，通知不包含私密字段且持久化', async t => {
  const { db, create, notices, users, path } = await setup(t)
  const result = await create()
  assert.equal(result.status, 201)
  const all = notices(result.data.data.id)
  assert.deepEqual(all.map(item => item.recipient_id).sort((a,b)=>a-b), [users.admin, users.admin2])
  assert.equal(all.every(item => item.event_type === 'created' && item.read_at === null), true)
  for (const value of ['秘密宿舍', '秘密故障描述', '秘密联系人', '13800000000', credentials.password, 'password_hash', 'token_hash']) {
    assert.equal(JSON.stringify(all).includes(value), false)
  }
  const reopened = openDatabase(path)
  try { assert.deepEqual(rows(reopened.prepare('SELECT * FROM notifications ORDER BY id').all()), all) } finally { reopened.close() }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('接单、开始维修、完成分别通知工单学生，不向维修人员发送自身操作消息', async t => {
  const { create, accept, advance, notices } = await setup(t)
  const id = (await create()).data.data.id
  assert.equal((await accept(id)).status, 200)
  assert.equal((await advance(id, '维修中')).status, 200)
  assert.equal((await advance(id, '已完成')).status, 200)
  assert.deepEqual(notices(id, 'student').map(item => item.event_type), ['accepted', 'started', 'completed'])
  assert.equal(notices(id, 'student')[2].content.includes('评价'), true)
  assert.deepEqual(notices(id, 'worker'), [])
  assert.equal(notices(id, 'other').length, 0)
})

test('派单同时通知学生与新负责人，改派通知原负责人和新负责人', async t => {
  const { create, assign, notices, users, request } = await setup(t)
  const id = (await create()).data.data.id
  assert.equal((await assign(id, 'worker')).status, 200)
  assert.deepEqual(notices(id, 'student').map(item => item.event_type), ['assigned'])
  assert.deepEqual(notices(id, 'worker').map(item => item.event_type), ['assigned'])
  assert.equal((await assign(id, 'worker2')).status, 200)
  const changed = notices(id).filter(item => item.event_type === 'reassigned')
  assert.deepEqual(changed.map(item => item.recipient_id).sort((a,b)=>a-b), [users.worker, users.worker2])
  assert.equal(notices(id, 'student').length, 1)
  assert.equal(changed.find(item => item.recipient_id === users.worker).content.includes('不再负责'), true)
  assert.equal((await request('worker', 'GET', '/api/repairs/' + id)).status, 404)
  assert.equal((await request('worker2', 'GET', '/api/repairs/' + id)).status, 200)
})

test('重复、竞争、非法或越权业务操作不新增通知', async t => {
  const { db, create, accept, assign, advance, notices, request, order } = await setup(t)
  const id = (await create()).data.data.id
  const snapshot = order(id)
  const baseline = notices(id)
  assert.equal((await advance(id, '已完成')).status, 409)
  assert.equal((await request('student', 'POST', '/api/repairs/' + id + '/accept', {})).status, 403)
  assert.deepEqual(notices(id), baseline)
  const result = await Promise.all([accept(id), accept(id)])
  assert.deepEqual(result.map(item => item.status).sort(), [200,409])
  assert.equal(notices(id, 'student').length, 1)
  const after = notices(id)
  assert.equal((await assign(id, 'worker2', snapshot)).status, 409)
  assert.equal((await accept(id)).status, 409)
  assert.deepEqual(notices(id), after)
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n, after.length)
})

test('通知写入故障使创建、接单、派单、改派、开始、完成及日志一起回滚', async t => {
  const { db, create, accept, assign, advance, order, notices } = await setup(t)
  const fail = () => db.exec("CREATE TEMP TRIGGER injected_notice_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected notification failure'); END")
  const restore = () => db.exec('DROP TRIGGER injected_notice_failure')
  fail()
  assert.equal((await create()).status, 500)
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_orders').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_logs').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n, 0)
  restore()
  const id = (await create()).data.data.id
  async function rejected(action) {
    const previous = order(id), previousNotices = notices(id)
    const previousLogs = rows(db.prepare('SELECT * FROM repair_logs ORDER BY id').all())
    fail()
    try {
      assert.equal((await action()).status, 500)
      assert.deepEqual(order(id), previous)
      assert.deepEqual(notices(id), previousNotices)
      assert.deepEqual(rows(db.prepare('SELECT * FROM repair_logs ORDER BY id').all()), previousLogs)
      assert.equal(db.isTransaction, false)
    } finally { restore() }
  }
  await rejected(() => accept(id)); await rejected(() => assign(id, 'worker'))
  await assign(id, 'worker')
  await rejected(() => assign(id, 'worker2'))
  await rejected(() => advance(id, '维修中'))
  await advance(id, '维修中')
  await rejected(() => advance(id, '已完成'))
})

test('通知列表、未读数和标记严格限定本人，已读及全部已读均幂等', async t => {
  const { create, accept, advance, request } = await setup(t)
  const id = (await create()).data.data.id
  await accept(id); await advance(id, '维修中'); await advance(id, '已完成')
  const list = await request('student', 'GET', '/api/notifications?recipient_id=999&user_id=999')
  assert.equal(list.status, 200)
  assert.equal(list.data.data.items.length, 3)
  const item = list.data.data.items[0]
  assert.equal((await request('student', 'GET', '/api/notifications/unread-count')).data.data.count, 3)
  assert.equal((await request('other', 'GET', '/api/notifications')).data.data.items.length, 0)
  assert.equal((await request('other', 'GET', '/api/notifications/unread-count')).data.data.count, 0)
  assert.equal((await request('other', 'PATCH', '/api/notifications/' + item.id + '/read', {})).status, 404)
  assert.equal((await request('admin', 'PATCH', '/api/notifications/' + item.id + '/read', {})).status, 404)
  const first = await request('student', 'PATCH', '/api/notifications/' + item.id + '/read', {})
  const repeated = await request('student', 'PATCH', '/api/notifications/' + item.id + '/read', {})
  assert.equal(first.status, 200)
  assert.equal(first.data.data.read_at, repeated.data.data.read_at)
  assert.equal((await request('student', 'GET', '/api/notifications/unread-count')).data.data.count, 2)
  assert.equal((await request('student', 'PATCH', '/api/notifications/read-all', { recipient_id: 999 })).data.data.updated, 2)
  assert.equal((await request('student', 'PATCH', '/api/notifications/read-all', {})).data.data.updated, 0)
  assert.equal((await request('admin', 'GET', '/api/notifications/unread-count')).data.data.count, 1)
})

test('分页按时间与 ID 稳定排序，数量有界；匿名、CSRF 和任意创建通知均被拒绝', async t => {
  const { db, create, request } = await setup(t)
  for (let i=0;i<3;i++) await create()
  db.prepare("UPDATE notifications SET created_at='2020-01-01T00:00:00.000Z'").run()
  const first = await request('admin', 'GET', '/api/notifications?page=1&limit=2')
  const second = await request('admin', 'GET', '/api/notifications?page=2&limit=2')
  assert.equal(first.data.data.items.length, 2)
  assert.equal(first.data.data.has_more, true)
  assert.equal(second.data.data.items.length, 1)
  assert.equal(second.data.data.has_more, false)
  const ids = [...first.data.data.items, ...second.data.data.items].map(item => item.id)
  assert.deepEqual(ids, [...ids].sort((a,b)=>b-a))
  for (const query of ['limit=0','limit=51','limit=2.5','page=0','page=1001','page=abc']) {
    assert.equal((await request('admin', 'GET', '/api/notifications?' + query)).status, 400)
  }
  for (const [method,path] of [['GET','/api/notifications'],['GET','/api/notifications/unread-count'],
    ['PATCH','/api/notifications/1/read'],['PATCH','/api/notifications/read-all']]) {
    assert.equal((await request(null, method, path, method === 'PATCH' ? {} : undefined)).status, 401)
  }
  const id = first.data.data.items[0].id
  assert.equal((await request('admin','PATCH','/api/notifications/' + id + '/read',{}, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await request('admin','PATCH','/api/notifications/read-all',{}, { 'X-Auth-Request': '' })).status, 403)
  assert.equal((await request('admin','PATCH','/api/notifications/abc/read',{})).status, 400)
  assert.equal((await request('admin','POST','/api/notifications',{ title:'伪造消息' })).status, 404)
})

test('历史无归属、错误角色和停用用户不会收到学生通知', async t => {
  const { db, users, create, accept, notices, assign } = await setup(t)
  const id = (await create()).data.data.id
  db.prepare('UPDATE repair_orders SET student_id=NULL WHERE id=?').run(id)
  await accept(id)
  assert.equal(notices(id,'student').length, 0)
  const next = (await create()).data.data.id
  db.prepare('UPDATE repair_orders SET student_id=? WHERE id=?').run(users.worker2, next)
  await assign(next, 'worker')
  assert.equal(notices(next,'worker2').length, 0)
  const stopped = (await create()).data.data.id
  db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(users.student)
  await accept(stopped)
  assert.equal(notices(stopped,'student').length, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications WHERE recipient_id=?').get(users.inactive_admin).n, 0)
})

test('版本 2 升级不补发历史通知，重复迁移保留原工单、评价、日志、账号和会话', async t => {
  const { db, create, accept } = await setup(t)
  const id = (await create()).data.data.id
  await accept(id)
  db.exec('DROP TABLE notifications; DELETE FROM schema_migrations WHERE version=3')
  const snapshot = {}
  for (const table of ['repair_orders','evaluations','repair_logs','users','sessions']) snapshot[table] = rows(db.prepare('SELECT * FROM ' + table).all())
  migrateDatabase(db); migrateDatabase(db)
  for (const table of Object.keys(snapshot)) assert.deepEqual(rows(db.prepare('SELECT * FROM ' + table).all()), snapshot[table])
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 4)
  db.exec('DROP TABLE notifications; DELETE FROM schema_migrations WHERE version=3; CREATE INDEX idx_notifications_recipient_time ON users(id)')
  assert.throws(() => migrateDatabase(db))
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='notifications'").get(), undefined)
  assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version=3').get(), undefined)
  assert.equal(db.isTransaction, false)
})
