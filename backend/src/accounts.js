import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
const parameters = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }
const dummyHash = `scrypt$131072$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`

export function validateAccount(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '请求内容必须是 JSON 对象'
  if (typeof body.username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(body.username.trim())) return '用户名须为 3–32 位字母、数字、下划线、点或短横线，首位为字母或数字'
  if (!validPassword(body.password)) return '密码须为 12–128 个字符，不能全为空白'
  if (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.trim().length > 50 || /[\u0000-\u001f\u007f]/.test(body.display_name)) return '显示名称须为 1–50 个字符，不能包含控制字符'
  return null
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128 &&
    Buffer.byteLength(password, 'utf8') <= 512 && password.trim().length > 0
}

export function normalizeUsername(username) {
  return username.trim().toLowerCase()
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await derive(password, salt, 64, parameters)
  return `scrypt$131072$8$1$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password, stored = dummyHash) {
  if (typeof password !== 'string' || password.length > 128) return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$131072$8$1' ||
      !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false
  const key = await derive(password, Buffer.from(parts[4], 'hex'), 64, parameters)
  return timingSafeEqual(key, Buffer.from(parts[5], 'hex'))
}

export function publicUser(user) {
  return { id: user.id, username: user.username, display_name: user.display_name,
    role: user.role, is_active: user.is_active, created_at: user.created_at }
}

// The CLI is the only caller that may provision an administrator.
export async function initializeAdmin(db, account) {
  const invalid = validateAccount(account)
  if (invalid) throw new Error(invalid)
  const passwordHash = await hashPassword(account.password)
  db.exec('BEGIN IMMEDIATE')
  try {
    if (db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get()) {
      throw new Error('管理员已存在，拒绝覆盖或创建第二个初始化管理员')
    }
    const username = normalizeUsername(account.username)
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw new Error('用户名已存在')
    const result = db.prepare(`INSERT INTO users (username, password_hash, display_name, role, created_at)
      VALUES (?, ?, ?, 'admin', ?)`).run(username, passwordHash, account.display_name.trim(), new Date().toISOString())
    db.exec('COMMIT')
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid))
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
