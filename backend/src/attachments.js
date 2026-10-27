import { Router, json } from 'express'
import { randomBytes } from 'node:crypto'
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectImage } from './image-format.js'
import { fail, positiveId, requireRoles, visibleOrder } from './permissions.js'

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024
export const defaultUploadDirectory = fileURLToPath(new URL('../uploads/', import.meta.url))
const fields = 'id, repair_order_id, mime_type, byte_size, created_at'
export function createAttachmentsRouter(db, options = {}) {
  const router = Router()
  const directory = resolve(options.directory || process.env.UPLOAD_DIR || defaultUploadDirectory)
  function findOrder(req, res, next) {
    const id = positiveId(req.params.id)
    if (!id) return fail(res,400,'工单 id 必须是正整数')
    const order = visibleOrder(db,req.user,id)
    if (!order || (req.user.role === 'worker' && order.assigned_worker_id !== req.user.id)) return fail(res,404,'工单不存在')
    req.attachmentOrder = order
    next()
  }
  router.get('/:id/attachments',findOrder,(req,res) => {
    res.json({success:true,data:db.prepare(`SELECT ${fields} FROM repair_attachments WHERE repair_order_id=? ORDER BY id`).all(req.attachmentOrder.id)})
  })
  router.get('/:id/attachments/:attachmentId/content',findOrder,(req,res) => {
    const id = positiveId(req.params.attachmentId)
    if (!id) return fail(res,400,'图片 id 必须是正整数')
    const file = db.prepare('SELECT storage_name,mime_type FROM repair_attachments WHERE id=? AND repair_order_id=?').get(id,req.attachmentOrder.id)
    if (!file || !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(file.storage_name)) return fail(res,404,'图片不存在')
    res.set({
      'Content-Type':file.mime_type, 'X-Content-Type-Options':'nosniff', 'Cache-Control':'private, no-store',
      'Content-Disposition':'inline; filename="repair-photo.' + file.storage_name.split('.').pop() + '"',
      'Content-Security-Policy':"default-src 'none'; sandbox",
    })
    res.sendFile(resolve(directory,file.storage_name),{cacheControl:false,lastModified:false,etag:false},error => {
      if (error && !res.headersSent) { res.type('application/json'); fail(res,error.code === 'ENOENT' ? 404 : 500,'图片文件暂不可读取') }
    })
  })
  router.post('/:id/attachments',requireRoles('student'),findOrder,json({limit:'21mb'}),(req,res) => {
    const body = req.body
    if (!body || !Array.isArray(body.files) || body.files.length < 1 || body.files.length > 3) return fail(res,400,'每次须上传 1–3 张照片')
    const decoded = []
    for (const file of body.files) {
      if (!file || typeof file.data !== 'string' || !file.data.length || file.data.length > Math.ceil(MAX_PHOTO_BYTES/3)*4) return fail(res,413,'单张图片不能超过 5MB，且不能为空')
      if (file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) return fail(res,400,'图片编码不正确')
      const bytes = Buffer.from(file.data,'base64')
      if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) return fail(res,413,'单张图片不能超过 5MB')
      if (bytes.toString('base64') !== file.data) return fail(res,400,'图片编码不正确')
      const format = detectImage(bytes)
      if (!format || (file.mime !== undefined && file.mime !== format.mime)) return fail(res,400,'只支持内容格式与声明一致的 JPEG、PNG、WebP 照片，尺寸最多 4000 万像素且单边不超过 20000 像素')
      decoded.push({bytes,...format})
    }
    const createdPaths = []
    let committed = false
    db.exec('BEGIN IMMEDIATE')
    try {
      // Database serialization and trigger protect the total across repeated/concurrent uploads.
      const count = db.prepare('SELECT count(*) AS n FROM repair_attachments WHERE repair_order_id=?').get(req.attachmentOrder.id).n
      if (count + decoded.length > 3) { db.exec('ROLLBACK'); return fail(res,409,'每张工单最多保存 3 张照片') }
      mkdirSync(directory,{recursive:true})
      const ids = []
      for (const image of decoded) {
        const storage = randomBytes(16).toString('hex') + '.' + image.extension
        const path = resolve(directory,storage)
        const fd = openSync(path,'wx',0o600)
        createdPaths.push(path)
        try { writeFileSync(fd,image.bytes); fsyncSync(fd) } finally { closeSync(fd) }
        const result = db.prepare(`INSERT INTO repair_attachments(repair_order_id,uploader_id,storage_name,mime_type,byte_size,created_at)
          VALUES (?,?,?,?,?,?)`).run(req.attachmentOrder.id,req.user.id,storage,image.mime,image.bytes.length,new Date().toISOString())
        ids.push(result.lastInsertRowid)
      }
      const items = ids.map(id=>db.prepare(`SELECT ${fields} FROM repair_attachments WHERE id=?`).get(id))
      db.exec('COMMIT')
      committed = true
      res.status(201).json({success:true,message:'照片上传成功',data:items})
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      for (const path of committed ? [] : createdPaths) {
        try { unlinkSync(path) } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error('本次附件清理失败，请检查上传目录') }
      }
      throw error
    }
  })
  return router
}
