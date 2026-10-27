<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps({modelValue:{type:Array,default:()=>[]},disabled:Boolean})
const emit = defineEmits(['update:modelValue'])
const previews = ref([]), error = ref('')
function clear() { for (const image of previews.value) URL.revokeObjectURL(image.url); previews.value=[] }
watch(()=>props.modelValue,files=>{clear();previews.value=files.map(file=>({file,url:URL.createObjectURL(file)}))},{immediate:true})
onBeforeUnmount(clear)
function choose(event) {
  error.value=''
  const chosen=Array.from(event.target.files || [])
  event.target.value=''
  if (props.modelValue.length+chosen.length>3) {error.value='每张工单最多选择 3 张照片';return}
  if (chosen.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type))) {error.value='请选择 JPEG、PNG 或 WebP 照片';return}
  if (chosen.some(file=>file.size===0 || file.size>5*1024*1024)) {error.value='每张照片须大于 0 且不超过 5MB';return}
  emit('update:modelValue',[...props.modelValue,...chosen])
}
function remove(index) {emit('update:modelValue',props.modelValue.filter((_,i)=>i!==index))}
</script>
<template>
  <div class="photo-picker">
    <label>故障照片（选填，最多 3 张）<input class="photo-input" type="file" accept="image/jpeg,image/png,image/webp" multiple :disabled="disabled" @change="choose" /></label>
    <p class="evaluation-hint">单张不超过 5MB，支持 JPEG、PNG、WebP。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="photo-grid"><figure v-for="(image,index) in previews" :key="image.url"><img :src="image.url" :alt="'待上传照片 '+(index+1)" /><button class="secondary" type="button" :disabled="disabled" @click="remove(index)">移除照片 {{ index+1 }}</button></figure></div>
  </div>
</template>
