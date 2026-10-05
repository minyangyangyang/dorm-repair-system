<script setup>
import { computed, ref } from 'vue'
import { formatTime } from '../utils/time.js'

const props = defineProps({ record: { type: Object, required: true }, evaluation: { type: Object, default: null } })
const expanded = ref(false)
const fields = computed(() => [
  ['工单编号', props.record.id], ['当前状态', props.record.status],
  ['宿舍楼', props.record.building], ['房间号', props.record.room],
  ['故障类别', props.record.category], ['联系人', props.record.contact],
  ['联系电话', props.record.phone], ['创建时间', formatTime(props.record.createdAt)],
  ['更新时间', formatTime(props.record.updatedAt)],
])
</script>

<template>
  <div class="repair-details">
    <button class="secondary details-toggle" :aria-expanded="expanded" :aria-controls="`repair-details-${record.databaseId}`" @click="expanded = !expanded">{{ expanded ? '收起详情' : '查看详情' }}</button>
    <section v-if="expanded" :id="`repair-details-${record.databaseId}`" class="details-card" :aria-labelledby="`details-title-${record.databaseId}`">
      <div class="section-heading"><h2 :id="`details-title-${record.databaseId}`">报修详情</h2><button class="secondary details-close" @click="expanded = false">关闭详情</button></div>
      <dl class="details-fields"><div v-for="[label, value] in fields" :key="label"><dt>{{ label }}</dt><dd>{{ value || '未填写' }}</dd></div><div class="details-wide"><dt>故障描述</dt><dd class="details-description">{{ record.description || '未填写' }}</dd></div></dl>
      <section v-if="evaluation && record.status === '已完成'" class="details-evaluation">
        <h3>维修评价</h3>
        <p v-if="evaluation.loading || (!evaluation.loaded && !evaluation.error)" class="evaluation-hint">正在读取评价……</p>
        <p v-else-if="evaluation.error" class="error" role="alert">{{ evaluation.error }}，请在下方评价区域重新读取。</p>
        <template v-else-if="evaluation.data"><strong class="evaluated-label">已评价</strong><p class="rating-display" :aria-label="`${evaluation.data.rating} 星`">{{ '★'.repeat(evaluation.data.rating) }}<span>{{ '☆'.repeat(5 - evaluation.data.rating) }}</span><small>{{ evaluation.data.rating }} 分</small></p><p class="evaluation-comment">{{ evaluation.data.comment || '未填写评价内容' }}</p><p class="evaluation-hint">评价时间：{{ formatTime(evaluation.data.created_at) }}</p></template>
        <p v-else class="evaluation-hint">暂未评价，可在下方评价区域提交。</p>
      </section>
    </section>
  </div>
</template>
