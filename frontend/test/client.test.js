import { analyzeRepair } from '../src/api/ai.js'
import { uploadAttachments, getAttachmentBlob } from '../src/api/attachments.js'
import { getNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead } from '../src/api/notifications.js'
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

test('消息 API 使用本人接口、分页、凭据和统一写防护', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => { calls.push({url, options}); return response(200, {success:true, data:{items:[],count:0}}) }
  try {
    await getNotifications(2,20); await getUnreadCount(); await markNotificationRead(42); await markAllNotificationsRead()
    assert.deepEqual(calls.map(call=>call.url), ['/api/notifications?page=2&limit=20','/api/notifications/unread-count',
      '/api/notifications/42/read','/api/notifications/read-all'])
    assert.equal(calls.every(call=>call.options.credentials === 'include'),true)
    for (const call of calls.slice(2)) {
      assert.equal(call.options.method,'PATCH')
      assert.equal(call.options.headers['X-Auth-Request'],'1')
      assert.deepEqual(JSON.parse(call.options.body),{})
    }
    for (const path of ['/notifications','/notifications/unread-count']) {
      let finish
      globalThis.fetch = () => new Promise(resolve=>{finish=resolve})
      const pending = request(path)
      const rejected = assert.rejects(pending,error=>error.code === 'STALE')
      resetRequests()
      finish(response(200,{success:true,data:{items:[{title:'旧账号消息'}],count:99}}))
      await rejected
    }
  } finally { globalThis.fetch=original; resetRequests() }
})

test('照片上传与二进制读取沿用凭据和防护，编码后仍检查账号代数',async()=>{
  const original=globalThis.fetch
  const calls=[]
  const bytes=new Uint8Array([1,2,3])
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response(201,{success:true,data:[]})}
  try{
    await uploadAttachments(42,[new Blob([bytes],{type:'image/png'})])
    assert.equal(calls[0].url,'/api/repairs/42/attachments')
    assert.equal(calls[0].options.credentials,'include')
    assert.equal(calls[0].options.headers['X-Auth-Request'],'1')
    assert.deepEqual(JSON.parse(calls[0].options.body),{files:[{mime:'image/png',data:'AQID'}]})
    const blob=new Blob([bytes],{type:'image/png'})
    globalThis.fetch=async()=>({ok:true,status:200,blob:async()=>blob})
    assert.equal(await getAttachmentBlob(42,1),blob)
    let finish
    const pending=uploadAttachments(42,[{type:'image/png',arrayBuffer:()=>new Promise(resolve=>{finish=resolve})}])
    const rejected=assert.rejects(pending,error=>error.code==='STALE')
    resetRequests();finish(bytes.buffer);await rejected
  }finally{globalThis.fetch=original;resetRequests()}
})
test('旧账号图片响应体完成后不得返回供新账号生成对象 URL',async()=>{
  const original=globalThis.fetch
  let finish,reading
  const started=new Promise(resolve=>{reading=resolve})
  globalThis.fetch=async()=>({ok:true,status:200,blob:()=>{reading();return new Promise(resolve=>{finish=resolve})}})
  try{
    const pending=getAttachmentBlob(42,1),rejected=assert.rejects(pending,error=>error.code==='STALE')
    await started;resetRequests();finish(new Blob(['old']));await rejected
  }finally{globalThis.fetch=original;resetRequests()}
})

test('AI 请求仅发送描述并使用统一防护，账号切换后丢弃旧分析',async()=>{
  const original=globalThis.fetch
  const calls=[]
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return response(200,{success:true,data:{mode:'rules'}})}
  try{
    await analyzeRepair('宿舍水龙头持续漏水需要维修')
    assert.equal(calls[0].url,'/api/ai/analyze-repair')
    assert.deepEqual(JSON.parse(calls[0].options.body),{description:'宿舍水龙头持续漏水需要维修'})
    assert.equal(calls[0].options.credentials,'include')
    assert.equal(calls[0].options.headers['X-Auth-Request'],'1')
    let finish
    globalThis.fetch=()=>new Promise(resolve=>{finish=resolve})
    const pending=analyzeRepair('旧账号故障描述不得重新显示')
    const rejected=assert.rejects(pending,error=>error.code==='STALE')
    resetRequests()
    finish(response(200,{success:true,data:{mode:'rules',recommended_category:'其他'}}))
    await rejected
  }finally{globalThis.fetch=original;resetRequests()}
})
