import { request, requestGeneration, ApiError } from './client.js'
const path = id => '/repairs/' + encodeURIComponent(id) + '/attachments'
export const getAttachments = id => request(path(id))
export const getAttachmentBlob = (id, attachmentId) => request(path(id) + '/' + encodeURIComponent(attachmentId) + '/content', {responseType:'blob'})
export async function uploadAttachments(id, photos) {
  const started = requestGeneration()
  const files = []
  for (const photo of photos) {
    const bytes = new Uint8Array(await photo.arrayBuffer())
    if (started !== requestGeneration()) throw new ApiError('请求已过期',0,'STALE')
    let binary = ''
    for (let offset=0;offset<bytes.length;offset+=32768) binary += String.fromCharCode(...bytes.subarray(offset,offset+32768))
    files.push({mime:photo.type,data:btoa(binary)})
  }
  if (started !== requestGeneration()) throw new ApiError('请求已过期',0,'STALE')
  return request(path(id),{method:'POST',body:{files},timeoutMs:60000})
}
