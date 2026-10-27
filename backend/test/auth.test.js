import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openDatabase, databasePath } from '../src/database.js'
import { migrateDatabase } from '../src/migrations.js'
import { createApp } from '../src/app.js'
import { hashPassword, verifyPassword, initializeAdmin } from '../src/accounts.js'
import { tokenDigest } from '../src/auth.js'

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'dorm-v2-test-')), 'test.sqlite')
const origin = 'http://localhost:5173'
// Random synthetic test credentials never appear in logs or command arguments.
const password = () => randomBytes(24).toString('hex')
const fixture = (username = 'student_01') => ({ username, display_name: '测试学生', password: password() })
const jsonRows = rows => rows.map(row => ({ ...row }))
function realFingerprint() {
  const directory = fileURLToPath(new URL('../data/', import.meta.url))
  return existsSync(directory) ? Object.fromEntries(readdirSync(directory).filter(name => name.startsWith('repairs.sqlite')).sort()
    .map(name => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')])) : {}
}
const before = realFingerprint()
test.after(() => assert.deepEqual(realFingerprint(), before, '正式数据库及其辅助文件必须保持不变'))

async function serve(t, options = {}) {
  const path = tempPath()
  const db = openDatabase(path)
  const server = createApp(db, { auth: { registerLimit: 100, loginLimit: 100, ...options } }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close() })
  const base = `http://127.0.0.1:${server.address().port}/api/auth`
  async function request(route, body, extra = {}) {
    const headers = { Origin: origin, 'X-Auth-Request': '1', 'Content-Type': 'application/json', ...extra.headers }
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', ...extra, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const data = await response.json()
    // Check keys rather than comparing secret values in assertion output.
    if (data.data) {
      assert.equal(Object.hasOwn(data.data, 'password_hash'), false)
      assert.equal(Object.hasOwn(data.data, 'token_hash'), false)
      assert.equal(Object.hasOwn(data.data, 'password'), false)
    }
    return { status: response.status, data, cookie: response.headers.get('set-cookie'), headers: response.headers }
  }
  return { db, path, request, base }
}
function cookiePair(cookie) {
  return cookie.split(';')[0]
}

test('空库初始化、重复迁移、归属外键及事务回滚', () => {
  const path = tempPath()
  let db = openDatabase(path)
  const first = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()
  migrateDatabase(db)
  assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(), first)
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 2)
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.equal(db.prepare('PRAGMA foreign_key_list(repair_orders)').all().length, 2)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").get().n, 5)
  db.close()
  db = openDatabase(path)
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0)
  db.close()

  // Force an index-name collision to prove all migration DDL is rolled back.
  db = new DatabaseSync(tempPath())
  db.exec('CREATE TABLE repair_orders(id INTEGER PRIMARY KEY); CREATE INDEX idx_sessions_user ON repair_orders(id)')
  assert.throws(() => migrateDatabase(db))
  assert.equal(db.isTransaction, false)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get(), undefined)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(), undefined)
  assert.equal(db.prepare('PRAGMA table_info(repair_orders)').all().length, 1)
  db.close()
})

test('V1 历史工单和评价逐字段保留，归属为 NULL，序列及约束不变', () => {
  const path = tempPath()
  let db = new DatabaseSync(path)
  // Reuse the actual V1 DDL from database.js, excluding the migration call.
  const source = readFileSync(new URL('../src/database.js', import.meta.url), 'utf8')
  db.exec(source.match(/db\.exec\(`([\s\S]*?)`\)/)[1])
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO repair_orders (id, order_no, building, room, category, description,
    contact_name, contact_phone, status, created_at, updated_at)
    VALUES (42, 'LEGACY-42', '3栋', '101', '水电', '旧描述', '旧联系人', '13800000000', '已完成', ?, ?)`).run(now, now)
  db.prepare("INSERT INTO evaluations (id, repair_order_id, rating, comment, created_at) VALUES (23, 42, 5, '旧评价', ?)").run(now)
  const orders = jsonRows(db.prepare('SELECT * FROM repair_orders').all())
  const evaluations = jsonRows(db.prepare('SELECT * FROM evaluations').all())
  const sequences = jsonRows(db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all())
  db.close()
  db = openDatabase(path)
  for (const [index, row] of db.prepare('SELECT * FROM repair_orders').all().entries()) {
    const { student_id, assigned_worker_id, ...original } = row
    assert.equal(student_id, null)
    assert.equal(assigned_worker_id, null)
    assert.deepEqual(original, orders[index])
  }
  assert.deepEqual(jsonRows(db.prepare('SELECT * FROM evaluations').all()), evaluations)
  assert.deepEqual(jsonRows(db.prepare("SELECT * FROM sqlite_sequence WHERE name IN ('repair_orders','evaluations') ORDER BY name").all()), sequences)
  assert.throws(() => db.prepare('UPDATE repair_orders SET student_id = 999 WHERE id = 42').run(), /FOREIGN KEY/)
  assert.throws(() => db.prepare('UPDATE repair_orders SET assigned_worker_id = 999 WHERE id = 42').run(), /FOREIGN KEY/)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  migrateDatabase(db)
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_orders').get().n, 1)
  db.close()
})

test('学生注册、独立盐、登录、会话摘要、刷新当前用户、轮换和退出', async t => {
  const { db, request, path } = await serve(t)
  const account = fixture()
  const registered = await request('/register', account)
  assert.equal(registered.status, 201)
  assert.equal(registered.data.data.role, 'student')
  const first = db.prepare('SELECT * FROM users WHERE id = ?').get(registered.data.data.id)
  assert.equal(first.password_hash.includes(account.password), false)
  assert.equal(await verifyPassword(account.password, first.password_hash), true)
  const hash2 = await hashPassword(account.password)
  assert.equal(hash2 === first.password_hash, false)
  assert.equal(await verifyPassword(password(), hash2), false)
  assert.equal(await verifyPassword(account.password, 'invalid'), false)
  assert.equal(registered.cookie, null)
  const login = await request('/login', account)
  assert.equal(login.status, 200)
  for (const pattern of [/HttpOnly/i, /SameSite=Lax/i, /Path=\/api(?:;|$)/i, /Max-Age=28800/i]) assert.equal(pattern.test(login.cookie), true)
  assert.equal(/; Secure/i.test(login.cookie), false)
  const cookie = cookiePair(login.cookie)
  const token = cookie.slice(cookie.indexOf('=') + 1)
  const stored = db.prepare('SELECT * FROM sessions').get()
  assert.equal(stored.token_hash === token, false)
  assert.equal(stored.token_hash === tokenDigest(token), true)
  const secondConnection = openDatabase(path)
  assert.equal(secondConnection.prepare('SELECT count(*) AS n FROM sessions').get().n, 1)
  secondConnection.close()
  assert.equal((await request('/me', undefined, { headers: { Cookie: cookie } })).status, 200)
  db.prepare("UPDATE users SET display_name = '新名字' WHERE id = ?").run(first.id)
  assert.equal((await request('/me', undefined, { headers: { Cookie: cookie } })).data.data.display_name, '新名字')
  const rotated = await request('/login', account, { headers: { Cookie: cookie } })
  assert.equal(rotated.status, 200)
  assert.equal((await request('/me', undefined, { headers: { Cookie: cookie } })).status, 401)
  const newCookie = cookiePair(rotated.cookie)
  const logout = await request('/logout', {}, { headers: { Cookie: newCookie } })
  assert.equal(logout.status, 200)
  assert.equal(/Expires=Thu, 01 Jan 1970/i.test(logout.cookie), true)
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0)
  assert.equal((await request('/me', undefined, { headers: { Cookie: newCookie } })).status, 401)
  assert.equal((await request('/logout', {})).status, 200)
})

test('重复账号、非法输入、角色伪造及并发重复注册', async t => {
  const { db, request } = await serve(t)
  const account = fixture()
  for (const body of [null, [], {}, { ...account, username: 'a' }, { ...account, username: 'bad user' },
    { ...account, password: 'short' }, { ...account, password: ' '.repeat(12) },
    { ...account, password: 'a'.repeat(129) }, { ...account, display_name: '' },
    { ...account, display_name: 'a'.repeat(51) }, { ...account, display_name: '\nname' },
    ...['admin', 'worker', null].map(role => ({ ...account, role }))]) {
    assert.equal((await request('/register', body)).status, 400)
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0)
  assert.equal((await request('/register', { ...account, username: 'Student_01' })).status, 201)
  assert.equal((await request('/register', account)).status, 409)
  const other = fixture('parallel_user')
  const parallel = await Promise.all([request('/register', other), request('/register', other)])
  assert.deepEqual(parallel.map(response => response.status).sort(), [201, 409])
  assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE role != 'student'").get().n, 0)
})

test('错误密码、无会话、过期、非法 Cookie、停用和停用后的登录', async t => {
  const { db, request } = await serve(t)
  const account = fixture()
  await request('/register', account)
  assert.equal((await request('/login', { ...account, password: password() })).status, 401)
  assert.equal((await request('/login', { username: 'missing', password: password() })).status, 401)
  for (const body of [null, [], {}, { username: {}, password: password() }]) assert.equal((await request('/login', body)).status, 400)
  assert.equal((await request('/me')).status, 401)
  assert.equal((await request('/me', undefined, { headers: { Cookie: 'dorm_session=%invalid' } })).status, 401)
  let login = await request('/login', account)
  let cookie = cookiePair(login.cookie)
  assert.equal((await request('/me', undefined, { headers: { Cookie: cookie + '; ' + cookie } })).status, 401)
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run()
  assert.equal((await request('/me', undefined, { headers: { Cookie: cookie } })).status, 401)
  login = await request('/login', account)
  cookie = cookiePair(login.cookie)
  db.prepare('UPDATE users SET is_active = 0').run()
  assert.equal((await request('/me', undefined, { headers: { Cookie: cookie } })).status, 401)
  assert.equal((await request('/login', account)).status, 401)
  assert.equal((await request('/logout', {}, { headers: { Cookie: cookie } })).status, 200)
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0)
})

test('Origin/专用请求头/JSON 防护、可信 CORS 和生产 Cookie', async t => {
  const { request, base } = await serve(t, { production: true, allowedOrigins: ['https://dorm.example.test'] })
  const account = fixture()
  for (const route of ['/register', '/login', '/logout']) {
    for (const headers of [{ Origin: '' }, { Origin: 'null' }, { Origin: 'https://evil.example' },
      { Origin: 'https://dorm.example.test.evil' }, { Origin: 'https://dorm.example.test', 'X-Auth-Request': '' },
      { Origin: 'https://dorm.example.test', 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await request(route, account, { headers })).status, 403)
    }
    const missing = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Request': '1' }, body: '{}' })
    assert.equal(missing.status, 403)
  }
  const headers = { Origin: 'https://dorm.example.test' }
  assert.equal((await request('/register', account, { headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await request('/register', account, { headers })).status, 201)
  const login = await request('/login', account, { headers })
  assert.equal(/; Secure/i.test(login.cookie), true)
  assert.equal(login.headers.get('access-control-allow-origin'), 'https://dorm.example.test')
  assert.equal(login.headers.get('access-control-allow-credentials'), 'true')
  assert.equal(login.headers.get('cache-control'), 'no-store')
  const preflight = await fetch(base + '/login', { method: 'OPTIONS', headers: { Origin: headers.Origin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type,X-Auth-Request' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), headers.Origin)
})

test('注册与登录独立限流，不信任伪造代理 IP', async t => {
  const { request } = await serve(t, { registerLimit: 1, loginLimit: 1, windowMs: 15 * 60 * 1000 })
  const account = fixture()
  assert.equal((await request('/register', account)).status, 201)
  const blocked = await request('/register', fixture('student_02'), { headers: { 'X-Forwarded-For': '192.0.2.123' } })
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1)
  assert.equal((await request('/login', account)).status, 200)
  assert.equal((await request('/login', account, { headers: { 'X-Forwarded-For': '192.0.2.124' } })).status, 429)
})

async function runAdmin(path, input, args = ['--stdin']) {
  const child = spawn(process.execPath, ['scripts/init-admin.js', ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, DB_PATH: path },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  child.stdin.on('error', () => {})
  const done = once(child, 'close')
  child.stdin.end(input)
  const [code] = await done
  return { code, output }
}

test('管理员仅本地初始化、DB_PATH、重复/停用管理员拒绝覆盖、CLI 不泄露密码', async () => {
  const path = tempPath()
  const account = fixture('admin_local')
  let result = await runAdmin(path, JSON.stringify(account))
  assert.equal(result.code, 0)
  assert.equal(result.output.includes(account.password), false)
  const db = openDatabase(path)
  try {
    const admin = { ...db.prepare("SELECT * FROM users WHERE role = 'admin'").get() }
    assert.equal(await verifyPassword(account.password, admin.password_hash), true)
    await assert.rejects(initializeAdmin(db, fixture('admin_second')), /管理员已存在/)
    result = await runAdmin(path, JSON.stringify({ ...account, password: password() }))
    assert.equal(result.code, 1)
    assert.deepEqual({ ...db.prepare("SELECT * FROM users WHERE role = 'admin'").get() }, admin)
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(admin.id)
    assert.equal((await runAdmin(path, JSON.stringify(fixture('another_admin')))).code, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").get().n, 1)
  } finally { db.close() }
  const otherPath = tempPath()
  assert.equal((await runAdmin(otherPath, 'invalid-json')).code, 1)
  assert.equal(existsSync(otherPath), false)
  assert.equal((await runAdmin(otherPath, '', ['--password=forbidden'])).code, 1)
  assert.equal(existsSync(otherPath), false)
  const conflictDb = openDatabase(tempPath())
  try {
    const existing = fixture('existing_user')
    conflictDb.prepare("INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, 'student', ?)")
      .run(existing.username, await hashPassword(existing.password), existing.display_name, new Date().toISOString())
    await assert.rejects(initializeAdmin(conflictDb, existing), /用户名已存在/)
    await assert.rejects(initializeAdmin(conflictDb, { ...existing, password: 'short' }), /密码/)
    assert.equal(conflictDb.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").get().n, 0)
  } finally { conflictDb.close() }
})

test('生产认证配置拒绝非 HTTPS 或通配来源', () => {
  const db = openDatabase(tempPath())
  try {
    for (const allowedOrigins of [['*'], ['http://dorm.example'], ['https://dorm.example/']]) {
      assert.throws(() => createApp(db, { auth: { production: true, allowedOrigins } }))
    }
  } finally { db.close() }
})

test('密码异步验证期间停用账号时不签发会话', async t => {
  const { db, request } = await serve(t)
  const account = fixture()
  await request('/register', account)
  let reached
  const started = new Promise(resolve => { reached = resolve })
  const originalPrepare = db.prepare
  db.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql)
    if (sql === 'SELECT * FROM users WHERE username = ?') {
      const get = statement.get.bind(statement)
      statement.get = (...args) => {
        const row = get(...args)
        reached()
        return row
      }
    }
    return statement
  }
  try {
    const pending = request('/login', account)
    await started
    db.prepare = originalPrepare
    db.prepare('UPDATE users SET is_active = 0').run()
    const result = await pending
    assert.equal(result.status, 401)
    assert.equal(result.cookie, null)
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0)
  } finally { db.prepare = originalPrepare }
})

test('业务 JSON 错误响应保留可信凭据 CORS，未登录优先 401', async t => {
  const { base, request } = await serve(t)
  const account = fixture()
  await request('/register', account)
  const login = await request('/login', account)
  const url = base.replace('/api/auth', '/api/repairs')
  const headers = { Origin: origin, 'X-Auth-Request': '1', 'Content-Type': 'application/json' }
  const anonymous = await fetch(url, { method: 'POST', headers, body: '{' })
  assert.equal(anonymous.status, 401)
  const response = await fetch(url, {
    method: 'POST', headers: { ...headers, Cookie: cookiePair(login.cookie) }, body: '{',
  })
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true')
})
