<script setup>
import { computed, reactive, ref } from 'vue'

const page = ref('home')
const role = ref('student')
const navigation = computed(() => role.value === 'student'
  ? { home: '首页', submit: '提交报修', records: '我的报修' }
  : { home: '首页', orders: '维修工单' })
const statuses = ['待处理', '已接单', '维修中', '已完成']
const statusFilter = ref('')
const categoryFilter = ref('')
const categories = ['水电', '家具', '网络', '门窗', '其他']
const records = ref([
  { id: 'BX20261002001', building: '3号楼', room: '302', category: '水电', description: '卫生间水龙头关闭后仍然滴水，希望安排检查。', time: '2026-10-02 09:30', status: '待处理' },
  { id: 'BX20261001002', building: '3号楼', room: '302', category: '网络', description: '宿舍网络连接不稳定，晚间经常断线。', time: '2026-10-01 18:20', status: '已接单' },
  { id: 'BX20260930003', building: '3号楼', room: '302', category: '家具', description: '书桌抽屉滑轨松动，无法正常拉出。', time: '2026-09-30 14:10', status: '维修中' },
  { id: 'BX20260928004', building: '3号楼', room: '302', category: '门窗', description: '阳台窗户锁扣损坏，需要更换。', time: '2026-09-28 10:45', status: '已完成' },
])
// 示例联系人使用虚构姓名和演示号码；学生新提交的工单使用表单信息。
records.value.forEach(record => Object.assign(record, { contact: '演示同学', phone: '13800000000' }))
const statusCounts = computed(() => Object.fromEntries(statuses.map(status =>
  [status, records.value.filter(record => record.status === status).length])))
const filteredRecords = computed(() => records.value.filter(record =>
  (!statusFilter.value || record.status === statusFilter.value) &&
  (!categoryFilter.value || record.category === categoryFilter.value)))
// 每个状态只配置唯一的下一步，不提供跳级或回退入口。
const transitions = {
  待处理: { next: '已接单', label: '接单' },
  已接单: { next: '维修中', label: '开始维修' },
  维修中: { next: '已完成', label: '完成维修' },
}
function switchRole() {
  page.value = 'home'
  message.value = ''
  statusFilter.value = ''
  categoryFilter.value = ''
}
function advanceStatus(id, expectedStatus) {
  if (role.value !== 'worker') return
  const record = records.value.find(item => item.id === id)
  // 校验操作时的状态，避免旧按钮或重复操作推动状态。
  if (!record || record.status !== expectedStatus) return
  const transition = transitions[record.status]
  if (!transition) return
  record.status = transition.next
  message.value = `工单 ${record.id} ${transition.label}成功，当前状态：${record.status}。`
}
const completed = computed(() => records.value.filter(item => item.status === '已完成').length)
const labels = { building: '宿舍楼', room: '房间号', category: '故障类别', description: '问题描述', contact: '联系人', phone: '联系电话' }
const blank = () => Object.fromEntries(Object.keys(labels).map(key => [key, '']))
const form = reactive(blank())
const errors = ref({})
const message = ref('')
const statusStyles = { 待处理: 'pending', 已接单: 'accepted', 维修中: 'working', 已完成: 'completed' }
function navigate(target) { page.value = target; message.value = '' }
function submit() {
  const issues = {}
  for (const [key, label] of Object.entries(labels)) {
    if (!form[key].trim()) issues[key] = `请填写${label}`
  }
  if (form.phone.trim() && !/^1[3-9]\d{9}$/.test(form.phone.trim())) issues.phone = '请输入有效的11位手机号码'
  errors.value = issues
  if (Object.keys(issues).length) return
  const now = new Date()
  const pad = number => String(number).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  let sequence = 1
  let id = `BX${date}${String(sequence).padStart(3, '0')}`
  while (records.value.some(item => item.id === id)) id = `BX${date}${String(++sequence).padStart(3, '0')}`
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  records.value.unshift({ ...Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])), id, time, status: '待处理' })
  Object.assign(form, blank())
  page.value = 'records'
  message.value = `报修提交成功，报修编号：${id}`
}
</script>

<template>
  <header class="topbar"><div class="header-inner">
    <a class="brand" href="#" @click.prevent="navigate('home')"><span class="brand-icon" aria-hidden="true">修</span><span>宿舍报修管理系统<small>校园生活服务平台</small></span></a>
    <nav aria-label="主导航"><button v-for="(title, target) in navigation" :key="target" :class="{ active: page === target }" :aria-current="page === target ? 'page' : undefined" @click="navigate(target)">{{ title }}</button></nav>
    <div class="identity role-switch"><label for="role">当前身份</label><select id="role" v-model="role" @change="switchRole"><option value="student">学生</option><option value="worker">维修人员</option></select><small>演示切换</small></div>
  </div></header>
  <main>
    <template v-if="role === 'worker'">
      <template v-if="page === 'home'">
        <section class="welcome"><span class="eyebrow">维修人员服务</span><h1>及时响应，让宿舍生活更安心。</h1><p>维修师傅，你好！欢迎进入维修人员端。<br>查看宿舍工单，按步骤更新维修进度。</p><button class="primary" @click="navigate('orders')">查看维修工单 →</button><span class="decoration" aria-hidden="true">⌂</span></section>
        <section class="stats worker-stats" aria-label="工单状态概况"><div v-for="status in statuses" :key="status"><span>{{ status }}工单</span><strong>{{ statusCounts[status] }}<small> 条</small></strong></div></section>
        <section class="features"><button class="feature" @click="navigate('orders')"><span class="feature-icon" aria-hidden="true">≡</span><h3>维修工单列表</h3><p>查看全部工单，按状态和故障类别筛选。</p><span class="card-link">处理工单 →</span></button></section>
        <aside class="tip"><strong>处理流程</strong><p>待处理 → 已接单 → 维修中 → 已完成。请按实际维修进度操作，已完成的工单无法再次处理。</p></aside>
      </template>
      <template v-else>
        <div class="page-heading"><span class="eyebrow">维修任务</span><h1>维修工单</h1><p>查看全部报修申请，按步骤处理并更新工单状态。</p></div>
        <p v-if="message" class="success" role="status" aria-live="polite" aria-atomic="true">{{ message }}</p>
        <section class="panel">
          <div class="section-heading"><h2>工单列表 <span class="badge">{{ filteredRecords.length }} / {{ records.length }}</span></h2><span>新提交的记录在前</span></div>
          <div class="filters"><div><label for="status-filter">状态</label><select id="status-filter" v-model="statusFilter"><option value="">全部状态</option><option v-for="status in statuses" :key="status">{{ status }}</option></select></div><div><label for="category-filter">故障类别</label><select id="category-filter" v-model="categoryFilter"><option value="">全部类别</option><option v-for="category in categories" :key="category">{{ category }}</option></select></div><button class="secondary" @click="statusFilter = ''; categoryFilter = ''">重置筛选</button></div>
          <article v-for="record in filteredRecords" :key="record.id" class="record">
            <div class="record-top"><div><span class="category">{{ record.category }}</span><span class="record-id">{{ record.id }}</span></div><span class="status" :class="statusStyles[record.status]">{{ record.status }}</span></div>
            <p class="description">{{ record.description }}</p>
            <div class="record-meta"><span>宿舍：{{ record.building }} · {{ record.room }}</span><span>联系人：{{ record.contact }}</span><span>联系电话：{{ record.phone }}</span><span>提交时间：{{ record.time }}</span></div>
            <div class="order-actions"><button v-if="transitions[record.status]" class="primary" :aria-label="`${transitions[record.status].label}，工单${record.id}`" @click="advanceStatus(record.id, record.status)">{{ transitions[record.status].label }}</button><span v-else class="closed-note">维修已完成，无需继续操作</span></div>
          </article>
          <p v-if="!filteredRecords.length" class="empty">暂无符合筛选条件的工单，请调整或重置筛选。</p>
        </section>
      </template>
    </template>
    <template v-else-if="page === 'home'">
      <section class="welcome"><span class="eyebrow">STUDENT SERVICE · 学生服务</span><h1>让宿舍问题，及时得到解决。</h1><p>同学，你好！欢迎使用宿舍报修管理系统。<br>提交宿舍设施问题，随时查看维修进度。</p><button class="primary" @click="navigate('submit')">提交报修 →</button><span class="decoration" aria-hidden="true">⌂</span></section>
      <section class="stats" aria-label="报修概况"><div><span>累计报修</span><strong>{{ records.length }}<small> 条</small></strong></div><div><span>处理中</span><strong>{{ records.length - completed }}<small> 条</small></strong></div><div><span>已完成</span><strong>{{ completed }}<small> 条</small></strong></div></section>
      <div class="section-heading"><h2>常用功能</h2><span>宿舍报修，轻松办理</span></div>
      <section class="features"><button class="feature" @click="navigate('submit')"><span class="feature-icon" aria-hidden="true">＋</span><h3>提交报修</h3><p>填写故障信息，提交新的宿舍报修申请。</p><span class="card-link">开始填写 →</span></button><button class="feature" @click="navigate('records')"><span class="feature-icon blue" aria-hidden="true">≡</span><h3>我的报修</h3><p>查看已提交的报修记录，了解当前处理状态。</p><span class="card-link">查看记录 →</span></button></section>
      <aside class="tip"><strong>报修小提示</strong><p>请准确填写宿舍位置和联系方式，并尽量详细描述故障，方便维修人员了解问题。</p></aside>
    </template>
    <template v-else-if="page === 'submit'">
      <div class="page-heading"><span class="eyebrow">NEW REQUEST · 新建申请</span><h1>提交报修</h1><p>填写以下信息，记录你的宿舍维修需求。</p></div>
      <section class="panel form-panel"><div class="section-heading"><h2>报修信息</h2><span><b class="required">*</b> 为必填项</span></div>
        <form novalidate @submit.prevent="submit"><div class="form-grid">
          <div v-for="(label, key) in labels" :key="key" class="field" :class="{ wide: key === 'category' || key === 'description' }">
            <label :for="key">{{ label }} <span class="required">*</span></label>
            <select v-if="key === 'category'" :id="key" v-model="form[key]" required :aria-invalid="!!errors[key]" :aria-describedby="errors[key] ? `${key}-error` : undefined"><option disabled value="">请选择故障类别</option><option v-for="category in categories" :key="category">{{ category }}</option></select>
            <textarea v-else-if="key === 'description'" :id="key" v-model="form[key]" required rows="5" maxlength="500" placeholder="请描述故障位置、具体情况等，方便安排维修。" :aria-invalid="!!errors[key]" :aria-describedby="errors[key] ? `${key}-error` : undefined"></textarea>
            <input v-else :id="key" v-model="form[key]" required :type="key === 'phone' ? 'tel' : 'text'" :maxlength="key === 'phone' ? 11 : 50" :autocomplete="key === 'phone' ? 'tel' : key === 'contact' ? 'name' : 'off'" :placeholder="key === 'building' ? '例如：3号楼' : key === 'room' ? '例如：302' : key === 'phone' ? '请输入11位手机号码' : '请输入联系人姓名'" :aria-invalid="!!errors[key]" :aria-describedby="errors[key] ? `${key}-error` : undefined" />
            <p v-if="errors[key]" :id="`${key}-error`" class="error">{{ errors[key] }}</p><p v-if="key === 'description'" class="char-count">{{ form.description.length }}/500</p>
          </div>
        </div><div class="form-actions"><span>提交后可在“我的报修”中查看记录。</span><button class="primary" type="submit">提交报修 →</button></div></form>
      </section>
    </template>
    <template v-else>
      <div class="page-heading heading-action"><div><span class="eyebrow">MY REQUESTS · 申请记录</span><h1>我的报修</h1><p>查看你的报修申请及当前处理状态。</p></div><button class="primary" @click="navigate('submit')">＋ 提交报修</button></div>
      <p v-if="message" class="success" role="status">{{ message }}</p>
      <section class="panel"><div class="section-heading"><h2>全部记录 <span class="badge">{{ records.length }}</span></h2><span>新提交的记录在前</span></div><article v-for="record in records" :key="record.id" class="record"><div class="record-top"><div><span class="category">{{ record.category }}</span><span class="record-id">{{ record.id }}</span></div><span class="status" :class="statusStyles[record.status]">{{ record.status }}</span></div><p class="description">{{ record.description }}</p><div class="record-meta"><span>宿舍：{{ record.building }} · {{ record.room }}</span><span>提交时间：{{ record.time }}</span></div></article><p v-if="!records.length" class="empty">暂无报修记录，点击“提交报修”创建第一条申请。</p></section>
    </template>
    <p class="demo-note">课程设计 · {{ role === 'student' ? '学生端' : '维修人员端' }}演示｜身份切换仅用于演示；当前使用模拟数据，刷新页面后会恢复初始记录。</p>
  </main><footer>宿舍报修管理系统 · 让校园生活更安心</footer>
</template>
