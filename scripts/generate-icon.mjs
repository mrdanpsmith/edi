// Generates the Edi app icons:
//   scripts/assets/app-icon.png  (1024x1024, PySide6 window/taskbar icon)
//   scripts/assets/app-icon.ico  (Windows, sizes 16-256)
//   scripts/assets/app-icon.icns (macOS, sizes 16-1024)
// Pure Node, no build tooling needed:
//   node scripts/generate-icon.mjs
import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SIZE = 1024
const ASSETS = resolve(import.meta.dirname, '../scripts/assets')
const PNG_OUT = join(ASSETS, 'app-icon.png')
const ICO_OUT = join(ASSETS, 'app-icon.ico')
const ICNS_OUT = join(ASSETS, 'app-icon.icns')

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const ICNS_TYPES = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' }
const ICNS_SIZES = Object.keys(ICNS_TYPES).map(Number)

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

// Renders the 1024x1024 master art (blue gradient rounded square + white "E")
// into a packed RGBA byte array.
function renderArt() {
  const art = new Uint8Array(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 4
      if (!roundedRect(x, y, SIZE, 180)) {
        art[o + 3] = 0
        continue
      }
      // Blue gradient background (top-left to bottom-right)
      const t = (x + y) / (2 * SIZE)
      art[o] = Math.round(9 + (17 - 9) * t)
      art[o + 1] = Math.round(105 - 60 * t)
      art[o + 2] = Math.round(218 - 90 * t)
      art[o + 3] = 255

      // Stylized "E" from bars
      const spineX = 0.30 * SIZE
      const spineW = 0.10 * SIZE
      const top = 0.25 * SIZE
      const barH = 0.10 * SIZE
      const gap = 0.10 * SIZE
      const bottom = top + 3 * barH + 2 * gap

      const inSpine = x >= spineX && x <= spineX + spineW && y >= top && y <= bottom
      const topBar = y >= top && y <= top + barH
      const middleBar = y >= top + barH + gap && y <= top + 2 * barH + gap
      const bottomBar = y >= bottom - barH && y <= bottom
      const barRight = (middleBar ? 0.60 : 0.70) * SIZE
      const inBar = topBar || middleBar || bottomBar
      const inHorizontal = x >= spineX && x <= barRight && inBar

      if (inSpine || inHorizontal) {
        art[o] = 255
        art[o + 1] = 255
        art[o + 2] = 255
      }
    }
  }
  return art
}

// Separable box/area downsampler: averages weighted source coverage into each
// destination pixel, so fractional ratios (e.g. 1024 -> 24) stay crisp and the
// rounded corners keep a semi-transparent AA edge.
function areaResize(src, srcSize, dstSize) {
  const ratio = srcSize / dstSize
  const pass = new Float32Array(srcSize * dstSize * 4)
  for (let y = 0; y < srcSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const s0 = x * ratio
      const s1 = (x + 1) * ratio
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weight = 0
      for (let i = Math.floor(s0); i < Math.ceil(s1); i++) {
        const lo = Math.max(i, s0)
        const hi = Math.min(i + 1, s1)
        if (hi <= lo) continue
        const w = hi - lo
        const o = (y * srcSize + i) * 4
        r += src[o] * w
        g += src[o + 1] * w
        b += src[o + 2] * w
        a += src[o + 3] * w
        weight += w
      }
      const o = (y * dstSize + x) * 4
      const inv = 1 / weight
      pass[o] = r * inv
      pass[o + 1] = g * inv
      pass[o + 2] = b * inv
      pass[o + 3] = a * inv
    }
  }
  const dst = new Uint8Array(dstSize * dstSize * 4)
  for (let y = 0; y < dstSize; y++) {
    const s0 = y * ratio
    const s1 = (y + 1) * ratio
    for (let x = 0; x < dstSize; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let weight = 0
      for (let i = Math.floor(s0); i < Math.ceil(s1); i++) {
        const lo = Math.max(i, s0)
        const hi = Math.min(i + 1, s1)
        if (hi <= lo) continue
        const w = hi - lo
        const o = (i * dstSize + x) * 4
        r += pass[o] * w
        g += pass[o + 1] * w
        b += pass[o + 2] * w
        a += pass[o + 3] * w
        weight += w
      }
      const o = (y * dstSize + x) * 4
      const inv = 1 / weight
      dst[o] = Math.round(r * inv)
      dst[o + 1] = Math.round(g * inv)
      dst[o + 2] = Math.round(b * inv)
      dst[o + 3] = Math.round(a * inv)
    }
  }
  return dst
}

function pngFor(rgba, size) {
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      row.writeUInt32BE(hex(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]), 1 + x * 4)
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function rgbaOrZero(size) {
  return size === SIZE ? art : areaResize(art, SIZE, size)
}

function writeIco() {
  const entries = ICO_SIZES.map((size) => ({ size, png: pngFor(rgbaOrZero(size), size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const dir = entries.map((e) => {
    const buf = Buffer.alloc(16)
    buf[0] = e.size >= 256 ? 0 : e.size // 0 means 256 (unused here)
    buf[1] = e.size >= 256 ? 0 : e.size
    buf.writeUInt16LE(1, 4) // planes
    buf.writeUInt16LE(32, 6) // bit count
    buf.writeUInt32LE(e.png.length, 8)
    buf.writeUInt32LE(offset, 12)
    offset += e.png.length
    return buf
  })
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)])
}

function writeIcns() {
  const bodies = ICNS_SIZES.map((size) => {
    const png = pngFor(rgbaOrZero(size), size)
    const icon = Buffer.alloc(8 + png.length)
    icon.write(ICNS_TYPES[size], 0, 'ascii')
    icon.writeUInt32BE(8 + png.length, 4)
    png.copy(icon, 8)
    return icon
  })
  const body = Buffer.concat(bodies)
  const icns = Buffer.alloc(8 + body.length)
  icns.write('icns', 0, 'ascii')
  icns.writeUInt32BE(icns.length, 4)
  body.copy(icns, 8)
  return icns
}

const art = renderArt()

mkdirSync(ASSETS, { recursive: true })
writeFileSync(PNG_OUT, pngFor(art, SIZE))
console.log(`Wrote ${PNG_OUT}`)
writeFileSync(ICO_OUT, writeIco())
console.log(`Wrote ${ICO_OUT}`)
writeFileSync(ICNS_OUT, writeIcns())
console.log(`Wrote ${ICNS_OUT}`)