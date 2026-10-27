// Structural checks on decoded bytes; client filenames and MIME are never authoritative.
const pngSignature = Buffer.from([137,80,78,71,13,10,26,10])
const dimensions = (width, height) => width > 0 && height > 0 && width <= 20000 && height <= 20000 && width * height <= 40000000
function png(buffer) {
  if (buffer.length < 57 || !buffer.subarray(0,8).equals(pngSignature)) return false
  let position = 8, header = false, pixels = false
  while (position + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(position)
    const type = buffer.toString('ascii',position+4,position+8)
    const end = position + 12 + size
    if (end > buffer.length) return false
    if (!header) {
      if (type !== 'IHDR' || size !== 13 || !dimensions(buffer.readUInt32BE(position+8),buffer.readUInt32BE(position+12))) return false
      if (![0,2,3,4,6].includes(buffer[position+17]) || buffer[position+18] !== 0 || buffer[position+19] !== 0 || buffer[position+20] > 1) return false
      header = true
    } else if (type === 'IHDR') return false
    if (type === 'IDAT' && size > 0) pixels = true
    if (type === 'IEND') return size === 0 && pixels && end === buffer.length
    position = end
  }
  return false
}
function jpeg(buffer) {
  if (buffer.length < 20 || buffer[0] !== 255 || buffer[1] !== 216 ||
      buffer[buffer.length-2] !== 255 || buffer[buffer.length-1] !== 217) return false
  let position = 2, frame = false
  while (position < buffer.length-2) {
    if (buffer[position++] !== 255) return false
    while (buffer[position] === 255) position++
    const marker = buffer[position++]
    if (position + 2 > buffer.length || marker === 0 || marker === 216 || marker === 217) return false
    const length = buffer.readUInt16BE(position)
    if (length < 2 || position + length > buffer.length-2) return false
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      if (length < 8 || !dimensions(buffer.readUInt16BE(position+5),buffer.readUInt16BE(position+3))) return false
      frame = true
    }
    if (marker === 218) return frame && length >= 6 && position + length < buffer.length-2
    position += length
  }
  return false
}
function webp(buffer) {
  if (buffer.length < 26 || buffer.toString('ascii',0,4) !== 'RIFF' ||
      buffer.toString('ascii',8,12) !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length) return false
  let position = 12, image = false, animated = false, animationHeader = false, frames = false
  while (position + 8 <= buffer.length) {
    const type = buffer.toString('ascii',position,position+4), size = buffer.readUInt32LE(position+4)
    const data = position+8, end = data+size
    if (end > buffer.length) return false
    if (type === 'VP8 ') {
      if (size < 10 || (buffer[data] & 1) !== 0 || !buffer.subarray(data+3,data+6).equals(Buffer.from([157,1,42])) ||
          !dimensions(buffer.readUInt16LE(data+6)&16383,buffer.readUInt16LE(data+8)&16383)) return false
      image = true
    }
    if (type === 'VP8L') {
      if (size < 5 || buffer[data] !== 47) return false
      const bits = buffer.readUInt32LE(data+1)
      if ((bits>>>29) !== 0 || !dimensions((bits&16383)+1,((bits>>>14)&16383)+1)) return false
      image = true
    }
    if (type === 'VP8X') {
      if (size !== 10 || !dimensions(buffer.readUIntLE(data+4,3)+1,buffer.readUIntLE(data+7,3)+1)) return false
      animated = Boolean(buffer[data] & 2)
    }
    if (type === 'ANIM') { if (size !== 6) return false; animationHeader = true }
    if (type === 'ANMF') {
      if (!animated || !animationHeader || size < 24 ||
          !dimensions(buffer.readUIntLE(data+6,3)+1,buffer.readUIntLE(data+9,3)+1)) return false
      let framePosition = data+16, frameImage = false
      while (framePosition+8 <= end) {
        const frameType = buffer.toString('ascii',framePosition,framePosition+4)
        const frameSize = buffer.readUInt32LE(framePosition+4)
        const frameEnd = framePosition+8+frameSize+(frameSize&1)
        if (frameEnd > end) return false
        if (frameType === 'VP8 ' || frameType === 'VP8L') {
          const header = Buffer.alloc(12)
          header.write('RIFF'); header.writeUInt32LE(frameEnd-framePosition+4,4); header.write('WEBP',8)
          if (!webp(Buffer.concat([header,buffer.subarray(framePosition,frameEnd)]))) return false
          frameImage = true
        } else if (frameType !== 'ALPH') return false
        framePosition = frameEnd
      }
      if (!frameImage || framePosition !== end) return false
      frames = true; image = true
    }
    position = end + (size & 1)
  }
  return image && position === buffer.length && (!animated || frames)
}
export function detectImage(buffer) {
  if (png(buffer)) return { mime: 'image/png', extension: 'png' }
  if (jpeg(buffer)) return { mime: 'image/jpeg', extension: 'jpg' }
  if (webp(buffer)) return { mime: 'image/webp', extension: 'webp' }
  return null
}
