// Generates the Edi app icon (scripts/assets/app-icon.png), used for the
// PySide6 window/taskbar icon. Pure Node, no build tooling needed:
//   node scripts/generate-icon.mjs
import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SIZE = 1024
const OUT = resolve(import.meta.dirname, 'assets/app-icon.png')

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

function hex(r, g, b, a = 255) {
  return r * 0x1000000 + g * 0x10000 + b * 0x100 + a
}

function roundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), SIZE - radius)
  const cy = Math.min(Math.max(y, radius), SIZE - radius)
  const dx = x - cx
  const dy = y - cy
  if (dx === 0 || dy === 0) {
    return true
  }
  return dx * dx + dy * dy <= radius * radius
}

const rows = []
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4)
  row[0] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    let pixel
    if (!roundedRect(x, y, SIZE, 180)) {
      pixel = hex(0, 0, 0, 0)
    } else {
      // Blue gradient background (top-left to bottom-right)
      const t = (x + y) / (2 * SIZE)
      const r = Math.round(9 + (17 - 9) * t)
      const g = Math.round(105 - 60 * t)
      const b = Math.round(218 - 90 * t)

      // Stylized "E" from bars
      const barLeft = 0.24 * SIZE
      const barRight = 0.76 * SIZE
      const top = 0.2 * SIZE
      const barHeight = 0.13 * SIZE
      const gap = (SIZE - 2 * top - 3 * barHeight) / 2

      const inVertical = x >= barLeft && x <= barLeft + 0.14 * SIZE
      const inBar =
        (y >= top && y <= top + barHeight) ||
        (y >= top + barHeight + gap && y <= top + 2 * barHeight + gap) ||
        (y >= top + 2 * (barHeight + gap) && y <= top + 2 * barHeight + 2 * gap + barHeight)
      const inHorizontal = x >= barLeft && x <= barRight && inBar

      if (inVertical || inHorizontal) {
        pixel = hex(255, 255, 255, 255)
      } else {
        pixel = hex(r, g, b, 255)
      }
    }
    row.writeUInt32BE(pixel, 1 + x * 4)
  }
  rows.push(row)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.concat(rows))),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log(`Wrote ${OUT}`)
