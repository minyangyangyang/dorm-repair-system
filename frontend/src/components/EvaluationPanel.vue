<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { getEvaluation, submitEvaluation } from '../api/repairs.js'
import { isCancelled } from '../api/client.js'
const props = defineProps({ orderId: { type: Number, required: true }, state: { type: Object, required: true }, readOnly: Boolean })
const emit = defineEmits(['unavailable'])
const editing = ref(false), rating = ref(0), comment = ref(''), submitting = ref(false), error = ref(''), success = ref('')
let active = true
onBeforeUnmount(() => { active = false; comment.value = '' })
const current = state => active && props.state === state
async function read(state) {
  state.loading = true; state.error = ''
  try {
    const data = await getEvaluation(props.orderId)
    if (current(state)) { state.data = data; state.loaded = true }
  } catch (issue) {
    if (current(state) && !isCancelled(issue)) {
      state.error = issue.message
      if ([403, 404].includes(issue.status)) emit('unavailable', issue)
    }
  } finally { if (current(state)) state.loading = false }
}
function load() { if (!props.state.loading && !submitting.value) read(props.state) }
watch(() => props.state, state => { if (!state.loaded && !state.loading) read(state) }, { immediate: true })
async function submit() {
  if (submitting.value || props.state.data || props.readOnly) return
  error.value = ''
  if (!Number.isInteger(rating.value) || rating.value < 1 || rating.value > 5) { error.value = '请先选择 1–5 星评分'; return }
  if (comment.value.length > 500) { error.value = '评价内容不能超过 500 字'; return }
  const state = props.state
  submitting.value = true
  try {
    const data = await submitEvaluation(props.orderId, rating.value, comment.value)
    if (!current(state)) return
    state.data = data; state.loaded = true; editing.value = false; comment.value = ''
    success.value = '维修评价提交成功，感谢你的反馈！'
  } catch (issue) {
    if (!current(state) || isCancelled(issue)) return
    error.value = issue.message
    if (issue.status === 409) { editing.value = false; await read(state) }
    if ([403, 404].includes(issue.status)) emit('unavailable', issue)
  } finally { if (current(state)) submitting.value = false }
}
</script>

<template>
  <section class="evaluation-panel" aria-label="维修评价">
    <p v-if="state.loading" role="status" class="evaluation-hint">正在读取评价……</p>
    <div v-else-if="state.error" class="request-error" role="alert"><span>{{ state.error }}</span><button class="secondary" @click="load">重新读取评价</button></div>
    <template v-else-if="state.loaded">
      <p v-if="error && !editing" class="error" role="alert">{{ error }}</p>
      <p v-if="success" class="evaluation-success" role="status">{{ success }}</p>
      <div v-if="state.data" class="evaluation-result">
        <strong class="evaluated-label">已评价</strong>
        <p class="rating-display" :aria-label="`${state.data.rating} 星评价`">{{ '★'.repeat(state.data.rating) }}<span>{{ '☆'.repeat(5 - state.data.rating) }}</span><small>{{ state.data.rating }} 分</small></p>
        <p class="evaluation-comment">{{ state.data.comment || '未填写评价内容' }}</p>
      </div>
      <form v-else-if="editing && !readOnly" novalidate :aria-busy="submitting" @submit.prevent="submit">
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
      <p v-else-if="readOnly" class="evaluation-hint">该工单尚未评价。</p>
      <button v-else class="secondary evaluation-open" @click="editing = true; error = ''; success = ''">评价维修</button>
    </template>
  </section>
</template>
