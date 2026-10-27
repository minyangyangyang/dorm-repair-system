<script setup>
import { onBeforeUnmount, reactive, ref } from 'vue'
import { createWorker, disableWorker } from '../api/repairs.js'
import { isCancelled } from '../api/client.js'
import { validateAccount } from '../utils/account.js'
defineProps({ workers: Array, loading: Boolean, error: String })
const emit = defineEmits(['refresh'])
const form = reactive({ username: '', password: '', display_name: '' })
const creating = ref(false)
const disabling = ref(null)
const message = ref('')
const actionError = ref('')
let active = true
onBeforeUnmount(() => { active = false; form.password = '' })
async function create() {
  if (creating.value) return
  actionError.value = validateAccount(form)
  if (actionError.value) return
  creating.value = true
  try {
    await createWorker({ username: form.username.trim(), password: form.password, display_name: form.display_name.trim() })
    if (!active) return
    Object.assign(form, { username: '', password: '', display_name: '' })
    message.value = '维修账号已创建。'; emit('refresh')
  } catch (issue) { if (active && !isCancelled(issue)) actionError.value = issue.message }
  finally { form.password = ''; if (active) creating.value = false }
}
async function disable(worker) {
  if (disabling.value !== null || !window.confirm('确定停用维修账号“' + worker.username + '”？其现有会话将撤销，任务不会自动改派。')) return
  disabling.value = worker.id; actionError.value = ''; message.value = ''
  try {
    await disableWorker(worker.id)
    if (active) { message.value = '账号已停用。'; emit('refresh') }
  } catch (issue) {
    if (active && !isCancelled(issue)) { actionError.value = issue.message; emit('refresh') }
  } finally { if (active) disabling.value = null }
}
</script>

<template>
  <section>
    <div class="page-heading"><h1>维修人员管理</h1><p>创建、查看和停用维修账号。停用不会自动改派其任务。</p></div>
    <p v-if="message" class="success" role="status">{{ message }}</p>
    <p v-if="actionError" class="request-error" role="alert">{{ actionError }}</p>
    <section class="panel">
      <h2>创建维修账号</h2>
      <form @submit.prevent="create" novalidate>
        <fieldset class="form-fieldset form-grid" :disabled="creating">
          <div class="field"><label for="worker-username">用户名</label><input id="worker-username" v-model="form.username" maxlength="32" autocomplete="off" required /></div>
          <div class="field"><label for="worker-name">显示名称</label><input id="worker-name" v-model="form.display_name" maxlength="50" autocomplete="off" required /></div>
          <div class="field"><label for="worker-password">初始密码</label><input id="worker-password" v-model="form.password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required /><p class="evaluation-hint">12–128 个字符，创建后不再展示。</p></div>
          <div class="field worker-create"><button class="primary" type="submit">{{ creating ? '正在创建…' : '创建维修人员' }}</button></div>
        </fieldset>
      </form>
    </section>
    <section class="panel workers-panel">
      <div class="section-heading"><h2>维修账号列表</h2><button class="secondary" :disabled="loading" @click="emit('refresh')">刷新账号</button></div>
      <p v-if="loading" class="loading-message" role="status">正在读取账号…</p>
      <p v-if="error" class="request-error" role="alert">{{ error }}</p>
      <article v-for="worker in workers" :key="worker.id" class="record worker-row">
        <div><h3>{{ worker.display_name }}</h3><p class="record-meta">{{ worker.username }} · {{ worker.is_active ? '启用' : '已停用' }}</p></div>
        <button v-if="worker.is_active" class="secondary" :disabled="disabling !== null" @click="disable(worker)">{{ disabling === worker.id ? '正在停用…' : '停用账号' }}</button>
      </article>
      <p v-if="!loading && !error && !workers.length" class="empty">暂无维修账号，请先创建。</p>
    </section>
  </section>
</template>
