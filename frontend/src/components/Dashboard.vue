<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { logout } from '../auth.js'
import { isCancelled } from '../api/client.js'
import { createRepair, getRepairs, acceptRepair, updateRepairStatus, getWorkers, assignRepair } from '../api/repairs.js'
import EvaluationPanel from './EvaluationPanel.vue'
import StatisticsPage from './StatisticsPage.vue'
import RepairDetails from './RepairDetails.vue'
import AiRepairAssistant from './AiRepairAssistant.vue'
import ImagePicker from './ImagePicker.vue'
import { uploadAttachments, getAttachments } from '../api/attachments.js'
import AdminWorkers from './AdminWorkers.vue'
import MessageCenter from './MessageCenter.vue'
import { getUnreadCount } from '../api/notifications.js'

const props = defineProps({ user: { type: Object, required: true } })
const role = computed(() => props.user.role)
const roleNames = { student: '学生', worker: '维修人员', admin: '管理员' }
const page = ref('home')
const navigation = computed(() => role.value === 'student'
  ? { home: '首页', submit: '提交报修', records: '我的工单', statistics: '我的统计', messages: '消息中心' }
  : role.value === 'worker' ? { home: '首页', pending: '待接单', tasks: '我的维修任务', statistics: '我的统计', messages: '消息中心' }
  : { home: '首页', orders: '全部工单', workers: '维修人员', statistics: '全量统计', messages: '消息中心' })
const unreadCount = ref(null)
const unreadError = ref('')
let unreadSequence = 0
async function loadUnread() {
  const started = ++unreadSequence
  try {
    const result = await getUnreadCount()
    if (active && started === unreadSequence) { unreadCount.value = result.count; unreadError.value = '' }
  } catch (issue) {
    if (active && started === unreadSequence && !isCancelled(issue)) { unreadCount.value = null; unreadError.value = issue.message }
  }
}
const statuses = ['待处理', '已接单', '维修中', '已完成']
const categories = ['水电', '家具', '网络', '门窗', '其他']
const statusStyles = { 待处理: 'pending', 已接单: 'accepted', 维修中: 'working', 已完成: 'completed' }
const statusFilter = ref('')
const categoryFilter = ref('')
const records = ref([])
const workers = ref([])
const workersLoading = ref(false)
const workersError = ref('')
const loading = ref(false)
const loadError = ref('')
const message = ref('')
const actionError = ref('')
const updatingId = ref(null)
const selections = reactive({})
const evaluations = reactive({})
const photos = ref([]), uploadOrder = ref(null), uploadError = ref(''), uploading = ref(false)
const submitting = ref(false)
const submitError = ref('')
const errors = ref({})
const labels = { building: '宿舍楼', room: '房间号', category: '故障类别', description: '问题描述', contact: '联系人', phone: '联系电话' }
const blank = () => Object.fromEntries(Object.keys(labels).map(key => [key, '']))
const form = reactive(blank())
let active = true
let listSequence = 0
let workerSequence = 0
onBeforeUnmount(() => {
  active = false; listSequence++; workerSequence++; unreadSequence++; unreadCount.value = null
  records.value = []; workers.value = []; photos.value = []; uploadOrder.value = null
  Object.assign(form, blank())
  for (const key of Object.keys(evaluations)) delete evaluations[key]
})
function evaluationState(id) { return evaluations[id] ||= { loaded: false, loading: false, error: '', data: null } }
async function loadRepairs() {
  const sequence = ++listSequence
  loading.value = true; loadError.value = ''
  try {
    const result = await getRepairs()
    if (!active || sequence !== listSequence) return
    records.value = result
    for (const key of Object.keys(evaluations)) delete evaluations[key]
    for (const key of Object.keys(selections)) delete selections[key]
  } catch (issue) {
    if (active && sequence === listSequence && !isCancelled(issue)) { loadError.value = issue.message; records.value = [] }
  } finally { if (active && sequence === listSequence) loading.value = false }
}
async function loadWorkers() {
  const sequence = ++workerSequence
  workersLoading.value = true; workersError.value = ''
  try { const result = await getWorkers(); if (active && sequence === workerSequence) workers.value = result }
  catch (issue) {
    if (active && sequence === workerSequence && !isCancelled(issue)) { workersError.value = issue.message; workers.value = [] }
  } finally { if (active && sequence === workerSequence) workersLoading.value = false }
}
function handleUnavailable(issue) { actionError.value = issue?.message || '工单已不可访问'; loadRepairs() }
onMounted(() => { loadUnread(); loadRepairs(); if (role.value === 'admin') loadWorkers() })
function navigate(target) { if (target !== 'messages') loadUnread(); page.value = target; statusFilter.value = ''; categoryFilter.value = ''; message.value = ''; actionError.value = '' }
const isPending = record => role.value === 'worker' && record.assignedWorkerId === null && record.status === '待处理'
const scopedRecords = computed(() => role.value !== 'worker' ? records.value :
  page.value === 'pending' ? records.value.filter(isPending) : records.value.filter(record => record.assignedWorkerId === props.user.id))
const filteredRecords = computed(() => scopedRecords.value.filter(record =>
  (!statusFilter.value || record.status === statusFilter.value) && (!categoryFilter.value || record.category === categoryFilter.value)))
const ownRecords = computed(() => role.value === 'worker' ? records.value.filter(record => record.assignedWorkerId === props.user.id) : records.value)
const completed = computed(() => ownRecords.value.filter(record => record.status === '已完成').length)
const enabledWorkers = computed(() => workers.value.filter(worker => worker.is_active === 1))
const title = computed(() => navigation.value[page.value] || '工单')
const canAssign = record => role.value === 'admin' && ((record.status === '待处理' && record.assignedWorkerId === null) || record.status === '已接单')
const workerName = id => workers.value.find(worker => worker.id === id)?.display_name || '账号 #' + id
const transitions = { 已接单: { next: '维修中', label: '开始维修' }, 维修中: { next: '已完成', label: '完成维修' } }
async function mutate(record, action) {
  if (updatingId.value !== null) return
  updatingId.value = record.databaseId; actionError.value = ''; message.value = ''
  try {
    await action()
    if (!active) return
    message.value = '工单操作成功，列表已刷新。'
    await loadRepairs(); loadUnread()
  } catch (issue) {
    if (!active || isCancelled(issue)) return
    const prefix = { 403: '无权操作：', 404: '工单已不可访问：', 409: '工单已变化：' }[issue.status] || ''
    actionError.value = prefix + issue.message
    // Refresh after failure as ownership or status may have changed.
    await loadRepairs()
    if (role.value === 'admin') await loadWorkers()
  } finally { if (active) updatingId.value = null }
}
function assign(record) {
  const id = selections[record.databaseId]
  if (!id) { actionError.value = '请选择启用的维修人员。'; return }
  mutate(record, () => assignRepair(record, id))
}
function dismissUpload() { photos.value=[];uploadOrder.value=null;uploadError.value='' }
async function sendPhotos(retry=true) {
  if (!uploadOrder.value || uploading.value || !photos.value.length) return
  uploading.value=true;uploadError.value=''
  try {
    if (retry) {
      const existing=await getAttachments(uploadOrder.value.databaseId)
      if (!active) return
      if (existing.length) {uploadError.value='工单已存在 '+existing.length+' 张照片，请到详情确认，避免重复上传。';return}
    }
    await uploadAttachments(uploadOrder.value.databaseId,photos.value)
    if (!active) return
    message.value='工单已提交，照片上传成功。';dismissUpload()
    if (retry) await loadRepairs()
  } catch(issue) {
    if (active && !isCancelled(issue)) uploadError.value='工单 '+uploadOrder.value.id+' 已提交，但照片上传失败或结果未确认：'+issue.message+'。请勿重复提交工单，可重试照片或到详情核对。'
  } finally {if(active)uploading.value=false}
}
async function submit() {
  if (submitting.value || uploading.value || uploadOrder.value || loading.value) return
  const issues = {}
  for (const [key, label] of Object.entries(labels)) {
    if (!form[key].trim()) issues[key] = '请填写' + label
    else if (form[key].trim().length > (key === 'description' ? 500 : 50)) issues[key] = label + '长度超出限制'
  }
  if (form.phone.trim() && !/^1[3-9]\d{9}$/.test(form.phone.trim())) issues.phone = '请输入有效的11位手机号码'
  errors.value = issues
  if (Object.keys(issues).length) return
  submitting.value = true; submitError.value = ''
  try {
    const created = await createRepair(form)
    if (!active) return
    Object.assign(form, blank()); page.value = 'records'; message.value = '工单已提交成功。'; loadUnread()
    if (photos.value.length) {
      uploadOrder.value = created
      await sendPhotos(false)
    }
    await loadRepairs()
  } catch (issue) { if (active && !isCancelled(issue)) submitError.value = issue.message }
  finally { if (active) submitting.value = false }
}
</script>

<template>
  <header class="topbar"><div class="header-inner">
    <a class="brand" href="#" @click.prevent="navigate('home')"><span class="brand-icon">修</span><span>宿舍报修管理系统<small>校园生活服务平台</small></span></a>
    <nav aria-label="主导航"><button v-for="(label, target) in navigation" :key="target" :data-page="target" :class="{ active: page === target }" :aria-current="page === target ? 'page' : undefined" @click="navigate(target)">{{ label }}<span v-if="target === 'messages'" class="notification-badge" :title="unreadError || '未读消息数量'">{{ unreadCount === null ? '—' : unreadCount }}</span></button></nav>
    <div class="identity account-identity"><span>{{ user.display_name }} · {{ roleNames[role] }}</span><button class="secondary" @click="logout">退出登录</button></div>
  </div></header>
  <main>
    <p v-if="message" class="success" role="status">{{ message }}</p>
    <section v-if="uploadOrder" class="panel upload-recovery">
      <p v-if="uploading" class="loading-message" role="status">工单已提交，正在上传照片…</p>
      <p v-if="uploadError" class="request-error" role="alert">{{ uploadError }}</p>
      <ImagePicker v-model="photos" :disabled="uploading" />
      <div class="message-actions"><button class="primary" :disabled="uploading || !photos.length" @click="sendPhotos(true)">重试上传照片</button><button class="secondary" :disabled="uploading" @click="dismissUpload">保留工单，结束本次上传</button></div>
    </section>
    <p v-if="actionError" class="request-error" role="alert">{{ actionError }}</p>
    <MessageCenter v-if="page === 'messages'" @changed="loadUnread" />
    <StatisticsPage v-else-if="page === 'statistics'" :scope-label="role === 'admin' ? '全部工单' : role === 'worker' ? '本人负责工单' : '我的工单'" />
    <AdminWorkers v-else-if="page === 'workers' && role === 'admin'" :workers="workers" :loading="workersLoading" :error="workersError" @refresh="loadWorkers" />
    <template v-else-if="page === 'home'">
      <section class="welcome"><span class="eyebrow">{{ roleNames[role] }}工作台</span><h1>{{ user.display_name }}，欢迎回来。</h1><p>在这里查看工单进度，处理宿舍维修事务。</p><button class="primary" @click="navigate(role === 'student' ? 'submit' : role === 'worker' ? 'pending' : 'orders')">{{ role === 'student' ? '提交报修' : role === 'worker' ? '查看待接单' : '查看全部工单' }}</button></section>
      <section class="stats"><div><span>{{ role === 'worker' ? '我的任务' : role === 'admin' ? '全部工单' : '我的工单' }}</span><strong>{{ ownRecords.length }}<small> 条</small></strong></div><div><span>处理中</span><strong>{{ ownRecords.length - completed }}<small> 条</small></strong></div><div><span>已完成</span><strong>{{ completed }}<small> 条</small></strong></div></section>
      <p v-if="loading" class="loading-message" role="status">正在读取工单…</p>
      <div v-if="loadError" class="request-error" role="alert">{{ loadError }}<button class="secondary" @click="loadRepairs">重试</button></div>
      <section class="features"><button v-for="(label, target) in navigation" v-show="target !== 'home'" :key="target" class="feature" @click="navigate(target)"><h3>{{ label }}</h3><span class="card-link">进入 →</span></button></section>
      <aside class="tip"><strong>处理流程</strong><p>待处理 → 已接单 → 维修中 → 已完成。历史未确认归属工单由管理员管理。</p></aside>
    </template>
    <template v-else-if="page === 'submit' && role === 'student'">
      <div class="page-heading"><h1>提交报修</h1><p>请准确填写宿舍位置和联系方式。</p></div>
      <section class="panel form-panel"><div class="section-heading"><h2>报修信息</h2><span><b class="required">*</b> 为必填项</span></div>
        <p v-if="submitError" class="request-error" role="alert">{{ submitError }}</p>
        <form novalidate :aria-busy="submitting" @submit.prevent="submit"><fieldset :disabled="submitting" class="form-fieldset"><div class="form-grid">
          <div v-for="(label, key) in labels" :key="key" class="field" :class="{ wide: key === 'category' || key === 'description' }">
            <label :for="key">{{ label }} <span class="required">*</span></label>
            <select v-if="key === 'category'" :id="key" v-model="form[key]" required :aria-invalid="!!errors[key]" :aria-describedby="errors[key] ? `${key}-error` : undefined"><option disabled value="">请选择故障类别</option><option v-for="category in categories" :key="category">{{ category }}</option></select>
            <textarea v-else-if="key === 'description'" :id="key" v-model="form[key]" required rows="5" maxlength="500" placeholder="请描述故障位置、具体情况等，方便安排维修。" :aria-invalid="!!errors[key]" :aria-describedby="errors[key] ? `${key}-error` : undefined"></textarea>
            <input v-else :id="key" v-model="form[key]" required :type="key === 'phone' ? 'tel' : 'text'" :maxlength="key === 'phone' ? 11 : 50" :autocomplete="key === 'phone' ? 'tel' : key === 'contact' ? 'name' : 'off'" :placeholder="key === 'building' ? '例如：3号楼' : key === 'room' ? '例如：302' : key === 'phone' ? '请输入11位手机号码' : '请输入联系人姓名'" :aria-invalid="!!errors[key]" :aria-describedby="errors[key] ? `${key}-error` : undefined" />
            <p v-if="errors[key]" :id="`${key}-error`" class="error">{{ errors[key] }}</p><p v-if="key === 'description'" class="char-count">{{ form.description.length }}/500</p>
          </div>
        </div><AiRepairAssistant :description="form.description" :categories="categories" :disabled="submitting" @accept="form.category=$event" /><ImagePicker v-model="photos" :disabled="submitting" /></fieldset><div class="form-actions"><span>提交后可在“我的报修”中查看记录。</span><button class="primary" type="submit" :disabled="submitting || loading || !!uploadOrder">{{ submitting ? '正在提交……' : '提交报修 →' }}</button></div></form>
      </section>

    </template>
    <template v-else>
      <div class="page-heading heading-action"><div><h1>{{ title }}</h1><p v-if="page === 'pending'">这里仅展示接单所需的工单编号、类别、状态和时间。</p><p v-else>查看工单详情及当前处理进度。</p></div><button class="secondary" :disabled="loading || updatingId !== null" @click="loadRepairs">刷新工单</button></div>
      <p v-if="loading" class="loading-message" role="status">正在读取工单…</p>
      <p v-if="loadError" class="request-error" role="alert">{{ loadError }}<button class="secondary" @click="loadRepairs">重试</button></p>
      <div v-if="role === 'admin' && workersError" class="request-error" role="alert">{{ workersError }}<button class="secondary" @click="loadWorkers">重试读取维修账号</button></div>
      <section class="panel">
        <div class="section-heading"><h2>工单列表 <span class="badge">{{ filteredRecords.length }}</span></h2><span>最新提交的记录在前</span></div>
        <div class="filters"><div><label for="status-filter">状态</label><select id="status-filter" v-model="statusFilter"><option value="">全部状态</option><option v-for="status in statuses" :key="status">{{ status }}</option></select></div><div><label for="category-filter">故障类别</label><select id="category-filter" v-model="categoryFilter"><option value="">全部类别</option><option v-for="category in categories" :key="category">{{ category }}</option></select></div><button class="secondary" @click="statusFilter = ''; categoryFilter = ''">重置筛选</button></div>
        <article v-for="record in filteredRecords" :key="record.databaseId" class="record">
          <div class="record-top"><div><span class="category">{{ record.category }}</span><span class="record-id">{{ record.id }}</span></div><span class="status" :class="statusStyles[record.status]">{{ record.status }}</span></div>
          <template v-if="!isPending(record)">
            <p class="description">{{ record.description }}</p>
            <div class="record-meta"><span>宿舍：{{ record.building }} · {{ record.room }}</span><span>联系人：{{ record.contact }}</span><span>联系电话：{{ record.phone }}</span><span>提交时间：{{ record.time }}</span></div>
            <p v-if="role === 'admin'" class="record-meta ownership-note">{{ record.studentId === null ? '历史未确认归属' : '学生账号 #' + record.studentId }} · {{ record.assignedWorkerId === null ? '未分配' : '负责人：' + workerName(record.assignedWorkerId) }}</p>
            <RepairDetails :record="record" :evaluation="role !== 'worker' && record.status === '已完成' ? evaluationState(record.databaseId) : null" @unavailable="handleUnavailable" />
          </template>
          <p v-else class="record-meta pending-time">提交时间：{{ record.time }}</p>
          <div v-if="role === 'worker'" class="order-actions">
            <button v-if="isPending(record)" class="primary" :disabled="updatingId !== null || loading" @click="mutate(record, () => acceptRepair(record.databaseId))">{{ updatingId === record.databaseId ? '正在接单…' : '接单' }}</button>
            <button v-else-if="transitions[record.status]" class="primary" :disabled="updatingId !== null || loading" @click="mutate(record, () => updateRepairStatus(record.databaseId, transitions[record.status].next))">{{ updatingId === record.databaseId ? '正在更新…' : transitions[record.status].label }}</button>
            <span v-else class="closed-note">维修已完成</span>
          </div>
          <div v-if="canAssign(record)" class="assignment-form">
            <label :for="'assign-' + record.databaseId">{{ record.status === '待处理' ? '派单给维修人员' : '改派维修人员' }}</label>
            <select :id="'assign-' + record.databaseId" v-model="selections[record.databaseId]" :disabled="workersLoading || updatingId !== null"><option :value="undefined" disabled>请选择维修人员</option><option v-for="worker in enabledWorkers.filter(item => item.id !== record.assignedWorkerId)" :key="worker.id" :value="worker.id">{{ worker.display_name }}（{{ worker.username }}）</option></select>
            <button class="primary" :disabled="updatingId !== null || loading || workersLoading || !selections[record.databaseId]" @click="assign(record)">{{ updatingId === record.databaseId ? '正在提交…' : record.status === '待处理' ? '派单' : '改派' }}</button>
            <p v-if="!workersLoading && !enabledWorkers.some(item => item.id !== record.assignedWorkerId)" class="evaluation-hint">暂无可选择的维修人员，请到维修人员页面创建账号。</p>
          </div>
          <EvaluationPanel v-if="role !== 'worker' && record.status === '已完成'" :order-id="record.databaseId" :state="evaluationState(record.databaseId)" :read-only="role === 'admin'" @unavailable="handleUnavailable" />
        </article>
        <p v-if="!loading && !loadError && !filteredRecords.length" class="empty">暂无符合条件的工单。</p>
      </section>
    </template>
  </main>
  <footer>宿舍报修管理系统 · 校园生活服务平台</footer>
</template>
