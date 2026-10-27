import { openDatabase, databasePath } from '../src/database.js'
import { initializeAdmin } from '../src/accounts.js'
import { resolve } from 'node:path'
import { createInterface, emitKeypressEvents } from 'node:readline'
import { stdin, stdout } from 'node:process'

// Secrets are read from a hidden terminal prompt, or a private stdin pipe.
// Never accept passwords through command-line arguments or print input/errors.
async function readAccount() {
  if (process.argv.slice(2).some(arg => arg !== '--stdin')) throw new Error('仅支持 --stdin 参数')
  if (process.argv.includes('--stdin')) {
    if (stdin.isTTY) throw new Error('--stdin 仅支持管道输入')
    let input = ''
    for await (const chunk of stdin) {
      input += chunk.toString()
      if (Buffer.byteLength(input) > 4096) throw new Error('输入过大')
    }
    try { return JSON.parse(input) } catch { throw new Error('输入必须是账号 JSON 对象') }
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('请使用交互终端，或通过 --stdin 传入私有 JSON 管道')
  const rl = createInterface({ input: stdin, output: stdout })
  const question = prompt => new Promise(resolve => rl.question(prompt, resolve))
  let username, display_name
  try {
    username = await question('管理员用户名：')
    display_name = await question('显示名称：')
  } finally { rl.close() }
  const hidden = prompt => new Promise((resolve, reject) => {
    stdout.write(prompt)
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    const finish = error => {
      stdin.removeListener('keypress', handler)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      error ? reject(error) : resolve(value)
    }
    const handler = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('操作已取消'))
      if (key.name === 'return' || key.name === 'enter') return finish()
      if (key.name === 'backspace') value = Array.from(value).slice(0, -1).join('')
      else if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(text)) value += text
    }
    stdin.on('keypress', handler)
  })
  const password = await hidden('管理员密码（不回显）：')
  if (password !== await hidden('再次输入密码（不回显）：')) throw new Error('两次密码不一致')
  return { username, display_name, password }
}

let db
try {
  // Validate/read input before opening or migrating any database.
  const account = await readAccount()
  db = openDatabase(process.env.DB_PATH ? resolve(process.env.DB_PATH) : databasePath)
  await initializeAdmin(db, account)
  stdout.write('管理员初始化成功。\n')
} catch {
  // A fixed error avoids reflecting malformed input, secrets or SQLite values.
  process.stderr.write('管理员初始化失败：检查输入格式、密码要求、数据库路径，以及是否已有管理员或同名用户。\n')
  process.exitCode = 1
} finally {
  db?.close()
}
