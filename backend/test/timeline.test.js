import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
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
test.after(() => assert.deepEqual(fingerprint(), before, '正式数据库及其辅助文件不得变化'))
const credentials = testAccount('timeline_fixture')
let passwordHash
test.before(async () => { passwordHash = await hashPassword(credentials.password) })
const rows = list => list.map(row => ({ ...row }))

async function setup(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'dorm-timeline-')), 'test.sqlite')
  const db = openDatabase(path)
  const users = {}
  for (const [username, role] of [['student', 'student'], ['other', 'student'], ['worker', 'worker'], ['worker2', 'worker'], ['admin', 'admin']]) {
    const result = db.prepare('INSERT INTO users(username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?)')
      .run(username, passwordHash, username + '显示名称', role, new Date().toISOString())
    users[username] = Number(result.lastInsertRowid)
  }
  const server = createApp(db, { auth: { loginLimit: 100 } }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close() })
  const base = 'http://127.0.0.1:' + server.address().port
  const clients = {}
  async function request(actor, method, path, body) {
    if (actor && !clients[actor]) clients[actor] = await loginClient(base, { username: actor, password: credentials.password })
    const response = await (actor ? clients[actor] : globalThis.fetch)(base + path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  const form = { building: '隐私宿舍', room: '101', category: '水电', description: '私人的故障描述',
    contact_name: '私人的联系人', contact_phone: '13800000000', actor_id: users.admin,
    occurred_at: '1900-01-01T00:00:00.000Z' }
  const create = async () => request('student', 'POST', '/api/repairs', form)
  const order = id => ({ ...db.prepare('SELECT * FROM repair_orders WHERE id=?').get(id) })
  const logs = id => rows(db.prepare('SELECT * FROM repair_logs WHERE repair_order_id=? ORDER BY id').all(id))
  const timeline = (actor, id) => request(actor, 'GET', '/api/repairs/' + id + '/timeline')
  const accept = (id, actor = 'worker') => request(actor, 'POST', '/api/repairs/' + id + '/accept', {})
  const advance = (id, status, actor = 'worker') => request(actor, 'PATCH', '/api/repairs/' + id + '/status', { status })
  const assign = (id, target, snapshot = order(id)) => request('admin', 'PATCH', '/api/repairs/' + id + '/assignment', {
    assigned_worker_id: users[target], expected_status: snapshot.status,
    expected_assigned_worker_id: snapshot.assigned_worker_id, expected_updated_at: snapshot.updated_at,
  })
  function seedLegacy() {
    const now = new Date().toISOString()
    const result = db.prepare(`INSERT INTO repair_orders(order_no,building,room,category,description,contact_name,contact_phone,status,created_at,updated_at)
      VALUES ('LEGACY-' || ?, '旧宿舍','101','水电','旧描述','旧联系人','13800000000','已完成',?,?)`).run(
        db.prepare('SELECT count(*) AS n FROM repair_orders').get().n, now, now)
    const id = Number(result.lastInsertRowid)
    db.prepare("INSERT INTO evaluations(repair_order_id,rating,comment,created_at) VALUES (?,5,'原历史评价',?)").run(id, now)
    return id
  }
  return { db, path, users, request, create, order, logs, timeline, accept, advance, assign, seedLegacy }
}

test('创建、接单、开始、完成产生真实事件，操作者与安全摘要由后端生成且持久化', async t => {
  const ctx = await setup(t)
  const { create, accept, advance, timeline, logs, users, db, path } = ctx
  const start = Date.now()
  const created = await create()
  assert.equal(created.status, 201)
  const id = created.body.data.id
  assert.equal((await accept(id)).status, 200)
  assert.equal((await advance(id, '维修中')).status, 200)
  assert.equal((await advance(id, '已完成')).status, 200)
  const result = (await timeline('student', id)).body.data
  assert.equal(result.history_incomplete, false)
  assert.equal(result.redacted, false)
  assert.deepEqual(result.events.map(event => event.event_type), ['created', 'accepted', 'started', 'completed'])
  assert.deepEqual(result.events.map(event => event.actor.id), [users.student, users.worker, users.worker, users.worker])
  assert.deepEqual(result.events.map(event => event.summary.to_status), ['待处理', '已接单', '维修中', '已完成'])
  for (const event of result.events) {
    assert.ok(Date.parse(event.occurred_at) >= start && Date.parse(event.occurred_at) <= Date.now())
    assert.equal(Object.hasOwn(event.summary, 'contact_phone'), false)
  }
  const serialized = JSON.stringify(result)
  for (const value of ['隐私宿舍', '私人的故障描述', '私人的联系人', '13800000000', 'password_hash', 'token_hash']) assert.equal(serialized.includes(value), false)
  db.prepare("UPDATE users SET display_name='新名称' WHERE id=?").run(users.worker)
  assert.equal((await timeline('student', id)).body.data.events[1].actor.display_name, 'worker显示名称')
  const reopened = openDatabase(path)
  try { assert.deepEqual(rows(reopened.prepare('SELECT * FROM repair_logs WHERE repair_order_id=? ORDER BY id').all(id)), logs(id)) }
  finally { reopened.close() }
})

test('管理员派单与改派追加独立事件，旧负责人和新负责人准确', async t => {
  const { create, assign, advance, timeline, users } = await setup(t)
  const id = (await create()).body.data.id
  assert.equal((await assign(id, 'worker')).status, 200)
  assert.equal((await assign(id, 'worker2')).status, 200)
  assert.equal((await advance(id, '维修中', 'worker2')).status, 200)
  assert.equal((await advance(id, '已完成', 'worker2')).status, 200)
  const events = (await timeline('admin', id)).body.data.events
  assert.deepEqual(events.map(event => event.event_type), ['created', 'assigned', 'reassigned', 'started', 'completed'])
  assert.equal(events[1].actor.id, users.admin)
  assert.deepEqual(events[2].summary, { from_status: '已接单', to_status: '已接单',
    from_worker_id: users.worker, to_worker_id: users.worker2 })
})

test('无效、越权、重复和竞争操作不产生虚假日志', async t => {
  const { create, accept, advance, assign, order, logs, request } = await setup(t)
  const id = (await create()).body.data.id
  const snapshot = order(id)
  assert.equal((await advance(id, '已完成')).status, 409)
  assert.equal((await request('other', 'POST', '/api/repairs', {})).status, 400)
  assert.equal((await request('student', 'PATCH', '/api/repairs/' + id + '/status', { status: '已接单' })).status, 403)
  assert.equal(logs(id).length, 1)
  const competition = await Promise.all([accept(id), accept(id, 'worker2')])
  assert.deepEqual(competition.map(result => result.status).sort(), [200, 409])
  assert.equal(logs(id).length, 2)
  assert.equal((await assign(id, 'worker2', snapshot)).status, 409)
  assert.equal(logs(id).length, 2)
})

test('日志写入故障时创建、接单、派单、改派、开始与完成均整体回滚', async t => {
  const { db, create, accept, assign, advance, order, logs } = await setup(t)
  const failLogs = () => db.exec("CREATE TEMP TRIGGER injected_log_failure BEFORE INSERT ON repair_logs BEGIN SELECT RAISE(ABORT,'injected log failure'); END")
  const restore = () => db.exec('DROP TRIGGER injected_log_failure')
  failLogs()
  assert.equal((await create()).status, 500)
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_orders').get().n, 0)
  assert.equal(db.isTransaction, false)
  restore()
  const id = (await create()).body.data.id
  async function rejected(action) {
    const previous = order(id), previousLogs = logs(id)
    failLogs()
    try {
      assert.equal((await action()).status, 500)
      assert.deepEqual(order(id), previous)
      assert.deepEqual(logs(id), previousLogs)
      assert.equal(db.isTransaction, false)
    } finally { restore() }
  }
  await rejected(() => accept(id))
  await rejected(() => assign(id, 'worker'))
  assert.equal((await assign(id, 'worker')).status, 200)
  await rejected(() => assign(id, 'worker2'))
  await rejected(() => advance(id, '维修中'))
  assert.equal((await advance(id, '维修中')).status, 200)
  await rejected(() => advance(id, '已完成'))
  assert.equal((await advance(id, '已完成')).status, 200)
})

test('时间轴复用工单权限，待接单池不返回学生、摘要或日志数量', async t => {
  const { create, timeline, accept, users } = await setup(t)
  const id = (await create()).body.data.id
  assert.equal((await timeline(null, id)).status, 401)
  assert.equal((await timeline('other', id)).status, 404)
  assert.equal((await timeline('student', 'abc')).status, 400)
  assert.equal((await timeline('admin', 999999)).status, 404)
  const pending = await timeline('worker', id)
  assert.equal(pending.status, 200)
  assert.deepEqual(pending.body.data, { events: [], redacted: true, history_incomplete: null })
  assert.equal(JSON.stringify(pending.body).includes(String(users.student) + ',"display_name"'), false)
  await accept(id)
  assert.equal((await timeline('worker', id)).body.data.events.length, 2)
  assert.equal((await timeline('worker2', id)).status, 404)
})

test('按事件时间与 ID 稳定排序，日志在数据库层只追加', async t => {
  const { db, create, timeline, users, logs } = await setup(t)
  const id = (await create()).body.data.id
  const insert = db.prepare(`INSERT INTO repair_logs(repair_order_id,event_type,actor_id,actor_display_name,actor_role,occurred_at,to_status)
    VALUES (?,'started',?,'测试操作者','worker',?,'维修中')`)
  const late = insert.run(id, users.worker, '2020-01-02T00:00:00.000Z').lastInsertRowid
  const first = insert.run(id, users.worker, '2020-01-01T00:00:00.000Z').lastInsertRowid
  const tied = insert.run(id, users.worker, '2020-01-01T00:00:00.000Z').lastInsertRowid
  const result = (await timeline('student', id)).body.data.events
  assert.deepEqual(result.slice(0, 3).map(event => event.id), [Number(first), Number(tied), Number(late)])
  assert.throws(() => db.prepare("UPDATE repair_logs SET event_type='completed' WHERE repair_order_id=?").run(id), /append-only/)
  assert.throws(() => db.prepare('DELETE FROM repair_logs WHERE repair_order_id=?').run(id), /append-only/)
  assert.equal(logs(id).length, 4)
})

test('旧版本升级和重复迁移保留工单、评价、账号及会话，不回填日志', async t => {
  const { db, seedLegacy, timeline } = await setup(t)
  const id = seedLegacy()
  await timeline('admin', id) // Establish a real SQLite session before the upgrade.
  const snapshot = {}
  for (const table of ['repair_orders', 'evaluations', 'users', 'sessions']) snapshot[table] = rows(db.prepare('SELECT * FROM ' + table).all())
  // This isolated fixture models the existing version-1 schema, never the real database.
  db.exec('DROP TABLE repair_logs; DELETE FROM schema_migrations WHERE version=2')
  migrateDatabase(db); migrateDatabase(db)
  for (const table of Object.keys(snapshot)) assert.deepEqual(rows(db.prepare('SELECT * FROM ' + table).all()), snapshot[table])
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_logs').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 2)
  const result = (await timeline('admin', id)).body.data
  assert.equal(result.history_incomplete, true)
  assert.deepEqual(result.events, [])
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('历史工单后续真实操作仍标注不完整，新增迁移失败时不留下半张日志表', async t => {
  const { db, seedLegacy, timeline, assign, order } = await setup(t)
  const id = seedLegacy()
  // Create a pending historical fixture without synthesizing any past event.
  db.prepare("UPDATE repair_orders SET status='待处理' WHERE id=?").run(id)
  assert.equal((await assign(id, 'worker')).status, 200)
  const result = (await timeline('admin', id)).body.data
  assert.equal(result.history_incomplete, true)
  assert.deepEqual(result.events.map(event => event.event_type), ['assigned'])
  assert.equal(order(id).student_id, null)
  const isolated = openDatabase(join(mkdtempSync(join(tmpdir(), 'dorm-log-rollback-')), 'rollback.sqlite'))
  try {
    isolated.exec('DROP TABLE repair_logs; DELETE FROM schema_migrations WHERE version=2; CREATE INDEX idx_repair_logs_order_time ON users(id)')
    assert.throws(() => migrateDatabase(isolated))
    assert.equal(isolated.prepare("SELECT name FROM sqlite_master WHERE name='repair_logs'").get(), undefined)
    assert.equal(isolated.prepare('SELECT version FROM schema_migrations WHERE version=2').get(), undefined)
    assert.equal(isolated.isTransaction, false)
  } finally { isolated.close() }
})
