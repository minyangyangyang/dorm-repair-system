import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { openDatabase } from '../../backend/src/database.js'
import { createApp } from '../../backend/src/app.js'
import { initializeAdmin, hashPassword } from '../../backend/src/accounts.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const realDir = join(root, 'backend/data')
const fingerprint = () => Object.fromEntries(readdirSync(realDir).filter(name => name.startsWith('repairs.sqlite')).sort()
  .map(name => [name, createHash('sha256').update(readFileSync(join(realDir, name))).digest('hex')]))
const original = fingerprint()
const work = mkdtempSync(join(tmpdir(), 'dorm-browser-'))
const secret = randomBytes(24).toString('hex')
const account = username => ({ username, password: secret, display_name: username })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const children = []
let db, backend, cdp
let checks = 0
function passed(label) { checks++; console.log('PASS ' + label) }
async function eventually(fn, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await delay(80) }
  throw new Error('等待失败：' + label)
}
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'ignore', ...options })
  children.push(child)
  child.on('error', () => {})
  return child
}
async function connect(url) {
  const ws = new WebSocket(url)
  await once(ws, 'open')
  let id = 0
  const awaiting = new Map()
  const listeners = new Map()
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const handler = awaiting.get(message.id)
      if (!handler) return
      awaiting.delete(message.id)
      message.error ? handler.reject(new Error('浏览器协议失败')) : handler.resolve(message.result)
    } else for (const handler of listeners.get(message.method) || []) handler(message.params)
  })
  return {
    ws,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id
        const timer = setTimeout(() => { awaiting.delete(requestId); reject(new Error('浏览器协议超时：' + method)) }, 15000)
        awaiting.set(requestId, { resolve: result => { clearTimeout(timer); resolve(result) }, reject: error => { clearTimeout(timer); reject(error) } })
        ws.send(JSON.stringify({ id: requestId, method, params }))
      })
    },
    on(method, handler) { const handlers = listeners.get(method) || []; handlers.push(handler); listeners.set(method, handlers) },
  }
}
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error('浏览器页面执行失败')
  return result.result.value
}
const q = JSON.stringify
const contains = text => evaluate('document.body.textContent.includes(' + q(text) + ')')
const waitText = text => eventually(() => contains(text), text)
async function click(selector, text) {
  const expression = '(() => {const element = Array.from(document.querySelectorAll(' + q(selector) + ')).find(node => ' +
    (text ? 'node.textContent.trim() === ' + q(text) : 'true') + '); if (!element || element.disabled) return false; element.click(); return true})()'
  await eventually(() => evaluate(expression), '可点击按钮')
  await delay(60)
}
async function fill(selector, value) {
  const ok = await evaluate('(() => {const element=document.querySelector(' + q(selector) + '); if(!element)return false;' +
    'const proto=element.tagName === "SELECT" ? HTMLSelectElement.prototype : element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;' +
    'Object.getOwnPropertyDescriptor(proto,"value").set.call(element,' + q(String(value)) + ');' +
    'element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input",{bubbles:true})); return true})()')
  assert.equal(ok, true)
}
async function login(username) {
  await eventually(() => evaluate('!!document.querySelector("#auth-username")'), '登录表单')
  await fill('#auth-username', username); await fill('#auth-password', secret)
  await click('form button[type=submit]')
  await eventually(() => evaluate('!!document.querySelector("nav")'), '登录成功')
}
async function logout() {
  await click('button', '退出登录')
  await eventually(() => evaluate('!!document.querySelector("#auth-username")'), '退出登录')
}
async function nav(text) { await click('nav button', text); await delay(150) }
function rowSelector(orderNo) {
  return 'Array.from(document.querySelectorAll("article.record")).find(row => row.querySelector(".record-id")?.textContent === ' + q(orderNo) + ')'
}
async function clickRow(orderNo, text) {
  await eventually(() => evaluate('(() => {const row=' + rowSelector(orderNo) + '; const button=row && Array.from(row.querySelectorAll("button")).find(item=>item.textContent.trim()===' + q(text) + ');if(!button||button.disabled)return false;button.click();return true})()'), '工单操作')
}
async function choosePhotos(paths) {
  const root=await cdp.send('DOM.getDocument')
  const node=await cdp.send('DOM.querySelector',{nodeId:root.root.nodeId,selector:'.photo-input'})
  await cdp.send('DOM.setFileInputFiles',{nodeId:node.nodeId,files:paths})
  await delay(100)
}
async function noOverflow() {
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true)
}
try {
  const photoFixtures=JSON.parse(readFileSync(join(root,'backend/test-support/photos.json'),'utf8'))
  const photoPaths=['PNG','JPEG','WEBP'].map(format=>{
    const path=join(work,'fixture.'+format.toLowerCase())
    writeFileSync(path,Buffer.from(photoFixtures[format],'base64'))
    return path
  })
  const frontendPort = await freePort()
  const origin = 'http://127.0.0.1:' + frontendPort
  const testDb = join(work, 'browser.sqlite')
  db = openDatabase(testDb)
  await initializeAdmin(db, account('browser_admin'))
  const other = db.prepare("INSERT INTO users(username,password_hash,display_name,role,created_at) VALUES (?,?,?,'student',?)")
    .run('browser_other', await hashPassword(secret), '其他学生', new Date().toISOString())
  function seed(orderNo, owner = null, description = '历史隐私内容') {
    const now = new Date().toISOString()
    return Number(db.prepare(`INSERT INTO repair_orders(order_no,building,room,category,description,contact_name,contact_phone,status,created_at,updated_at,student_id)
      VALUES (?,'隐私宿舍','隐私房间','水电',?,'隐私联系人','13800000000','待处理',?,?,?)`)
      .run(orderNo, description, now, now, owner).lastInsertRowid)
  }
  seed('OTHER-PRIVATE', Number(other.lastInsertRowid), '其他学生独有内容')
  seed('LEGACY-PENDING')
  const raceId = seed('RACE-PENDING')
  backend = createApp(db, { uploads: { directory: join(work, 'uploads') }, auth: { allowedOrigins: [origin], loginLimit: 100, registerLimit: 100 } }).listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const target = 'http://127.0.0.1:' + backend.address().port
  start(process.execPath, ['frontend/node_modules/vite/bin/vite.js', 'frontend', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
    env: { ...process.env, API_PROXY_TARGET: target },
  })
  console.log('独立联调数据库：' + testDb)
  console.log('联调服务：DB_PATH=' + testDb + '；Vite API_PROXY_TARGET=' + target + '；Origin=' + origin)
  await eventually(async () => { try { return (await fetch(origin)).ok } catch { return false } }, 'Vite 启动')
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
  if (!chrome) throw new Error('未找到可用浏览器')
  const profile = join(work, 'profile')
  start(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'])
  await eventually(() => existsSync(join(profile, 'DevToolsActivePort')), 'Chrome 启动')
  const debugPort = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]
  const tab = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?' + encodeURIComponent(origin), { method: 'PUT' })).json()
  cdp = await connect(tab.webSocketDebuggerUrl)
  let confirmations = 0
  const consoleErrors = []
  cdp.on('Runtime.exceptionThrown', () => consoleErrors.push('页面运行时异常'))
  cdp.on('Page.javascriptDialogOpening', () => { confirmations++; cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}) })
  await cdp.send('Runtime.enable')
  const trackUrls='(() => {window.__photoUrls=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=value=>{const url=create(value);window.__photoUrls.add(url);return url};URL.revokeObjectURL=url=>{window.__photoUrls.delete(url);revoke(url)}})()'
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:trackUrls})
  await evaluate(trackUrls)
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
  await eventually(() => evaluate('!!document.querySelector("#auth-username")'), '初始登录页')
  await noOverflow()
  await click('button', '没有学生账号？前往注册')
  await fill('#auth-username', 'browser_student'); await fill('#auth-name', '浏览器学生')
  await fill('#auth-password', secret); await fill('#auth-confirm', secret)
  await click('form button[type=submit]')
  await waitText('注册成功，请使用新账号登录。')
  await login('browser_student')
  await nav('提交报修')
  for (const [id, value] of Object.entries({ building: '3栋', room: '101', category: '水电', description: '浏览器维修流程', contact: '浏览器学生', phone: '13800000000' })) await fill('#' + id, value)
  await choosePhotos(photoPaths.slice(0,2))
  assert.equal(await evaluate('document.querySelectorAll(".photo-picker .photo-grid img").length'),2)
  await click('button','移除照片 2')
  await choosePhotos(photoPaths.slice(1))
  assert.equal(await evaluate('document.querySelectorAll(".photo-picker .photo-grid img").length'),3)
  await noOverflow()
  await click('form button[type=submit]')
  await waitText('工单已提交，照片上传成功。')
  await waitText('浏览器维修流程')
  assert.equal(await contains('OTHER-PRIVATE'), false)
  const order = db.prepare("SELECT * FROM repair_orders WHERE description='浏览器维修流程'").get()
  const student = db.prepare("SELECT id FROM users WHERE username='browser_student'").get()
  await clickRow(order.order_no, '查看详情')
  await waitText('维修进度时间轴'); await waitText('未完成')
  await eventually(()=>evaluate('document.querySelectorAll(".repair-photos .photo-thumbnail img").length === 3 && Array.from(document.querySelectorAll(".repair-photos img")).every(img=>img.complete && img.naturalWidth>0)'),'三格式照片显示')
  await click('button[aria-label="查看故障照片 1"]')
  await eventually(()=>evaluate('!!document.querySelector("dialog.photo-dialog[open] img")'),'照片大图')
  await click('button','关闭大图')
  await noOverflow()
  assert.equal(await evaluate('document.querySelector(".timeline-events")?.textContent.includes("浏览器学生")'), true)
  await clickRow(order.order_no, '收起详情')
  // Fail only timeline loading: the independent basic-detail request must still succeed.
  cdp.on('Fetch.requestPaused', event => {
    cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 503,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ success: false, message: '测试时间轴服务暂不可用' })).toString('base64') }).catch(() => {})
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*timeline', requestStage: 'Request' }] })
  await clickRow(order.order_no, '查看详情')
  await waitText('维修记录加载失败')
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".details-fields dd")).some(node=>node.textContent==="13800000000")'), true)
  await cdp.send('Fetch.disable')
  await click('button', '重试时间轴')
  await eventually(() => evaluate('!!document.querySelector(".timeline-events")'), '时间轴独立重试恢复')
  await cdp.send('Page.reload')
  await eventually(() => evaluate('!!document.querySelector("nav")'), '刷新恢复会话')
  await nav('我的工单'); await waitText(order.order_no); await noOverflow()
  passed('学生注册、登录、三格式照片预览移除上传、大图和手机布局')
  await nav('提交报修')
  for(const [id,value]of Object.entries({building:'3栋',room:'101',category:'水电',description:'照片上传失败的工单',contact:'浏览器学生',phone:'13800000000'}))await fill('#'+id,value)
  await choosePhotos([photoPaths[0]])
  db.exec("CREATE TEMP TRIGGER browser_attachment_failure BEFORE INSERT ON repair_attachments BEGIN SELECT RAISE(ABORT,'browser attachment failure'); END")
  await click('form button[type=submit]')
  await waitText('已提交，但照片上传失败')
  const partial=db.prepare("SELECT id FROM repair_orders WHERE description='照片上传失败的工单'").get()
  assert.ok(partial)
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_attachments WHERE repair_order_id=?').get(partial.id).n,0)
  db.exec('DROP TRIGGER browser_attachment_failure')
  await click('button','重试上传照片')
  await waitText('工单已提交，照片上传成功。')
  assert.equal(db.prepare("SELECT count(*) AS n FROM repair_orders WHERE description='照片上传失败的工单'").get().n,1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_attachments WHERE repair_order_id=?').get(partial.id).n,1)
  passed('工单成功与照片失败明确区分，重试不重复建单')
  await logout()
  assert.equal(await contains('浏览器维修流程'), false)
  assert.equal(await evaluate('window.__photoUrls.size'),0)
  passed('退出清空上一账号工单和图片对象 URL')

  await login('browser_admin')
  await click('nav button[data-page="messages"]')
  await waitText('有新的报修工单')
  await click('button', '标记已读')
  await click('button', '全部已读')
  await eventually(() => evaluate('document.querySelector(".notification-badge")?.textContent === "0"'), '管理员消息已读角标')
  await nav('维修人员')
  for (const username of ['browser_worker1', 'browser_worker2']) {
    await fill('#worker-username', username); await fill('#worker-name', username); await fill('#worker-password', secret)
    await click('form button[type=submit]')
    await eventually(() => evaluate('document.querySelector("#worker-username")?.value === ""'), '创建维修账号')
    await waitText(username)
  }
  const worker1 = db.prepare("SELECT id FROM users WHERE username='browser_worker1'").get().id
  const worker2 = db.prepare("SELECT id FROM users WHERE username='browser_worker2'").get().id
  await noOverflow()
  await nav('全部工单')
  async function assign(worker, label) {
    const set = '(() => {const row=' + rowSelector(order.order_no) + ';const select=row?.querySelector(".assignment-form select");if(!select)return false;select.value=' + q(String(worker)) + ';select.dispatchEvent(new Event("change",{bubbles:true}));return true})()'
    await eventually(() => evaluate(set), '派单选择')
    await clickRow(order.order_no, label)
    await eventually(() => db.prepare('SELECT assigned_worker_id FROM repair_orders WHERE id=?').get(order.id).assigned_worker_id === worker, label)
    await eventually(() => evaluate('!Array.from(document.querySelectorAll("button")).some(b => b.textContent.includes("正在提交"))'), '派单刷新')
    await delay(200)
  }
  await assign(worker1, '派单')
  await assign(worker2, '改派')
  assert.equal(db.prepare('SELECT status FROM repair_orders WHERE id=?').get(order.id).status, '已接单')
  await clickRow(order.order_no, '查看详情')
  await eventually(() => evaluate('document.querySelector(".timeline-events")?.textContent.includes("管理员改派")'), '派改日志')
  assert.deepEqual(db.prepare('SELECT event_type FROM repair_logs WHERE repair_order_id=? ORDER BY occurred_at,id').all(order.id).map(row=>row.event_type), ['created','assigned','reassigned'])
  passed('管理员创建维修账号、派单和携带快照改派、持久化时间轴')
  await logout()

  await login('browser_worker1')
  await click('nav button[data-page="messages"]')
  await waitText('维修任务已改派')
  await click('.notification-row button', '查看关联工单')
  await waitText('该工单已改派或当前账号无权查看')
  assert.equal(await evaluate('!!document.querySelector(".message-linked-order")'), false)
  await noOverflow()
  await logout()
  assert.equal(await evaluate('document.querySelectorAll(".notification-row").length'), 0)
  passed('原负责人收到改派消息但不能通过链接越权，退出清除消息')
  await login('browser_worker2')
  await click('nav button[data-page="messages"]')
  await waitText('收到改派任务')
  assert.equal(await contains('维修任务已改派'), false)
  await nav('待接单')
  assert.equal(await contains('隐私宿舍'), false)
  assert.equal(await contains('历史隐私内容'), false)
  await clickRow('LEGACY-PENDING', '接单')
  await nav('我的维修任务')
  await waitText('历史隐私内容')
  await clickRow('LEGACY-PENDING', '查看详情')
  await waitText('历史记录不完整')
  await eventually(() => evaluate('document.querySelector(".timeline-events")?.textContent.includes("维修人员接单")'), '历史工单只显示新增真实日志')
  await clickRow('LEGACY-PENDING', '收起详情')
  await clickRow(order.order_no, '查看详情')
  await eventually(() => evaluate('Array.from(document.querySelectorAll(".details-fields dd")).some(e=>e.textContent==="13800000000")'), '接单后完整详情')
  await clickRow(order.order_no, '开始维修')
  await eventually(() => db.prepare('SELECT status FROM repair_orders WHERE id=?').get(order.id).status === '维修中', '开始维修')
  await delay(250)
  await clickRow(order.order_no, '完成维修')
  await eventually(() => db.prepare('SELECT status FROM repair_orders WHERE id=?').get(order.id).status === '已完成', '完成维修')
  assert.equal(await contains('评价维修'), false)
  await nav('待接单'); await waitText('RACE-PENDING')
  db.prepare("UPDATE repair_orders SET status='已接单',assigned_worker_id=?,updated_at=? WHERE id=?").run(worker1, new Date().toISOString(), raceId)
  await clickRow('RACE-PENDING', '接单')
  await waitText('工单已变化：')
  await eventually(async () => !(await contains('RACE-PENDING')), '409 后刷新列表')
  await noOverflow()
  passed('维修接单、隐私隔离、详情、状态推进和 409 冲突刷新')
  await logout()

  await login('browser_student')
  await click('nav button[data-page="messages"]')
  await waitText('工单维修完成')
  await click('button', '刷新消息')
  await eventually(() => evaluate('document.querySelectorAll(".notification-row").length === 3'), '学生消息范围')
  await click('.notification-row button', '标记已读')
  await eventually(() => evaluate('document.querySelector(".notification-badge")?.textContent === "2"'), '单条已读')
  await click('button', '全部已读')
  await eventually(() => evaluate('document.querySelector(".notification-badge")?.textContent === "0"'), '全部已读')
  await click('.notification-row button', '查看关联工单')
  await waitText('关联工单 ' + order.order_no)
  await noOverflow()
  await nav('我的工单'); await waitText(order.order_no)
  await click('button', '评价维修')
  // First click selects 1 star; explicitly choose the fifth star for a 5-star evaluation.
  await evaluate('document.querySelectorAll(".star-options button")[4].click()')
  await fill('#evaluation-comment-' + order.id, '浏览器评价')
  await click('button', '提交评价')
  await waitText('维修评价提交成功')
  await nav('我的统计'); await waitText('完成率'); await noOverflow()
  assert.equal(db.prepare('SELECT count(*) AS n FROM evaluations WHERE repair_order_id=?').get(order.id).n, 1)
  await nav('我的工单')
  await clickRow(order.order_no, '查看详情')
  await eventually(() => evaluate('document.querySelector(".timeline-events")?.textContent.includes("维修完成")'), '完整维修时间轴')
  await noOverflow()
  assert.deepEqual(db.prepare('SELECT event_type FROM repair_logs WHERE repair_order_id=? ORDER BY occurred_at,id').all(order.id).map(row=>row.event_type),
    ['created','assigned','reassigned','started','completed'])
  passed('学生评价、统计、完整时间轴和手机布局')

  // Controlled test-fixture changes exercise real 403/404/401 responses; production rules are unchanged.
  await nav('提交报修')
  db.prepare("UPDATE users SET role='worker' WHERE id=?").run(student.id)
  for (const [id, value] of Object.entries({ building: '3栋', room: '101', category: '水电', description: '应被拒绝', contact: '学生', phone: '13800000000' })) await fill('#' + id, value)
  await click('form button[type=submit]'); await waitText('当前角色无权执行此操作')
  db.prepare("UPDATE users SET role='student' WHERE id=?").run(student.id)
  const privateId = seed('PRIVATE-404', student.id, '即将失去访问权')
  await nav('我的工单'); await click('button', '刷新工单'); await waitText('PRIVATE-404')
  db.prepare('UPDATE repair_orders SET student_id=? WHERE id=?').run(Number(other.lastInsertRowid), privateId)
  await clickRow('PRIVATE-404', '查看详情')
  await waitText('工单不存在')
  await eventually(() => evaluate('!document.querySelector(".record-id") || !Array.from(document.querySelectorAll(".record-id")).some(e=>e.textContent==="PRIVATE-404")'), '404 后刷新')
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(student.id)
  await click('button', '刷新工单')
  await eventually(() => evaluate('!!document.querySelector("#auth-username")'), '401 返回登录')
  assert.equal(await contains('浏览器维修流程'), false)
  passed('403/404 提示、401 清理身份和旧工单')

  await login('browser_admin'); await nav('维修人员')
  await evaluate('Array.from(document.querySelectorAll(".worker-row")).find(row=>row.textContent.includes("browser_worker1")).querySelector("button").click()')
  await eventually(() => db.prepare('SELECT is_active FROM users WHERE id=?').get(worker1).is_active === 0, '停用维修账号')
  assert.ok(confirmations > 0)
  await noOverflow()
  passed('管理员确认后停用维修账号')
  assert.deepEqual(consoleErrors, [])
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(work, 'mobile-admin.png'), Buffer.from(screenshot.data, 'base64'))
  console.log('浏览器联调通过：' + checks + ' 组；移动截图：' + join(work, 'mobile-admin.png'))
} finally {
  if (cdp) { try { await cdp.send('Browser.close') } catch {} cdp.ws.close() }
  for (const child of children.reverse()) if (child.exitCode === null) child.kill()
  if (backend) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)) }
  db?.close()
  assert.deepEqual(fingerprint(), original, '正式数据库及辅助文件必须保持不变')
}
