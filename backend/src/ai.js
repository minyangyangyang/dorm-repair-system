import { Router } from 'express'
import { AiError, createRepairAnalyzer, minimizeDescription } from './ai-service.js'
import { readSession } from './auth.js'
import { fail, requireRoles } from './permissions.js'

export function createAiRouter(db, options = {}) {
  const router = Router()
  const analyze = createRepairAnalyzer(options)
  const users = new Map(), addresses = new Map(), inFlight = new Set()
  const windowMs = options.windowMs ?? 10*60*1000
  function consume(map, key, limit) {
    const now = Date.now()
    for (const [id,entry] of map) if (entry.until <= now) map.delete(id)
    if (!map.has(key)) {
      if (map.size >= 10000) return false
      map.set(key,{count:0,until:now+windowMs})
    }
    const entry = map.get(key)
    if (entry.count >= limit) return false
    entry.count++
    return true
  }
  router.post('/analyze-repair',requireRoles('student'),async(req,res)=>{
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        typeof req.body.description !== 'string') return fail(res,400,'请提供故障描述')
    const description = req.body.description.trim()
    if (description.length < 8 || description.length > 500) return fail(res,400,'故障描述须为 8–500 个字符，请补充现象并去除个人信息')
    if (inFlight.has(req.user.id) || inFlight.size >= 3) {
      res.set('Retry-After','2'); return fail(res,429,'已有分析正在进行，请勿重复点击')
    }
    if (!consume(users,req.user.id,options.userLimit ?? 5) || !consume(addresses,req.ip,options.ipLimit ?? 20)) {
      res.set('Retry-After',String(Math.ceil(windowMs/1000)))
      return fail(res,429,'AI 分析请求过于频繁，请稍后再试；仍可正常报修')
    }
    inFlight.add(req.user.id)
    const controller = new AbortController()
    const disconnected = ()=>{if(!res.writableEnded)controller.abort()}
    res.on('close',disconnected)
    try {
      // Only the minimized description reaches the service, never the request, user object, photos or cookies.
      const result = await analyze(minimizeDescription(description,req.user.display_name),controller.signal)
      const current = readSession(db,req)
      if (!current) return fail(res,401,'登录已失效，请重新登录')
      if (current.user.role !== 'student') return fail(res,403,'当前角色无权执行此操作')
      if (!res.destroyed) res.json({success:true,data:result})
    } catch(error) {
      // Deliberately never log upstream bodies, errors, prompts, credentials or complete requests.
      if (!res.destroyed) fail(res,error instanceof AiError ? error.status : 503,error instanceof AiError ? error.message : 'AI 分析暂不可用；仍可正常报修')
    } finally {inFlight.delete(req.user.id);res.removeListener('close',disconnected)}
  })
  return router
}
