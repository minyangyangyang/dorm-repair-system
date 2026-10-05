<script setup>
import { computed, onMounted, ref } from 'vue'
import { getStatistics } from '../api/repairs.js'

const data = ref(null)
const loading = ref(false)
const error = ref('')
const states = ['待处理', '已接单', '维修中', '已完成']
const colors = { 待处理: 'pending', 已接单: 'accepted', 维修中: 'working', 已完成: 'completed' }
const cards = computed(() => data.value ? [
  { label: '总工单', value: data.value.total, unit: '条' },
  ...states.map(state => ({ label: state, value: data.value.statusDistribution[state], unit: '条' })),
  { label: '完成率', value: data.value.completionRate, unit: '%' },
] : [])
const distributions = computed(() => data.value ? [
  { title: '工单状态分布', values: data.value.statusDistribution },
  { title: '故障类别分布', values: data.value.categoryDistribution },
] : [])

function percentage(count) {
  // 每根柱表示该项占全部工单的比例；空库不进行除法。
  return data.value.total > 0 ? count / data.value.total * 100 : 0
}
async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { data.value = await getStatistics() }
  catch (issue) { error.value = `统计数据加载失败：${issue.message}` }
  finally { loading.value = false }
}
// 页面离开时组件卸载，每次再次进入都会重新挂载并请求最新统计。
onMounted(load)
</script>

<template>
  <section class="statistics-page" :aria-busy="loading">
    <div class="page-heading"><span class="eyebrow">校园报修概况</span><h1>数据统计</h1><p>了解工单处理进度和故障类别分布，数据来自 SQLite 中的真实工单。</p></div>
    <p v-if="loading" class="loading-message" role="status">正在加载统计数据……</p>
    <div v-else-if="error" class="request-error" role="alert"><span>{{ error }}</span><button class="secondary" @click="load">重新加载</button></div>
    <template v-else-if="data">
      <div class="statistics-cards"><div v-for="card in cards" :key="card.label" class="panel statistics-card"><span>{{ card.label }}</span><strong>{{ card.value }}<small>{{ card.unit }}</small></strong></div></div>
      <p v-if="data.total === 0" class="statistics-empty" role="status">暂无报修工单，提交报修后可在这里查看统计。</p>
      <div class="statistics-charts"><section v-for="distribution in distributions" :key="distribution.title" class="panel distribution-panel"><div class="section-heading"><h2>{{ distribution.title }}</h2><span>按工单总数计算占比</span></div><div v-for="(count, label) in distribution.values" :key="label" class="bar-row"><span class="bar-label">{{ label }}</span><div class="bar-track" role="meter" :aria-label="`${label}工单数量`" :aria-valuemin="0" :aria-valuemax="Math.max(data.total, 1)" :aria-valuenow="count" :aria-valuetext="`${count} 条，共 ${data.total} 条`"><div class="bar-fill" :class="colors[label] || 'completed'" :style="{ width: `${percentage(count)}%` }"></div></div><strong class="bar-count">{{ count }}</strong></div></section></div>
      <p class="statistics-footnote">完成率 = 已完成工单 ÷ 总工单 × 100%。每次进入本页都会重新读取统计数据。</p>
    </template>
  </section>
</template>
