// Baking pipeline for mermaid diagrams: rasterizing the live SVG to a bitmap
// and re-baking on zoom changes. Extracted from `mermaid.ts`. Re-exported
// from `mermaid.ts` for backwards compatibility.

import { resolvedTextFill } from './mermaid-colors'
import { DOC_ZOOM_EVENT } from './zoom'

/**
 * Rasterize the live diagram into a displayed bitmap and swap it in.
 *
 * QtWebEngine on some desktops corrupts native SVG text during selection
 * repaints — light glyphs re-paint black on screen while the document (and the
 * copy-as-image raster) stay correct. A baked ``<img>`` has no live glyph
 * runs, so there is nothing left for that repaint to corrupt: what's on screen
 * is exactly the (correct) image the copy pipeline produces. The vector SVG
 * stays in the DOM, hidden, as the source for copy and further bakes.
 */
async function applyBake(holder: HTMLElement, svg: SVGSVGElement, requestedWidth: number): Promise<boolean> {
  try {
    const existing = holder.querySelector<HTMLImageElement>(`.${MERMAID_IMG_CLASS}`)
    const width = Math.round(
      requestedWidth > 0 ? requestedWidth : parseFloat(existing?.style.width ?? '') || 0,
    )
    if (width <= 0) return false

    const ratio = svgViewBoxRatio(svg) ?? 1
    const height = Math.round(width * ratio)
    // 2x for a crisp result at 100%, times the document's own zoom: a bitmap
    // rasterized at one density and displayed at another is the blurry diagram
    // this whole treatment exists to avoid.
    const density = bakeDensity()
    const data = await rasterizeSvgToBase64Png(
      svg,
      Math.round(width * density),
      Math.round(height * density),
    )
    if (!data) return false

    let img = existing
    if (!img) {
      img = document.createElement('img')
      img.alt = ''
      img.className = MERMAID_IMG_CLASS
      previewOf(holder, svg).insertBefore(img, svg)
    }
    img.src = `data:image/png;base64,${data}`
    img.style.width = `${width}px`
    img.style.height = `${height}px`
    svg.classList.add(MERMAID_SOURCE_CLASS)
    return true
  } catch {
    return false
  }
}

function previewOf(holder: HTMLElement, svg: SVGSVGElement): HTMLElement {
  const preview = holder.querySelector<HTMLElement>('.mermaid-preview')
  if (preview) return preview
  const host = svg.closest<HTMLElement>('.mermaid')
  return (host ?? holder)
}

/**
 * Re-bake every baked diagram when the document's zoom changes.
 *
 * The document's zoom (`--doc-zoom`, `src/zoom.ts`) is the only zoom there is,
 * and it changes without the diagram being re-rendered at all — so a bitmap made
 * for 100% would be magnified rather than redrawn. `bakeDensity` covers the bake
 * itself; this covers the ladder step after it.
 *
 * **One listener for the page, registered once**, and the diagrams are found by
 * their own marker rather than kept in a set: a block that is torn down leaves
 * nothing behind, and there is no registry to prune.
 */
const rebakeListener = { value: null as ((event: Event) => void) | null }

function rebakeOnDocumentZoom(): void {
  if (rebakeListener.value !== null) return
  rebakeListener.value = (): void => {
    for (const holder of document.querySelectorAll<HTMLElement>('[data-edi-bake="1"]')) {
      // Only a diagram that is *currently* showing a baked image. The marker
      // outlives the image — a render in edit mode replaces the preview
      // wholesale and leaves the vector live — and re-baking that would put a
      // bitmap over an editable drawing.
      const shown = holder.querySelector(`.${MERMAID_IMG_CLASS}`)
      const natural = Number(holder.dataset.ediNatural ?? 0)
      const svg = holder.querySelector<SVGSVGElement>('.mermaid-preview svg[id]')
      if (shown && natural > 0 && svg) void applyBake(holder, svg, natural)
    }
  }
  document.documentElement.addEventListener(DOC_ZOOM_EVENT, rebakeListener.value)
}

/**
 * Show a diagram as a baked bitmap (see ``applyBake``). Intended to run right
 * after a fresh render. Falls back to the live SVG whenever a bake is
 * impossible.
 *
 * The diagram is baked at its natural size and scaled by the document's one zoom,
 * rasterized at `bakeDensity` device pixels per CSS pixel — so magnifying the
 * document draws a sharper diagram rather than a larger bitmap.
 */
export async function bakeDiagram(
  holder: HTMLElement,
  svg: SVGSVGElement,
  natural: number | null,
): Promise<boolean> {
  if (natural === null) return false
  // Only light native-text diagrams need the bitmap treatment; foreignObject
  // HTML labels aren't hit by the repaint bug, so those stay crisp vectors.
  if (!diagramNeedsBake(svg)) return false
  try {
    // The natural width is what the drawing is scaled from, and a re-render can
    // change it, so it is written every time rather than once. The marker is what
    // the one document-zoom listener finds this diagram by, and it is only set on
    // a bake that actually landed — an `<img>` that is not there is a live
    // vector, and a vector does not need re-baking.
    holder.dataset.ediNatural = String(natural)
    const ok = await applyBake(holder, svg, natural)
    if (ok) {
      holder.dataset.ediBake = '1'
      rebakeOnDocumentZoom()
    }
    // Fonts needed for the diagram may still be loading on the very first paint;
    // re-bake once they are guaranteed so label metrics don't shift mid-display.
    if (ok && 'fonts' in document && document.fonts?.ready) {
      void document.fonts.ready
        .then(() => {
          if (holder.isConnected && holder.querySelector(`.${MERMAID_IMG_CLASS}`)) {
            void applyBake(holder, svg, 0)
          }
        })
        .catch(() => undefined)
    }
    return ok
  } catch {
    return false
  }
}

export function responsifySvg(svg: SVGSVGElement): number | null {
  const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number)
  const natural = parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0 ? parts[2] : null

  svg.style.height = 'auto'
  svg.style.maxWidth = 'none'
  svg.style.minWidth = ''
  svg.style.width = natural !== null ? `${natural}px` : '100%'
  return natural
}

/** Height/width ratio from the viewBox, or null when unusable. */
function svgViewBoxRatio(svg: SVGSVGElement): number | null {
  const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number)
  if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return parts[3] / parts[2]
  return null
}

export const MERMAID_IMG_CLASS = 'mermaid-img'
const MERMAID_SOURCE_CLASS = 'mermaid-source'

/** Parse '#fff'/'#rrggbb'/'rgb()'/'rgba()' CSS color strings to RGB. */
function cssColorToRgb(value: string): { r: number; g: number; b: number } | null {
  const rgb = /rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/.exec(value)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (hex) {
    const raw = hex[1]
    const full =
      raw.length === 3
        ? raw.split('').map((c) => c + c).join('')
        : raw
    const n = Number.parseInt(full, 16)
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
  }
  return null
}

/**
 * Whether the diagram has native SVG ``<text>`` (not HTML ``foreignObject``
 * labels) that is light-on-dark — exactly the shape QtWebEngine's repaint bug
 * corrupts (light glyphs re-painted black on click/selection). These get the
 * baked-bitmap treatment; fonts/colors that can't be corrupted stay vector.
 */
export function diagramNeedsBake(svg: SVGSVGElement): boolean {
  return Array.from(svg.querySelectorAll<SVGTextElement>('text, text tspan')).some((el) => {
    if (el.closest('foreignObject')) return false
    const fill = resolvedTextFill(el)
    if (!fill) return false
    const rgb = cssColorToRgb(fill)
    if (!rgb) return false
    return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b >= 128
  })
}

/**
 * Device pixels per CSS pixel a bake is rasterized at: 2x, times whatever the
 * document's own zoom is. A diagram is drawn at its natural size and scaled by
 * `#editor-container .ProseMirror { zoom: var(--doc-zoom) }`, so at 200% the
 * bitmap is displayed at twice the resolution it was rasterized for and the
 * labels go soft — the same defect a per-diagram zoom had to answer with its own
 * re-bake, now answered once for the whole document.
 *
 * Capped at 4x: the ladder tops out at 300%, and a raster past that costs
 * seconds of canvas work for pixels nobody is reading.
 */
function bakeDensity(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--doc-zoom').trim()
  const zoom = Number(raw)
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return Math.min(4, 2 * factor)
}

/** Encode a byte array as a base64 data string. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Rasterize the live mermaid SVG to a PNG (as base64) using the page's own
 * renderer.
 *
 * The on-screen diagram is drawn into an offscreen canvas by the *same* Chromium
 * engine that paints it, so a copied image is pixel-identical to what the user
 * sees for every diagram type (foreignObject labels, nested ``<svg>``s, clip
 * paths, CSS classes, em/px font sizes — everything the old SVG→QSvgRenderer
 * path had to fake or dropped). Drawing a ``data:`` URL'd SVG into a canvas is
 * not tainted in QtWebEngine even from a ``file://`` page, so ``toBlob`` is
 * readable; the PNG bytes are handed to the native side for the clipboard.
 *
 * The live element is only read (for its displayed size); the serialized
 * snapshot is frozen at the pixel footprint asked for. ``var(--font-sans)`` is a
 * page-level custom property a standalone SVG document cannot resolve, so it is
 * replaced with the concrete font stack.
 */
export async function rasterizeSvgToBase64Png(
  svg: SVGSVGElement,
  pixelWidth: number,
  pixelHeight: number,
): Promise<string | null> {
  if (pixelWidth <= 0 || pixelHeight <= 0) return null

  // Snapshot the live diagram on a detached clone (read-only on the live svg),
  // freezing the requested pixel footprint into width/height attributes so the
  // image rasterizes at exactly that size.
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width', String(pixelWidth))
  clone.setAttribute('height', String(pixelHeight))
  clone.style.removeProperty('width')
  clone.style.removeProperty('height')
  clone.style.removeProperty('max-width')
  clone.style.removeProperty('min-width')
  let xml = new XMLSerializer().serializeToString(clone)
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()
  if (font) xml = xml.split('var(--font-sans)').join(font)

  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
  await img.decode()

  const canvas = document.createElement('canvas')
  canvas.width = pixelWidth
  canvas.height = pixelHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // Backing color matching the editor theme (the app's --bg), so a
  // dark-theme diagram stays legible anywhere.
  const background =
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return null
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}
