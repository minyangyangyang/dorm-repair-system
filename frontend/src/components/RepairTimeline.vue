<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getTimeline } from '../api/repairs.js'
import { isCancelled } from '../api/client.js'
import { formatTime } from '../utils/time.js'

const props = defineProps({ orderId: { type: Number, required: true }, status: { type: String, required: true } })
const data = ref(null), loading = ref(false), error = ref('')
const labels = { created: '提交报修', accepted: '维修人员接单', assigned: '管理员派单',
  reassigned: '管理员改派', started: '开始维修', completed: '维修完成' }
const roles = { student: '学生', worker: '维修人员', admin: '管理员' }
const states = ['待处理', '已接单', '维修中', '已完成']
const steps = [
  { label: '提交报修', events: ['created'] }, { label: '接单或派单', events: ['accepted', 'assigned'] },
  { label: '开始维修', events: ['started'] }, { label: '维修完成', events: ['completed'] },
]
const milestones = computed(() => steps.map((step, index) => {
  const recorded = data.value?.events.some(event => step.events.includes(event.event_type))
  return { label: step.label, state: recorded ? '已记录' :
    index <= states.indexOf(props.status) ? '缺少记录' : '未完成' }
}))
let sequence = 0
onBeforeUnmount(() => { sequence++; data.value = null })
async function load() {
  const started = ++sequence
  loading.value = true; error.value = ''; data.value = null
  try { const result = await getTimeline(props.orderId); if (started === sequence) data.value = result }
  catch (issue) { if (started === sequence && !isCancelled(issue)) error.value = issue.message }
  finally { if (started === sequence) loading.value = false }
}
onMounted(load)
watch(() => [props.orderId, props.status], load)
</script>

<template>
  <section class="repair-timeline" aria-label="维修进度时间轴">
    <h3>维修进度时间轴</h3>
    <p v-if="loading" class="evaluation-hint" role="status">正在读取维修记录…</p>
    <div v-else-if="error" class="request-error" role="alert"><span>维修记录加载失败：{{ error }}。工单基本详情仍可查看。</span><button class="secondary" @click="load">重试时间轴</button></div>
    <template v-else-if="data">
      <p v-if="data.redacted" class="evaluation-hint">接单前不公开维修记录。</p>
      <template v-else>
        <p v-if="data.history_incomplete" class="timeline-history">历史记录不完整：系统仅展示开始记录后实际发生的操作，不补造过去的时间或操作者。</p>
        <ul class="timeline-steps" aria-label="流程完成情况"><li v-for="step in milestones" :key="step.label"><span>{{ step.label }}</span><strong :class="{ 'timeline-pending': step.state === '未完成' }">{{ step.state }}</strong></li></ul>
        <p v-if="!data.events.length" class="evaluation-hint">暂无可核实的操作日志。工单当前状态不代表历史操作时间已被记录。</p>
        <ol v-else class="timeline-events">
          <li v-for="event in data.events" :key="event.id">
            <strong>{{ labels[event.event_type] || '维修操作' }}</strong>
            <time :datetime="event.occurred_at">{{ formatTime(event.occurred_at) }}</time>
            <p>{{ roles[event.actor.role] }} · {{ event.actor.display_name }}</p>
            <p v-if="event.event_type === 'assigned' || event.event_type === 'reassigned'">负责人{{ event.summary.from_worker_id === null ? '' : '由账号 #' + event.summary.from_worker_id }} → 账号 #{{ event.summary.to_worker_id }}</p>
          </li>
        </ol>
      </template>
    </template>
  </section>
</template>
