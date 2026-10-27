<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { analyzeRepair } from '../api/ai.js'
import { isCancelled } from '../api/client.js'
const props=defineProps({description:{type:String,default:''},categories:{type:Array,required:true},disabled:Boolean})
const emit=defineEmits(['accept'])
const loading=ref(false),result=ref(null),error=ref(''),message=ref('')
let active=true,sequence=0
watch(()=>props.description,()=>{sequence++;result.value=null;error.value='';message.value=''})
onBeforeUnmount(()=>{active=false;sequence++;result.value=null;error.value=''})
async function analyze() {
  if(loading.value||props.disabled)return
  const description=props.description.trim()
  result.value=null;error.value='';message.value=''
  if(description.length<8||description.length>500){error.value='请补充 8–500 个字符的故障现象后再分析。';return}
  const started=++sequence
  loading.value=true
  try{
    const data=await analyzeRepair(description)
    if(!active||started!==sequence)return
    if(!['rules','remote'].includes(data.mode)||!props.categories.includes(data.recommended_category)||
      !Array.isArray(data.possible_causes)||!data.possible_causes.length||data.possible_causes.length>3||
      data.possible_causes.some(item=>typeof item!=='string'||item.length>100)||
      typeof data.advice!=='string'||data.advice.length>300)throw new Error('分析结果格式不正确，可继续手动报修。')
    result.value=data
  }catch(issue){if(active&&started===sequence&&!isCancelled(issue))error.value=issue.message}
  finally{if(active)loading.value=false}
}
function accept(){
  if(result.value&&props.categories.includes(result.value.recommended_category)){
    emit('accept',result.value.recommended_category);message.value='已采用推荐类别，你仍可手动修改。'
  }
}
function ignore(){result.value=null;message.value='已忽略建议，请按实际情况填写报修。'}
</script>
<template>
  <section class="ai-repair-assistant" aria-label="AI 智能报修助手">
    <div class="section-heading"><h3>AI 智能报修助手</h3><button class="secondary" type="button" :disabled="disabled||loading" @click="analyze">{{ loading?'正在分析…':'AI 智能分析' }}</button></div>
    <p class="evaluation-hint">AI 建议仅供参考，不代替专业判断。仅分析故障描述，请勿填写姓名、电话或宿舍号；可直接跳过分析提交报修。</p>
    <p v-if="loading" class="loading-message" role="status">正在分析故障描述，仍可继续填写或提交报修…</p>
    <p v-if="error" class="request-error" role="alert">{{ error }}</p>
    <p v-if="message" class="success" role="status">{{ message }}</p>
    <div v-if="result" class="ai-result">
      <strong class="ai-mode">{{ result.mode==='rules'?'规则演示（非大模型）':'真实 AI 分析' }}</strong>
      <p>推荐类别：<strong>{{ result.recommended_category }}</strong></p>
      <h4>可能原因</h4><ul><li v-for="cause in result.possible_causes" :key="cause">{{ cause }}</li></ul>
      <h4>安全处理建议</h4><p>{{ result.advice }}</p>
      <p v-if="result.safety_adjusted" class="evaluation-hint">检测到潜在风险，已采用后端保守安全提示。</p>
      <p class="evaluation-hint">AI 建议仅供参考；可能原因由分类结果映射，处理建议为后端安全预设。</p>
      <div class="message-actions"><button class="secondary" type="button" :disabled="disabled" @click="accept">采用推荐类别</button><button class="secondary" type="button" @click="ignore">忽略建议</button></div>
    </div>
  </section>
</template>
