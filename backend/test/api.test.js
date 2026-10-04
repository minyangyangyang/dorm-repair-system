import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDatabase, databasePath } from '../src/database.js'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const port = 3107
const baseUrl = `http://localhost:${port}`

async function startServer() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd, env: { ...process.env, PORT: String(port) }, windowsHide: true,
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

test('真实服务器：校验、SQLite 写入、查询、重启持久化及数据库约束', { timeout: 30000 }, async () => {
  let server
  try {
    server = await startServer()
    assert.ok(existsSync(databasePath), '首次启动应自动创建数据库')
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
    const created = (await response.json()).data
    assert.equal(created.status, '待处理')
    assert.match(created.order_no, /^BX\d{8}-[\da-f-]{36}$/)
    assert.equal(created.created_at, created.updated_at)
    const listed = await (await fetch(`${baseUrl}/api/repairs`)).json()
    assert.deepEqual(listed.data[0], created)
    await stopServer(server)
    server = await startServer()
    const afterRestart = await (await fetch(`${baseUrl}/api/repairs`)).json()
    assert.deepEqual(afterRestart.data.find(order => order.id === created.id), created)
    await stopServer(server)
    server = null
    const db = openDatabase()
    try {
      assert.equal(db.prepare('SELECT * FROM repair_orders WHERE id = ?').get(created.id).order_no, created.order_no)
      assert.throws(() => db.prepare('UPDATE repair_orders SET status = ? WHERE id = ?').run('非法状态', created.id), /CHECK/)
      assert.throws(() => db.prepare('INSERT INTO repair_orders SELECT * FROM repair_orders WHERE id = ?').run(created.id), /UNIQUE/)
    } finally { db.close() }
    console.log(`测试通过，测试工单已保留在实际数据库中：${created.order_no}`)
  } finally { await stopServer(server) }
})
