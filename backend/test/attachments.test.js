import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openDatabase } from '../src/database.js'
import { migrateDatabase } from '../src/migrations.js'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/accounts.js'
import { loginClient, testAccount } from '../test-support/accounts.js'
import { detectImage } from '../src/image-format.js'
const fixtures=JSON.parse(readFileSync(new URL('../test-support/photos.json',import.meta.url),'utf8'))
const mime={PNG:'image/png',JPEG:'image/jpeg',WEBP:'image/webp'}
const photo=(format='PNG')=>({mime:mime[format],data:fixtures[format],name:'../../ignored.html'})
const real=new URL('../data/',import.meta.url)
const fingerprint=()=>Object.fromEntries(readdirSync(real).filter(name=>name.startsWith('repairs.sqlite')).sort()
  .map(name=>[name,createHash('sha256').update(readFileSync(new URL(name,real))).digest('hex')]))
const before=fingerprint()
test.after(()=>assert.deepEqual(fingerprint(),before,'正式数据库不得改变'))
const account=testAccount('photo_fixture')
let hash
test.before(async()=>{hash=await hashPassword(account.password)})
const rows=data=>data.map(row=>({...row}))
async function setup(t) {
  const work=mkdtempSync(join(tmpdir(),'dorm-photos-')),directory=join(work,'uploads')
  const db=openDatabase(join(work,'test.sqlite')),users={}
  for(const [name,role] of [['student','student'],['other','student'],['worker','worker'],['worker2','worker'],['admin','admin']]) {
    users[name]=Number(db.prepare('INSERT INTO users(username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?)')
      .run(name,hash,name,role,new Date().toISOString()).lastInsertRowid)
  }
  const server=createApp(db,{uploads:{directory},auth:{loginLimit:100}}).listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close()})
  const base='http://127.0.0.1:'+server.address().port,clients={}
  async function request(actor,method,path,body,headers={}) {
    if(actor&&!clients[actor])clients[actor]=await loginClient(base,{username:actor,password:account.password})
    const response=await (actor?clients[actor]:globalThis.fetch)(base+path,{method,
      headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())
    return {status:response.status,data,headers:response.headers}
  }
  const create=async()=>request('student','POST','/api/repairs',{building:'3栋',room:'101',category:'水电',description:'图片测试',contact_name:'同学',contact_phone:'13800000000'})
  const upload=(id,files,actor='student',headers={})=>request(actor,'POST','/api/repairs/'+id+'/attachments',{files},headers)
  const list=(id,actor='student')=>request(actor,'GET','/api/repairs/'+id+'/attachments')
  const content=(id,fileId,actor='student')=>request(actor,'GET','/api/repairs/'+id+'/attachments/'+fileId+'/content')
  const saved=()=>existsSync(directory)?readdirSync(directory):[]
  return {db,directory,users,request,create,upload,list,content,saved}
}

test('可选照片、三种真实格式、随机本地存储与受保护下载响应',async t=>{
  const {db,create,upload,list,content,saved,directory}=await setup(t)
  const id=(await create()).data.data.id
  assert.equal(detectImage(Buffer.from(fixtures.WEBP_ANIM,'base64')).mime,'image/webp')
  assert.deepEqual((await list(id)).data.data,[])
  assert.deepEqual(saved(),[])
  for(const format of ['PNG','JPEG','WEBP']) assert.equal(detectImage(Buffer.from(fixtures[format],'base64')).mime,mime[format])
  const result=await upload(id,[photo('PNG'),photo('JPEG'),photo('WEBP')])
  assert.equal(result.status,201)
  assert.equal(result.data.data.length,3)
  assert.equal(saved().length,3)
  assert.equal(saved().every(name=>/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(name)),true)
  const records=db.prepare('SELECT * FROM repair_attachments WHERE repair_order_id=? ORDER BY id').all(id)
  for(const [i,format] of ['PNG','JPEG','WEBP'].entries()) {
    const record=records[i]
    assert.equal(record.byte_size,Buffer.from(fixtures[format],'base64').length)
    assert.deepEqual(readFileSync(join(directory,record.storage_name)),Buffer.from(fixtures[format],'base64'))
    const response=await content(id,record.id)
    assert.equal(response.status,200)
    assert.equal(response.headers.get('content-type'),mime[format])
    assert.equal(response.headers.get('x-content-type-options'),'nosniff')
    assert.equal(response.headers.get('cache-control').includes('no-store'),true)
    assert.equal(response.headers.get('content-security-policy').includes('sandbox'),true)
    assert.deepEqual(response.data,Buffer.from(fixtures[format],'base64'))
    assert.equal(Object.hasOwn(result.data.data[i],'storage_name'),false)
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
})

test('非法内容、伪造 MIME、编码、截断及超大图片均拒绝且不落盘',async t=>{
  const {create,upload,saved,db}=await setup(t)
  const id=(await create()).data.data.id
  for(const file of [
    {mime:'image/png',data:Buffer.from('<html>not an image</html>').toString('base64')},
    {mime:'image/png',data:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')},
    {mime:'image/jpeg',data:fixtures.PNG},
    {mime:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')},
    {mime:'image/png',data:Buffer.from(fixtures.PNG,'base64').subarray(0,40).toString('base64')},
    {mime:'image/png',data:'not-base64'},
  ])assert.equal((await upload(id,[file])).status,400)
  assert.equal((await upload(id,[{mime:'image/png',data:Buffer.alloc(5*1024*1024+1).toString('base64')}])).status,413)
  assert.equal((await upload(id,[])).status,400)
  assert.equal((await upload(id,[photo(),photo(),photo(),photo()])).status,400)
  assert.equal((await upload(id,[{data:'A'.repeat(21*1024*1024)}])).status,413)
  assert.deepEqual(saved(),[])
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_attachments').get().n,0)
})

test('重复及并发上传不突破每单三张上限',async t=>{
  const {db,create,upload,saved}=await setup(t)
  const id=(await create()).data.data.id
  assert.equal((await upload(id,[photo()])).status,201)
  assert.equal((await upload(id,[photo(),photo()])).status,201)
  assert.equal((await upload(id,[photo()])).status,409)
  assert.equal(saved().length,3)
  const second=(await create()).data.data.id
  const result=await Promise.all([upload(second,[photo(),photo()]),upload(second,[photo(),photo()])])
  assert.deepEqual(result.map(item=>item.status).sort(),[201,409])
  assert.equal(db.prepare('SELECT count(*) AS n FROM repair_attachments WHERE repair_order_id=?').get(second).n,2)
  assert.equal(saved().length,5)
})

test('学生隔离、管理员可读、待接单禁止读、接单后仅负责人可读，改派立即撤权',async t=>{
  const {create,upload,list,content,request,users,db}=await setup(t)
  const id=(await create()).data.data.id
  const file=(await upload(id,[photo()])).data.data[0]
  assert.equal((await list(id,'other')).status,404)
  assert.equal((await content(id,file.id,'other')).status,404)
  assert.equal((await upload(id,[photo()],'other')).status,404)
  assert.equal((await upload(id,[photo()],'admin')).status,403)
  assert.equal((await list(id,'worker')).status,404)
  assert.equal((await content(id,file.id,'worker')).status,404)
  assert.equal((await content(id,file.id,'admin')).status,200)
  assert.equal((await request('worker','POST','/api/repairs/'+id+'/accept',{})).status,200)
  assert.equal((await content(id,file.id,'worker')).status,200)
  assert.equal((await content(id,file.id,'worker2')).status,404)
  const order=db.prepare('SELECT * FROM repair_orders WHERE id=?').get(id)
  assert.equal((await request('admin','PATCH','/api/repairs/'+id+'/assignment',{
    assigned_worker_id:users.worker2,expected_status:order.status,expected_assigned_worker_id:order.assigned_worker_id,expected_updated_at:order.updated_at
  })).status,200)
  assert.equal((await content(id,file.id,'worker')).status,404)
  assert.equal((await content(id,file.id,'worker2')).status,200)
  assert.equal((await request(null,'GET','/api/repairs/'+id+'/attachments')).status,401)
  assert.equal((await content(id,file.id,null)).status,401)
  assert.equal((await request(null,'GET','/uploads/anything.png')).status,404)
  const another=(await create()).data.data.id
  assert.equal((await content(another,file.id)).status,404)
})

test('上传失败清理本次文件且不破坏工单、评价、日志和通知；缺失文件正常报错',async t=>{
  const {db,directory,create,upload,content,saved,request}=await setup(t)
  const id=(await create()).data.data.id
  const original=(await upload(id,[photo()])).data.data[0]
  await request('worker','POST','/api/repairs/'+id+'/accept',{})
  await request('worker','PATCH','/api/repairs/'+id+'/status',{status:'维修中'})
  await request('worker','PATCH','/api/repairs/'+id+'/status',{status:'已完成'})
  await request('student','POST','/api/repairs/'+id+'/evaluation',{rating:5,comment:'保留评价'})
  const snapshots={}
  for(const table of ['repair_orders','evaluations','repair_logs','notifications','repair_attachments'])snapshots[table]=rows(db.prepare('SELECT * FROM '+table).all())
  const previous=saved()
  db.exec("CREATE TEMP TRIGGER fail_attachment BEFORE INSERT ON repair_attachments BEGIN SELECT RAISE(ABORT,'injected attachment failure'); END")
  assert.equal((await upload(id,[photo()])).status,500)
  assert.deepEqual(saved(),previous)
  for(const table of Object.keys(snapshots))assert.deepEqual(rows(db.prepare('SELECT * FROM '+table).all()),snapshots[table])
  assert.equal(db.isTransaction,false)
  db.exec('DROP TRIGGER fail_attachment')
  const path=db.prepare('SELECT storage_name FROM repair_attachments WHERE id=?').get(original.id).storage_name
  unlinkSync(join(directory,path))
  assert.equal((await content(id,original.id)).status,404)
})

test('上传遵守 CSRF、旧单无图片及迁移幂等保留旧数据',async t=>{
  const {db,create,upload,list}=await setup(t)
  const id=(await create()).data.data.id
  assert.equal((await upload(id,[photo()],'student',{Origin:'https://evil.example'})).status,403)
  const snapshots={}
  for(const table of ['repair_orders','evaluations','repair_logs','notifications','users','sessions'])snapshots[table]=rows(db.prepare('SELECT * FROM '+table).all())
  db.exec('DROP TABLE repair_attachments; DELETE FROM schema_migrations WHERE version=4')
  migrateDatabase(db);migrateDatabase(db)
  for(const table of Object.keys(snapshots))assert.deepEqual(rows(db.prepare('SELECT * FROM '+table).all()),snapshots[table])
  assert.deepEqual((await list(id)).data.data,[])
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,4)
})
