<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { getAttachments, getAttachmentBlob } from '../api/attachments.js'
import { isCancelled } from '../api/client.js'
const props=defineProps({orderId:{type:Number,required:true}})
const images=ref([]),loading=ref(false),error=ref(''),selected=ref(null),dialog=ref(null)
let sequence=0
function clear() {for(const image of images.value)URL.revokeObjectURL(image.url);images.value=[];selected.value=null;dialog.value?.close()}
onBeforeUnmount(()=>{sequence++;clear()})
async function load() {
  const started=++sequence
  clear();loading.value=true;error.value=''
  const allocated=[]
  try {
    const files=await getAttachments(props.orderId)
    for(const file of files) {
      const blob=await getAttachmentBlob(props.orderId,file.id)
      if(started!==sequence)return
      const image={...file,url:URL.createObjectURL(blob)}
      allocated.push(image)
    }
    if(started===sequence)images.value=allocated
  } catch(issue) {
    for(const image of allocated)URL.revokeObjectURL(image.url)
    if(started===sequence && !isCancelled(issue))error.value=issue.message
  } finally {
    if(started!==sequence)for(const image of allocated)URL.revokeObjectURL(image.url)
    if(started===sequence)loading.value=false
  }
}
async function enlarge(image) {selected.value=image;await nextTick();dialog.value?.showModal()}
onMounted(load)
</script>
<template>
  <section class="repair-photos" aria-label="故障照片">
    <h3>故障照片</h3>
    <p v-if="loading" class="evaluation-hint" role="status">正在加载照片…</p>
    <div v-else-if="error" class="request-error" role="alert">{{ error }}<button class="secondary" @click="load">重试照片</button></div>
    <p v-else-if="!images.length" class="evaluation-hint">该工单未上传照片。</p>
    <div v-else class="photo-grid"><button v-for="(image,index) in images" :key="image.id" class="photo-thumbnail" :aria-label="'查看故障照片 '+(index+1)" @click="enlarge(image)"><img :src="image.url" :alt="'故障照片 '+(index+1)" /></button></div>
    <dialog ref="dialog" class="photo-dialog" @close="selected=null"><button class="secondary" @click="dialog.close()">关闭大图</button><img v-if="selected" :src="selected.url" alt="故障照片大图" /></dialog>
  </section>
</template>
