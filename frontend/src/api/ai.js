import { request } from './client.js'
export const analyzeRepair = description => request('/ai/analyze-repair',{
  method:'POST',body:{description},timeoutMs:25000,
})
