import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openDatabase, databasePath } from '../src/database.js'
import { createApp } from '../src/app.js'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const port = 3107
const baseUrl = `http://localhost:${port}`

async function startServer(testDatabasePath) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd, env: { ...process.env, PORT: String(port), DB_PATH: testDatabasePath }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务器启动超时：${output}`)), 10000)
      const finish = callback => { clearTimeout(timer); callback() }
      child.stdout.on('data', chunk => {
        output += chunk.toString()
        if (output.includes('后端启动成功')) finish(resolve)
      })
      child.stderr.on('data', chunk => { output += chunk.toString() })
      child.once('error', error => finish(() => reject(error)))
      child.once('exit', code => finish(() => reject(new Error(`服务器提前退出 ${code}：${output}`))))
    })
    return child
  } catch (error) {
    if (child.exitCode === null) child.kill()
    throw error
  }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

test('统计接口：空库、零值字段、SQL 真实数量、实时更新及异常恢复', async () => {
  const testPath = join(mkdtempSync(join(tmpdir(), 'dorm-statistics-test-')), 'repairs.sqlite')
  const db = openDatabase(testPath)
  const server = createApp(db).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/api/statistics`
  const states = ['待处理', '已接单', '维修中', '已完成']
  const categories = ['水电', '家具', '网络', '门窗', '其他']
  try {
    const emptyResponse = await fetch(url)
    assert.equal(emptyResponse.status, 200)
    const empty = await emptyResponse.json()
    assert.equal(empty.success, true)
    assert.deepEqual(empty.data, {
      total: 0, completed: 0, completionRate: 0,
      statusDistribution: Object.fromEntries(states.map(state => [state, 0])),
      categoryDistribution: Object.fromEntries(categories.map(category => [category, 0])),
    })
    const insert = db.prepare(`INSERT INTO repair_orders
      (order_no, building, room, category, description, contact_name, contact_phone, status, created_at, updated_at)
      VALUES (?, '测试楼', '101', ?, '统计测试', '测试同学', '13800000000', ?, ?, ?)`)
    // 固定测试数据仅用于验证期望值，不进入正式数据库或业务 API。
    const fixtures = [['水电', '待处理'], ['水电', '已接单'], ['家具', '已完成'], ['网络', '已完成'], ['门窗', '待处理'], ['家具', '待处理']]
    fixtures.forEach(([category, state], index) => insert.run(`STAT-${index}`, category, state, new Date().toISOString(), new Date().toISOString()))
    const data = (await (await fetch(url)).json()).data
    const actualOrders = db.prepare('SELECT status, category FROM repair_orders').all()
    assert.equal(data.total, db.prepare('SELECT COUNT(*) AS count FROM repair_orders').get().count)
    for (const state of states) assert.equal(data.statusDistribution[state], actualOrders.filter(order => order.status === state).length)
    for (const category of categories) assert.equal(data.categoryDistribution[category], actualOrders.filter(order => order.category === category).length)
    assert.equal(data.statusDistribution['维修中'], 0)
    assert.equal(data.categoryDistribution['其他'], 0)
    assert.equal(Object.values(data.statusDistribution).reduce((sum, count) => sum + count, 0), data.total)
    assert.equal(Object.values(data.categoryDistribution).reduce((sum, count) => sum + count, 0), data.total)
    assert.equal(data.completed, data.statusDistribution['已完成'])
    assert.equal(data.completionRate, 33.33)
    insert.run('STAT-new', '其他', '维修中', new Date().toISOString(), new Date().toISOString())
    const latest = (await (await fetch(url)).json()).data
    assert.equal(latest.total, 7)
    assert.equal(latest.statusDistribution['维修中'], 1)
    assert.equal(latest.categoryDistribution['其他'], 1)
    assert.equal(latest.completionRate, 28.57)
    db.exec('DROP TABLE evaluations; DROP TABLE repair_orders') // 仅故障注入到独立测试库。
    const failed = await fetch(url)
    assert.equal(failed.status, 500)
    assert.deepEqual(await failed.json(), { success: false, message: '服务器处理失败，请稍后重试' })
    assert.equal(db.isTransaction, false, '失败后应回滚只读事务')
    assert.equal((await fetch(url.replace('/statistics', '/health'))).status, 200, '数据库查询异常不得终止服务')
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    db.close()
  }
})

test('真实服务器：校验、SQLite 写入、查询、重启持久化及数据库约束', { timeout: 30000 }, async () => {
  const testDatabasePath = join(mkdtempSync(join(tmpdir(), 'dorm-api-test-')), 'repairs.sqlite')
  const fingerprint = () => existsSync(databasePath) ? createHash('sha256').update(readFileSync(databasePath)).digest('hex') : null
  const originalFingerprint = fingerprint()
  let server
  try {
    server = await startServer(testDatabasePath)
    assert.ok(existsSync(testDatabasePath), '首次启动应自动创建测试数据库')
    const health = await fetch(`${baseUrl}/api/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).message, '宿舍报修系统后端运行正常')
    assert.equal(health.headers.get('access-control-allow-origin'), '*')
    const initial = await (await fetch(`${baseUrl}/api/repairs`)).json()
    const payload = {
      building: '测试宿舍楼', room: '301', category: '水电',
      description: '后端自动测试工单：水龙头漏水，可用于验证持久化。',
      contact_name: '测试同学', contact_phone: '13800000000',
      status: '已完成', order_no: '客户端不能指定编号',
    }
    const post = body => fetch(`${baseUrl}/api/repairs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    for (const invalid of [
      { ...payload, description: '' }, { ...payload, description: '   ' },
      { ...payload, building: null }, { ...payload, contact_phone: '123' },
      { ...payload, category: '非法类别' }, { ...payload, description: '字'.repeat(501) }, [],
    ]) {
      const response = await post(invalid)
      assert.equal(response.status, 400)
      assert.equal((await response.json()).success, false)
    }
    const malformed = await fetch(`${baseUrl}/api/repairs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).message, 'JSON 格式错误，请检查请求内容')
    const unsupported = await fetch(`${baseUrl}/api/repairs`, { method: 'POST', body: 'text' })
    assert.equal(unsupported.status, 415)
    const beforeCreate = await (await fetch(`${baseUrl}/api/repairs`)).json()
    assert.equal(beforeCreate.data.length, initial.data.length, '非法请求不能写入数据')
    const response = await post(payload)
    assert.equal(response.status, 201)
    let created = (await response.json()).data
    assert.equal(created.status, '待处理')
    assert.match(created.order_no, /^BX\d{8}-[\da-f-]{36}$/)
    assert.equal(created.created_at, created.updated_at)
    const listed = await (await fetch(`${baseUrl}/api/repairs`)).json()
    assert.deepEqual(listed.data[0], created)
    const patch = (id, status) => fetch(`${baseUrl}/api/repairs/${id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
    })
    const evaluate = (id, body = { rating: 5, comment: '维修很及时，问题已经解决。' }) => fetch(`${baseUrl}/api/repairs/${id}/evaluation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const getEvaluation = id => fetch(`${baseUrl}/api/repairs/${id}/evaluation`)
    const emptyEvaluation = await getEvaluation(created.id)
    assert.equal(emptyEvaluation.status, 200)
    assert.equal((await emptyEvaluation.json()).data, null)
    // 遍历每一阶段的所有目标状态：除唯一下一步外，一律拒绝。
    const stages = ['待处理', '已接单', '维修中', '已完成']
    for (let index = 0; index < stages.length; index++) {
      if (index < 3) {
        const unfinished = await evaluate(created.id)
        assert.equal(unfinished.status, 409, `${stages[index]}工单不可评价`)
        assert.equal((await getEvaluation(created.id)).status, 200)
        assert.equal((await (await getEvaluation(created.id)).json()).data, null)
      }
      for (const target of stages.filter(status => status !== stages[index + 1])) {
        const rejected = await patch(created.id, target)
        assert.equal(rejected.status, 409, `${created.status} → ${target} 应拒绝`)
        assert.equal((await rejected.json()).success, false)
      }
      const invalidStatus = await patch(created.id, '未知状态')
      assert.equal(invalidStatus.status, 400)
      const unchanged = (await (await fetch(`${baseUrl}/api/repairs`)).json()).data.find(item => item.id === created.id)
      assert.deepEqual(unchanged, created, '非法操作不得更改状态或更新时间')
      if (index < stages.length - 1) {
        const success = await patch(created.id, stages[index + 1])
        assert.equal(success.status, 200)
        const updated = (await success.json()).data
        assert.equal(updated.status, stages[index + 1])
        assert.ok(Date.parse(updated.updated_at) > Date.parse(created.updated_at))
        assert.deepEqual({ ...updated, status: created.status, updated_at: created.updated_at }, created)
        created = updated
      }
    }
    const missing = await patch(9007199254740991, '已接单')
    assert.equal(missing.status, 404)
    const invalidId = await patch('abc', '已接单')
    assert.equal(invalidId.status, 400)
    // 两个同时发出的相同操作只有一个成功，另一个不能重复推进。
    const concurrentOrder = (await (await post(payload)).json()).data
    const concurrent = await Promise.all([patch(concurrentOrder.id, '已接单'), patch(concurrentOrder.id, '已接单')])
    assert.deepEqual(concurrent.map(item => item.status).sort(), [200, 409])
    for (const rating of [0, 6, -1, 3.5, 'abc', '5', null, undefined]) {
      const invalid = await evaluate(created.id, { rating })
      assert.equal(invalid.status, 400)
      assert.equal((await invalid.json()).message, '评分必须为 1～5 的整数')
    }
    for (const comment of [null, 123, {}, [], '字'.repeat(501)]) {
      assert.equal((await evaluate(created.id, { rating: 5, comment })).status, 400)
    }
    for (const body of [null, [], 'text']) assert.equal((await evaluate(created.id, body)).status, 400)
    assert.equal((await evaluate('abc')).status, 400)
    assert.equal((await getEvaluation('abc')).status, 400)
    assert.equal((await evaluate(9007199254740991)).status, 404)
    assert.equal((await getEvaluation(9007199254740991)).status, 404)
    const submittedEvaluation = await evaluate(created.id)
    assert.equal(submittedEvaluation.status, 201)
    const evaluation = (await submittedEvaluation.json()).data
    assert.equal(evaluation.repair_order_id, created.id)
    assert.equal(evaluation.rating, 5)
    assert.equal(evaluation.comment, '维修很及时，问题已经解决。')
    assert.ok(evaluation.created_at)
    assert.deepEqual((await (await getEvaluation(created.id)).json()).data, evaluation)
    assert.equal((await evaluate(created.id)).status, 409)
    // 无文字和边界评分也合法，重复并发提交只能成功一次。
    await patch(concurrentOrder.id, '维修中')
    await patch(concurrentOrder.id, '已完成')
    const parallelEvaluations = await Promise.all([evaluate(concurrentOrder.id, { rating: 1 }), evaluate(concurrentOrder.id, { rating: 1 })])
    assert.deepEqual(parallelEvaluations.map(item => item.status).sort(), [201, 409])
    assert.equal((await (await getEvaluation(concurrentOrder.id)).json()).data.comment, '')
    await stopServer(server)
    server = await startServer(testDatabasePath)
    const afterRestart = await (await fetch(`${baseUrl}/api/repairs`)).json()
    assert.deepEqual(afterRestart.data.find(order => order.id === created.id), created)
    assert.equal(created.status, '已完成', '重启后必须仍为已完成')
    assert.deepEqual((await (await getEvaluation(created.id)).json()).data, evaluation, '重启后评价仍保留')
    await stopServer(server)
    server = null
    const db = openDatabase(testDatabasePath)
    try {
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
      assert.deepEqual({ ...db.prepare('SELECT * FROM evaluations WHERE repair_order_id = ?').get(created.id) }, evaluation)
      assert.equal(db.prepare('SELECT count(*) AS total FROM evaluations WHERE repair_order_id = ?').get(created.id).total, 1)
      assert.throws(() => db.prepare('INSERT INTO evaluations (repair_order_id, rating, created_at) VALUES (?, 5, ?)').run(created.id, evaluation.created_at), /UNIQUE/)
      assert.throws(() => db.prepare('INSERT INTO evaluations (repair_order_id, rating, created_at) VALUES (?, 5, ?)').run(9007199254740991, evaluation.created_at), /FOREIGN KEY/)
      assert.throws(() => db.prepare('UPDATE evaluations SET rating = 3.5 WHERE id = ?').run(evaluation.id), /CHECK/)
      assert.throws(() => db.prepare('UPDATE evaluations SET rating = 6 WHERE id = ?').run(evaluation.id), /CHECK/)
      assert.throws(() => db.prepare('UPDATE evaluations SET comment = ? WHERE id = ?').run('字'.repeat(501), evaluation.id), /CHECK/)
      for (const previous of initial.data) assert.deepEqual({ ...db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(previous.id) }, previous, '已有工单不能被改变')
      assert.equal(db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(created.id).order_no, created.order_no)
      assert.throws(() => db.prepare('UPDATE repair_orders SET status = ? WHERE id = ?').run('非法状态', created.id), /CHECK/)
      assert.throws(() => db.prepare('INSERT INTO repair_orders SELECT * FROM repair_orders WHERE id = ?').run(created.id), /UNIQUE/)
    } finally { db.close() }
    console.log(`测试通过，独立测试数据库：${testDatabasePath}`)
  } finally {
    await stopServer(server)
    assert.equal(fingerprint(), originalFingerprint, '自动测试不得改变正式数据库文件')
  }
})
