<script setup>
import { ref, watch } from 'vue'
import { getEvaluation, submitEvaluation } from '../api/repairs.js'

const props = defineProps({ orderId: { type: Number, required: true }, state: { type: Object, required: true } })
const editing = ref(false)
const rating = ref(0)
const comment = ref('')
const submitting = ref(false)
const error = ref('')
const success = ref('')

async function load() {
  if (props.state.loading || submitting.value) return
  props.state.loading = true
  props.state.error = ''
  try {
    props.state.data = await getEvaluation(props.orderId)
    props.state.loaded = true
  } catch (issue) { props.state.error = `读取评价失败：${issue.message}` }
  finally { props.state.loading = false }
}
// 父页面按工单缓存查询结果，切换页面或身份不会反复请求同一评价。
watch(() => props.state, state => {
  if (!state.loaded && !state.error) load()
}, { immediate: true })

async function submit() {
  if (submitting.value || props.state.data) return
  error.value = ''
  if (!Number.isInteger(rating.value) || rating.value < 1 || rating.value > 5) {
    error.value = '请先选择 1～5 星评分'
    return
  }
  if (comment.value.length > 500) { error.value = '评价内容不能超过 500 字'; return }
  submitting.value = true
  try {
    const evaluation = await submitEvaluation(props.orderId, rating.value, comment.value)
    props.state.data = evaluation
    props.state.loaded = true
    editing.value = false
    success.value = '维修评价提交成功，感谢你的反馈！'
  } catch (issue) { error.value = `评价提交失败：${issue.message}` }
  finally { submitting.value = false }
}
</script>

<template>
  <section class="evaluation-panel" aria-label="维修评价">
    <p v-if="state.loading" role="status" class="evaluation-hint">正在读取评价……</p>
    <div v-else-if="state.error" class="request-error" role="alert"><span>{{ state.error }}</span><button class="secondary" @click="load">重新读取评价</button></div>
    <template v-else-if="state.loaded">
      <p v-if="success" class="evaluation-success" role="status">{{ success }}</p>
      <div v-if="state.data" class="evaluation-result">
        <strong class="evaluated-label">已评价</strong>
        <p class="rating-display" :aria-label="`${state.data.rating} 星评价`">{{ '★'.repeat(state.data.rating) }}<span>{{ '☆'.repeat(5 - state.data.rating) }}</span><small>{{ state.data.rating }} 分</small></p>
        <p class="evaluation-comment">{{ state.data.comment || '未填写评价内容' }}</p>
      </div>
      <form v-else-if="editing" novalidate :aria-busy="submitting" @submit.prevent="submit">
        <fieldset class="form-fieldset" :disabled="submitting">
          <legend class="evaluation-title">评价本次维修</legend>
          <div class="star-options" role="group" aria-label="选择评分，1 到 5 星">
            <button v-for="star in 5" :key="star" type="button" :class="{ selected: star <= rating }" :aria-label="`${star} 星`" :aria-pressed="rating === star" @click="rating = star">{{ star <= rating ? '★' : '☆' }}</button>
            <span>{{ rating ? `${rating} 分` : '请选择评分' }}</span>
          </div>
          <label :for="`evaluation-comment-${orderId}`">评价内容 <span class="evaluation-hint">（选填）</span></label>
          <textarea :id="`evaluation-comment-${orderId}`" v-model="comment" maxlength="500" rows="3" placeholder="说说这次维修的体验吧"></textarea>
          <p class="char-count">{{ comment.length }}/500</p>
        </fieldset>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="evaluation-actions"><button class="primary" type="submit" :disabled="submitting">{{ submitting ? '正在提交……' : '提交评价' }}</button><button class="secondary" type="button" :disabled="submitting" @click="editing = false; error = ''">取消</button></div>
      </form>
      <button v-else class="secondary evaluation-open" @click="editing = true; error = ''; success = ''">评价维修</button>
    </template>
  </section>
</template>
