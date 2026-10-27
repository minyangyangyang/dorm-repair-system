<script setup>
import { reactive, ref } from 'vue'
import { login, register, session } from '../auth.js'
import { isCancelled } from '../api/client.js'
import { validateAccount } from '../utils/account.js'

const mode = ref('login')
const form = reactive({ username: '', password: '', display_name: '', confirm: '' })
const busy = ref(false)
const error = ref('')
const message = ref('')
function switchMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  form.password = ''; form.confirm = ''; error.value = ''; message.value = ''
}
async function submit() {
  if (busy.value) return
  error.value = ''
  if (mode.value === 'register') {
    error.value = validateAccount(form)
    if (!error.value && form.password !== form.confirm) error.value = '两次密码不一致'
  } else if (!form.username.trim() || !form.password) error.value = '请输入用户名和密码'
  if (error.value) return
  busy.value = true
  try {
    const account = { username: form.username.trim(), password: form.password }
    if (mode.value === 'register') {
      await register({ ...account, display_name: form.display_name.trim() })
      mode.value = 'login'; message.value = '注册成功，请使用新账号登录。'
    } else await login(account)
  } catch (issue) { if (!isCancelled(issue)) error.value = issue.message }
  finally { form.password = ''; form.confirm = ''; busy.value = false }
}
</script>

<template>
  <header class="topbar"><div class="header-inner"><span class="brand"><span class="brand-icon">修</span><span>宿舍报修管理系统<small>校园生活服务平台</small></span></span></div></header>
  <main class="auth-main">
    <section class="panel auth-panel">
      <div class="page-heading"><span class="eyebrow">DORM REPAIR</span><h1>{{ mode === 'login' ? '账号登录' : '学生注册' }}</h1><p>{{ mode === 'login' ? '登录后进入对应角色的工作台。' : '注册仅创建学生账号，维修账号由管理员管理。' }}</p></div>
      <p v-if="session.notice" class="success" role="status">{{ session.notice }}</p>
      <p v-if="message" class="success" role="status">{{ message }}</p>
      <p v-if="error" class="request-error" role="alert">{{ error }}</p>
      <form @submit.prevent="submit" novalidate>
        <fieldset class="form-fieldset" :disabled="busy">
          <div class="field"><label for="auth-username">用户名</label><input id="auth-username" v-model="form.username" autocomplete="username" maxlength="32" required /></div>
          <div v-if="mode === 'register'" class="field"><label for="auth-name">显示名称</label><input id="auth-name" v-model="form.display_name" autocomplete="name" maxlength="50" required /></div>
          <div class="field"><label for="auth-password">密码</label><input id="auth-password" v-model="form.password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" maxlength="128" required /><p v-if="mode === 'register'" class="evaluation-hint">12–128 个字符，不会保存在浏览器存储中。</p></div>
          <div v-if="mode === 'register'" class="field"><label for="auth-confirm">确认密码</label><input id="auth-confirm" v-model="form.confirm" type="password" autocomplete="new-password" maxlength="128" required /></div>
          <button class="primary" type="submit" :aria-busy="busy">{{ busy ? '正在处理…' : mode === 'login' ? '登录' : '注册学生账号' }}</button>
        </fieldset>
      </form>
      <button class="secondary auth-toggle" :disabled="busy" @click="switchMode">{{ mode === 'login' ? '没有学生账号？前往注册' : '已有账号？返回登录' }}</button>
    </section>
  </main>
</template>
