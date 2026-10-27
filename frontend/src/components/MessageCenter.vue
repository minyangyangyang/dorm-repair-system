<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getNotifications, markNotificationRead, markAllNotificationsRead } from '../api/notifications.js'
import { getRepair } from '../api/repairs.js'
import { isCancelled } from '../api/client.js'
import { formatTime } from '../utils/time.js'
import RepairDetails from './RepairDetails.vue'
const emit = defineEmits(['changed'])
const items = ref([]), page = ref(1), hasMore = ref(false), loading = ref(false), error = ref('')
const marking = ref(null), message = ref(''), linkedRecord = ref(null), linkError = ref(''), opening = ref(null)
let active = true, sequence = 0, linkSequence = 0
onBeforeUnmount(() => { active = false; sequence++; linkSequence++; items.value = []; linkedRecord.value = null })
async function load(target = page.value) {
  const started = ++sequence
  linkSequence++; linkedRecord.value = null; linkError.value = ''; opening.value = null
  loading.value = true; error.value = ''
  try {
    const result = await getNotifications(target)
    if (!active || started !== sequence) return
    items.value = result.items; page.value = result.page; hasMore.value = result.has_more
    emit('changed')
  } catch (issue) {
    if (active && started === sequence && !isCancelled(issue)) { error.value = issue.message; items.value = [] }
  } finally { if (active && started === sequence) loading.value = false }
}
onMounted(() => load(1))
async function mark(item) {
  if (marking.value !== null || item.read_at) return
  marking.value = item.id; error.value = ''
  try {
    const updated = await markNotificationRead(item.id)
    if (!active) return
    item.read_at = updated.read_at; emit('changed')
  } catch (issue) { if (active && !isCancelled(issue)) error.value = issue.message }
  finally { if (active) marking.value = null }
}
async function markAll() {
  if (marking.value !== null) return
  marking.value = 'all'; error.value = ''; message.value = ''
  try {
    await markAllNotificationsRead()
    if (!active) return
    message.value = '全部消息已标记为已读。'; emit('changed'); await load()
  } catch (issue) { if (active && !isCancelled(issue)) error.value = issue.message }
  finally { if (active) marking.value = null }
}
function unavailable(issue) {
  linkedRecord.value = null
  linkError.value = issue?.message || '关联工单已不可访问。'
}
async function open(item) {
  const started = ++linkSequence
  linkedRecord.value = null; linkError.value = ''; opening.value = item.id
  try {
    // Never trust a notification as authorization: re-fetch the order using its current permissions.
    const record = await getRepair(item.repair_order_id)
    if (active && started === linkSequence) linkedRecord.value = record
  } catch (issue) {
    if (active && started === linkSequence && !isCancelled(issue)) {
      linkError.value = [403, 404].includes(issue.status) ? '该工单已改派或当前账号无权查看，请返回任务列表确认。' : issue.message
    }
  } finally { if (active && started === linkSequence) opening.value = null }
}
</script>

<template>
  <section class="message-center">
    <div class="page-heading heading-action"><div><h1>消息中心</h1><p>仅显示当前账号的站内通知，可手动刷新获取最新消息。</p></div><div class="message-actions"><button class="secondary" :disabled="loading || marking !== null" @click="load(1)">刷新消息</button><button class="secondary" :disabled="loading || marking !== null" @click="markAll">{{ marking === 'all' ? '正在标记…' : '全部已读' }}</button></div></div>
    <p v-if="message" class="success" role="status">{{ message }}</p>
    <p v-if="loading" class="loading-message" role="status">正在读取消息…</p>
    <p v-if="error" class="request-error" role="alert">{{ error }}</p>
    <section class="panel">
      <article v-for="item in items" :key="item.id" class="record notification-row" :data-notification-id="item.id">
        <div class="record-top"><h2>{{ item.title }}</h2><span class="status" :class="item.read_at ? 'completed' : 'pending'">{{ item.read_at ? '已读' : '未读' }}</span></div>
        <p class="description">{{ item.content }}</p>
        <p class="record-meta"><time :datetime="item.created_at">{{ formatTime(item.created_at) }}</time><span v-if="item.read_at">已读时间：{{ formatTime(item.read_at) }}</span></p>
        <div class="message-actions"><button v-if="!item.read_at" class="secondary" :disabled="loading || marking !== null" @click="mark(item)">{{ marking === item.id ? '正在标记…' : '标记已读' }}</button><button class="secondary" :disabled="loading || opening !== null" @click="open(item)">{{ opening === item.id ? '正在读取…' : '查看关联工单' }}</button></div>
      </article>
      <p v-if="!loading && !error && !items.length" class="empty">暂无消息。</p>
    </section>
    <div class="message-pagination"><button class="secondary" :disabled="page <= 1 || loading || marking !== null" @click="load(page - 1)">上一页</button><span>第 {{ page }} 页</span><button class="secondary" :disabled="!hasMore || loading || marking !== null" @click="load(page + 1)">下一页</button></div>
    <p v-if="linkError" class="request-error" role="alert">{{ linkError }}</p>
    <section v-if="linkedRecord" class="panel message-linked-order"><h2>关联工单 {{ linkedRecord.id }}</h2><p class="record-meta">{{ linkedRecord.status }}</p><RepairDetails :key="linkedRecord.databaseId + ':' + linkedRecord.updatedAt" :record="linkedRecord" @unavailable="unavailable" /></section>
  </section>
</template>
