import { Router } from 'express'
import cors from 'cors'
import { createHash, randomBytes } from 'node:crypto'
import { hashPassword, normalizeUsername, publicUser, validateAccount, verifyPassword } from './accounts.js'

export const sessionCookieName = 'dorm_session'
export const tokenDigest = token => createHash('sha256').update(token).digest('hex')
const sessionLifetime = 8 * 60 * 60 * 1000
const fail = (res, status, message) => res.status(status).json({ success: false, message })

export function readSession(db, req) {
  const cookies = (req.headers.cookie || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(sessionCookieName + '='))
  if (cookies.length !== 1) return null
  const token = cookies[0].slice(sessionCookieName.length + 1)
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const digest = tokenDigest(token)
  const row = db.prepare(`SELECT users.*, sessions.expires_at FROM sessions
    JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`).get(digest)
  if (!row || row.is_active !== 1 || !Number.isFinite(Date.parse(row.expires_at)) ||
      Date.parse(row.expires_at) <= Date.now()) return null
  return { user: publicUser(row), digest }
}

function rateLimiter(limit, windowMs) {
  const attempts = new Map()
  return (req, res, next) => {
    const now = Date.now()
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key)
    const key = req.ip // Do not trust user-supplied X-Forwarded-For.
    let entry = attempts.get(key)
    if (!entry) {
      if (attempts.size >= 10000) return fail(res, 429, '请求过于频繁，请稍后重试')
      entry = { count: 0, until: now + windowMs }
      attempts.set(key, entry)
    }
    if (++entry.count > limit) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.until - now) / 1000))))
      return fail(res, 429, '请求过于频繁，请稍后重试')
    }
    next()
  }
}

export function createRequestSecurity(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production'
  const configured = options.allowedOrigins ?? process.env.AUTH_ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean)
  if (production && !configured?.length) throw new Error('生产环境必须配置 AUTH_ALLOWED_ORIGINS')
  const origins = configured ?? ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000']
  for (const origin of origins) {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol) ||
        (production && parsed.protocol !== 'https:')) throw new Error('AUTH_ALLOWED_ORIGINS 必须是精确的可信源，生产环境须使用 HTTPS')
  }
  const allowed = new Set(origins)
  return {
    production,
    headers(req, res, next) {
      res.setHeader('Cache-Control', 'no-store')
      res.vary('Origin')
      next()
    },
    cors: cors({
      origin: (origin, callback) => callback(null, allowed.has(origin)),
      credentials: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Auth-Request'],
    }),
    protectWrite(req, res, next) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
      if (!allowed.has(req.get('Origin')) || req.get('X-Auth-Request') !== '1' ||
          req.get('Sec-Fetch-Site') === 'cross-site') return fail(res, 403, '请求来源校验失败')
      if (!req.is('application/json')) return fail(res, 415, '请使用 application/json 格式提交')
      next()
    },
  }
}

export function createAuthRouter(db, options = {}, security = createRequestSecurity(options)) {
  const router = Router()
  const production = security.production
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: production, path: '/api' }
  const windowMs = options.windowMs ?? 15 * 60 * 1000
  let inFlight = 0
  router.use(security.headers, security.cors, security.protectWrite)
  const guard = handler => async (req, res) => {
    if (inFlight >= 2) return fail(res, 429, '认证服务繁忙，请稍后重试')
    inFlight++
    try { await handler(req, res) } finally { inFlight-- }
  }

  router.post('/register', rateLimiter(options.registerLimit ?? 5, windowMs), guard(async (req, res) => {
    const invalid = validateAccount(req.body)
    if (invalid) return fail(res, 400, invalid)
    if (Object.hasOwn(req.body, 'role') && req.body.role !== 'student') return fail(res, 400, '仅允许注册学生账号')
    const username = normalizeUsername(req.body.username)
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return fail(res, 409, '用户名已存在')
    const passwordHash = await hashPassword(req.body.password)
    let result
    try {
      result = db.prepare(`INSERT INTO users (username, password_hash, display_name, role, created_at)
        VALUES (?, ?, ?, 'student', ?)`).run(username, passwordHash, req.body.display_name.trim(), new Date().toISOString())
    } catch (error) {
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return fail(res, 409, '用户名已存在')
      throw error
    }
    res.status(201).json({ success: true, message: '注册成功', data: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid)) })
  }))

  router.post('/login', rateLimiter(options.loginLimit ?? 10, windowMs), guard(async (req, res) => {
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        typeof body.username !== 'string' || body.username.length > 64 ||
        typeof body.password !== 'string' || body.password.length > 128) return fail(res, 400, '用户名或密码格式不正确')
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(body.username))
    const verified = await verifyPassword(body.password, user?.password_hash)
    if (!verified || !user || user.is_active !== 1) return fail(res, 401, '用户名或密码错误，或账号不可用')
    // Recheck after asynchronous hashing: an administrator may have disabled or reset this account.
    const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
    if (!currentUser || currentUser.is_active !== 1 || currentUser.password_hash !== user.password_hash) {
      return fail(res, 401, '用户名或密码错误，或账号不可用')
    }
    const token = randomBytes(32).toString('hex')
    const now = new Date()
    const expires = new Date(now.getTime() + sessionLifetime)
    // Rotate any current session and create the new session atomically.
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = readSession(db, req)
      if (current) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(current.digest)
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString())
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(tokenDigest(token), user.id, expires.toISOString(), now.toISOString())
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
    res.cookie(sessionCookieName, token, { ...cookieOptions, maxAge: sessionLifetime })
    res.json({ success: true, message: '登录成功', data: publicUser(currentUser) })
  }))

  router.post('/logout', (req, res) => {
    // Also delete expired/disabled sessions, without disclosing their existence.
    for (const item of (req.headers.cookie || '').split(';')) {
      const value = item.trim()
      if (value.startsWith(sessionCookieName + '=')) {
        const token = value.slice(sessionCookieName.length + 1)
        if (/^[a-f0-9]{64}$/.test(token)) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenDigest(token))
      }
    }
    res.clearCookie(sessionCookieName, cookieOptions)
    res.json({ success: true, message: '退出成功' })
  })

  router.get('/me', (req, res) => {
    const session = readSession(db, req)
    if (!session) return fail(res, 401, '未登录或登录已失效')
    res.json({ success: true, data: session.user })
  })
  return router
}
