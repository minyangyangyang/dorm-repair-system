import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { openDatabase } from '../src/database.js'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/accounts.js'
import { repairCategories } from '../src/repair-categories.js'
import { loginClient, testAccount } from '../test-support/accounts.js'
const real=new URL('../data/',import.meta.url)
const fingerprint=()=>Object.fromEntries(readdirSync(real).filter(name=>name.startsWith('repairs.sqlite')).sort()
  .map(name=>[name,createHash('sha256').update(readFileSync(new URL(name,real))).digest('hex')]))
const original=fingerprint()
test.after(()=>assert.deepEqual(fingerprint(),original,'正式数据库及其辅助文件不得修改'))
const account=testAccount('ai_fixture')
let hash
test.before(async()=>{hash=await hashPassword(account.password)})
const good={category:'水电',cause_codes:['wear','blockage']}
function answer(res,value=good){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}))}
async function provider(t,handler=(req,res)=>answer(res)){
  const calls=[]
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk
    calls.push({body:JSON.parse(text),authorization:req.headers.authorization})
    handler(req,res)
  }).listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  return {calls,options:{mode:'remote',provider:'chat-completions',model:'test-model',
    apiKey:randomBytes(24).toString('hex'),endpoint:'http://127.0.0.1:'+server.address().port+'/chat/completions',
    allowLocalHttp:true,timeoutMs:1000}}
}
async function setup(t,options={}){
  const work=mkdtempSync(join(tmpdir(),'dorm-ai-'))
  const db=openDatabase(join(work,'test.sqlite'))
  for(const [name,role]of [['student','student'],['other','student'],['worker','worker'],['admin','admin']]){
    db.prepare('INSERT INTO users(username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?)')
      .run(name,hash,name==='student'?'敏感同学':name,role,new Date().toISOString())
  }
  const server=createApp(db,{uploads:{directory:join(work,'uploads')},auth:{loginLimit:100},
    ai:{mode:'off',userLimit:100,ipLimit:100,...options}}).listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()})
  const base='http://127.0.0.1:'+server.address().port,clients={}
  async function request(actor,body,headers={},path='/api/ai/analyze-repair'){
    if(actor&&!clients[actor])clients[actor]=await loginClient(base,{username:actor,password:account.password})
    const response=await (actor?clients[actor]:globalThis.fetch)(base+path,{
      method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),
    })
    return {status:response.status,body:await response.json(),headers:response.headers}
  }
  return {db,request}
}

test('仅学生可分析，继承登录与 CSRF 防护，不写入业务数据库',async t=>{
  const mock=await provider(t)
  const {db,request}=await setup(t,mock.options)
  const body={description:'宿舍水龙头关闭后仍然持续漏水'}
  assert.equal((await request(null,body)).status,401)
  assert.equal((await request('worker',body)).status,403)
  assert.equal((await request('admin',body)).status,403)
  assert.equal((await request('student',body,{Origin:'https://evil.example'})).status,403)
  assert.equal((await request('student',body,{'X-Auth-Request':''})).status,403)
  assert.equal(mock.calls.length,0)
  assert.equal((await request('student',body)).status,200)
  for(const table of ['repair_orders','evaluations','repair_logs','notifications','repair_attachments']){
    assert.equal(db.prepare('SELECT count(*) AS n FROM '+table).get().n,0)
  }
})

test('空、过短、超长、错误类型输入在调用模型前拒绝',async t=>{
  const mock=await provider(t)
  const {request}=await setup(t,mock.options)
  for(const body of [null,[],{}, {description:''},{description:'漏水'},{description:' '.repeat(20)},
    {description:'漏'.repeat(501)},{description:123}]){
    assert.equal((await request('student',body)).status,400)
  }
  assert.equal(mock.calls.length,0)
})

test('规则演示显式标识、类别限定且不调用外部服务',async t=>{
  const {request}=await setup(t,{mode:'rules'})
  for(const [description,category]of [
    ['房间水龙头关闭后仍持续漏水','水电'],['书桌桌腿断裂无法正常放置物品','家具'],
    ['宿舍网络频繁掉线没有信号','网络'],['窗户锁扣损坏无法正常关闭','门窗'],['公共设施有异常需要安排检查','其他'],
  ]){
    const response=await request('student',{description})
    assert.equal(response.status,200)
    assert.equal(response.body.data.mode,'rules')
    assert.equal(response.body.data.mode_label,'规则演示')
    assert.equal(response.body.data.recommended_category,category)
    assert.equal(response.body.data.reference_only,true)
  }
})

test('真实请求仅含最小描述，敏感字段不转发，错误信息不反射上游内容或密钥',async t=>{
  const mock=await provider(t)
  const {request}=await setup(t,mock.options)
  const response=await request('student',{
    description:'联系人：敏感同学，电话13800138000，3栋101室的水龙头关闭后仍然漏水',
    contact_name:'绝不发送的姓名',contact_phone:'13900139000',room:'绝不发送的宿舍',
    cookie:'绝不发送的会话',photos:['绝不发送的照片'],api_key:'绝不发送的伪造密钥',
  })
  assert.equal(response.status,200)
  assert.equal(response.body.data.mode,'remote')
  assert.equal(mock.calls.length,1)
  const call=mock.calls[0],body=JSON.stringify(call.body)
  for(const value of ['敏感同学','13800138000','3栋101室','绝不发送',mock.options.apiKey]){
    assert.equal(body.includes(value),false)
    assert.equal(JSON.stringify(response.body).includes(value),false)
  }
  assert.deepEqual(Object.keys(call.body).sort(),['max_tokens','messages','model','response_format','stream'])
  assert.deepEqual(call.body.messages.map(message=>message.role),['system','user'])
  assert.equal(call.authorization === 'Bearer '+mock.options.apiKey,true)
  assert.equal(call.body.messages[1].content.includes('水龙头'),true)
})

test('真实输出严格校验类别、归因代码、字段和长度，危险自由文本不返回',async t=>{
  let output=good,raw
  const mock=await provider(t,(req,res)=>{
    if(raw!==undefined){res.writeHead(200,{'Content-Type':'application/json'});res.end(raw)}
    else answer(res,output)
  })
  const {request}=await setup(t,mock.options)
  for(const value of [
    {category:'新造类别',cause_codes:['wear']},
    {category:'水电',cause_codes:['自行带电拆修']},
    {category:'水电',cause_codes:[]},
    {category:'水电',cause_codes:['wear','wear']},
    {category:'水电',cause_codes:['wear'],advice:'先拆开带电插座'},
    {category:'水电',cause_codes:['a'.repeat(3000)]},
    [],
  ]){
    output=value
    const response=await request('student',{description:'水龙头关闭后仍然持续漏水'})
    assert.equal(response.status,502)
    assert.equal(response.body.success,false)
    assert.equal(JSON.stringify(response.body).includes('先拆开带电插座'),false)
  }
  raw='not-json'
  assert.equal((await request('student',{description:'水龙头关闭后仍然持续漏水'})).status,502)
  raw=JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]})
  assert.equal((await request('student',{description:'水龙头关闭后仍然持续漏水'})).status,502)
  raw=' '.repeat(40000)
  assert.equal((await request('student',{description:'水龙头关闭后仍然持续漏水'})).status,502)
})

test('燃气、电气与严重漏水仅返回保守安全建议，不照搬模型的类别判断',async t=>{
  const mock=await provider(t,(req,res)=>answer(res,{category:'网络',cause_codes:['network']}))
  const {request}=await setup(t,mock.options)
  for(const [description,expected,phrase]of [
    ['房间闻到明显燃气异味需要检查','其他','不要点火'],
    ['插座冒烟并发出火花有焦味','水电','不自行拆线'],
    ['卫生间严重漏水导致走廊积水','水电','不接触涉水电源'],
  ]){
    const response=await request('student',{description})
    assert.equal(response.status,200)
    assert.equal(response.body.data.mode,'remote')
    assert.equal(response.body.data.safety_adjusted,true)
    assert.equal(response.body.data.recommended_category,expected)
    assert.equal(response.body.data.advice.includes(phrase),true)
    assert.equal(response.body.data.advice.length<=300,true)
  }
  assert.equal(mock.calls.length,3)
})

test('超时、网络和上游错误明确失败，不静默改用规则；失败后仍可报修',async t=>{
  const slow=await provider(t,()=>{})
  const {request}=await setup(t,{...slow.options,timeoutMs:30})
  const body={description:'房间水龙头持续漏水无法正常使用'}
  const timeout=await request('student',body)
  assert.equal(timeout.status,504)
  assert.equal(timeout.body.success,false)
  assert.equal(Object.hasOwn(timeout.body,'data'),false)
  const network=await provider(t,req=>req.socket.destroy())
  const second=await setup(t,network.options)
  assert.equal((await second.request('student',body)).status,502)
  const failing=await provider(t,(req,res)=>{res.writeHead(401);res.end('upstream-private-failure')})
  const third=await setup(t,failing.options)
  const failure=await third.request('student',body)
  assert.equal(failure.status,502)
  assert.equal(JSON.stringify(failure.body).includes('upstream-private-failure'),false)
  const repair=await request('student',{building:'3栋',room:'101',category:'水电',
    description:'水龙头持续漏水',contact_name:'同学',contact_phone:'13800000000'}, {},'/api/repairs')
  assert.equal(repair.status,201)
})

test('未启用或真实配置缺失返回明确错误，规则模式不会因无密钥自动启用',async t=>{
  const off=await setup(t,{mode:'off'})
  assert.equal((await off.request('student',{description:'宿舍水龙头持续漏水需要维修'})).status,503)
  for(const settings of [{apiKey:''},{provider:'unknown'},{endpoint:'http://evil.example/test'},{endpoint:'https://example.test/?secret=x'}]){
    const ctx=await setup(t,{mode:'remote',provider:'chat-completions',model:'test-model',
      apiKey:randomBytes(24).toString('hex'),endpoint:'https://example.test/chat/completions',...settings})
    const response=await ctx.request('student',{description:'宿舍水龙头持续漏水需要维修'})
    assert.equal(response.status,503)
    assert.equal(response.body.success,false)
  }
})

test('账号限流、单用户并发保护和登出后不返回分析结果',async t=>{
  const rules=await setup(t,{mode:'rules',userLimit:1})
  const body={description:'宿舍水龙头持续漏水需要维修'}
  assert.equal((await rules.request('student',body)).status,200)
  const limited=await rules.request('student',body)
  assert.equal(limited.status,429)
  assert.ok(Number(limited.headers.get('retry-after'))>0)
  let release,entered
  const started=new Promise(resolve=>{entered=resolve})
  const mock=await provider(t,(req,res)=>{release=()=>answer(res);entered()})
  const ctx=await setup(t,mock.options)
  const pending=ctx.request('student',body)
  await started
  assert.equal((await ctx.request('student',body)).status,429)
  ctx.db.prepare('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)').run('student')
  release()
  assert.equal((await pending).status,401)
  assert.equal(mock.calls.length,1)
})

test('后端共享类别与原工单合法枚举保持一致',()=>{
  assert.deepEqual([...repairCategories],['水电','家具','网络','门窗','其他'])
  assert.equal(Object.isFrozen(repairCategories),true)
})
