<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { formatTime } from '../utils/time.js'
import RepairTimeline from './RepairTimeline.vue'
import { getRepair } from '../api/repairs.js'
import { isCancelled } from '../api/client.js'
const props = defineProps({ record: { type: Object, required: true }, evaluation: { type: Object, default: null } })
const emit = defineEmits(['unavailable'])
const expanded = ref(false), loading = ref(false), error = ref(''), detail = ref(null)
let sequence = 0
const displayRecord = computed(() => detail.value || props.record)
const fields = computed(() => [
  ['工单编号', displayRecord.value.id], ['当前状态', displayRecord.value.status],
  ['宿舍楼', displayRecord.value.building], ['房间号', displayRecord.value.room],
  ['故障类别', displayRecord.value.category], ['联系人', displayRecord.value.contact],
  ['联系电话', displayRecord.value.phone], ['创建时间', formatTime(displayRecord.value.createdAt)],
  ['更新时间', formatTime(displayRecord.value.updatedAt)],
])
function close() { expanded.value = false; sequence++; detail.value = null; error.value = ''; loading.value = false }
watch(() => [props.record.databaseId, props.record.updatedAt], close)
onBeforeUnmount(close)
async function load() {
  const started = ++sequence
  loading.value = true; error.value = ''
  try {
    const result = await getRepair(props.record.databaseId)
    if (started === sequence) detail.value = result
  } catch (issue) {
    if (started === sequence && !isCancelled(issue)) {
      error.value = issue.message; detail.value = null
      if ([403, 404].includes(issue.status)) emit('unavailable', issue)
    }
  } finally { if (started === sequence) loading.value = false }
}
function toggle() { if (expanded.value) close(); else { expanded.value = true; load() } }
</script>

<template>
  <div class="repair-details">
    <button class="secondary details-toggle" :aria-expanded="expanded" :aria-controls="`repair-details-${displayRecord.databaseId}`" @click="toggle">{{ expanded ? '收起详情' : '查看详情' }}</button>
    <section v-if="expanded" :id="`repair-details-${displayRecord.databaseId}`" class="details-card" :aria-labelledby="`details-title-${displayRecord.databaseId}`">
      <div class="section-heading"><h2 :id="`details-title-${displayRecord.databaseId}`">报修详情</h2><button class="secondary details-close" @click="close">关闭详情</button></div>
      <p v-if="loading" class="loading-message" role="status">正在读取详情…</p><div v-if="error" class="request-error" role="alert">{{ error }}<button class="secondary" @click="load">重试详情</button></div>
      <dl v-if="!loading && !error" class="details-fields"><div v-for="[label, value] in fields" :key="label"><dt>{{ label }}</dt><dd>{{ value || '未填写' }}</dd></div><div class="details-wide"><dt>故障描述</dt><dd class="details-description">{{ displayRecord.description || '未填写' }}</dd></div></dl>
      <RepairTimeline v-if="!loading && !error" :key="displayRecord.databaseId + ':' + displayRecord.updatedAt" :order-id="displayRecord.databaseId" :status="displayRecord.status" />
      <section v-if="evaluation && displayRecord.status === '已完成'" class="details-evaluation">
        <h3>维修评价</h3>
        <p v-if="evaluation.loading || (!evaluation.loaded && !evaluation.error)" class="evaluation-hint">正在读取评价……</p>
        <p v-else-if="evaluation.error" class="error" role="alert">{{ evaluation.error }}，请在下方评价区域重新读取。</p>
        <template v-else-if="evaluation.data"><strong class="evaluated-label">已评价</strong><p class="rating-display" :aria-label="`${evaluation.data.rating} 星`">{{ '★'.repeat(evaluation.data.rating) }}<span>{{ '☆'.repeat(5 - evaluation.data.rating) }}</span><small>{{ evaluation.data.rating }} 分</small></p><p class="evaluation-comment">{{ evaluation.data.comment || '未填写评价内容' }}</p><p class="evaluation-hint">评价时间：{{ formatTime(evaluation.data.created_at) }}</p></template>
        <p v-else class="evaluation-hint">该工单尚未评价。</p>
      </section>
    </section>
  </div>
</template>
