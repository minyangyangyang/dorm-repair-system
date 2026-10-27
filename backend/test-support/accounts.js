import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

export const testOrigin = 'http://localhost:5173'
export const testAccount = username => ({ username, display_name: '测试账号', password: randomBytes(24).toString('hex') })

// Credentials and session cookies remain private to the test process.
export async function loginClient(baseUrl, account) {
  const response = await globalThis.fetch(baseUrl + '/api/auth/login', {
    method: 'POST', headers: { Origin: testOrigin, 'X-Auth-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.equal(typeof cookie, 'string')
  return (url, options = {}) => globalThis.fetch(url, { ...options,
    headers: { Origin: testOrigin, 'X-Auth-Request': '1', Cookie: cookie, ...options.headers },
  })
}
