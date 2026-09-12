import { hasBridge, invoke } from './bridge'

export const MERMAID_LANG = 'mermaid'
export const MERMAID_CLASS = 'mermaid'

export function collectPendingMermaid(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}[data-state="pending"]`))
}

/** Light palette — used in light mode. */
export const MERMAID_THEME_LIGHT: Record<string, string> = {
  primaryColor: '#d6e4ff',
  primaryTextColor: '#1f2328',
  primaryBorderColor: '#79b8ff',
  lineColor: '#57606a',
  secondaryColor: '#f6f8fa',
  tertiaryColor: '#eaeef2',
}

const MERMAID_THEME_DARK: Record<string, string> = {
  primaryColor: '#1d3a5f',
  primaryTextColor: '#e6edf3',
  primaryBorderColor: '#4d7bb5',
  lineColor: '#8b949e',
  secondaryColor: '#2f3a45',
  tertiaryColor: '#232a31',
}

export function mermaidThemeVariables(dark: boolean): Record<string, string> {
  return dark ? MERMAID_THEME_DARK : MERMAID_THEME_LIGHT
}

function baseMermaidConfig(themeVariables: Record<string, string>): Record<string, unknown> {
  return {
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      fontFamily: 'var(--font-sans)',
      ...themeVariables,
    },
  }
}

let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null

export async function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      mod.default.initialize(baseMermaidConfig(mermaidThemeVariables(dark)))
      return mod.default
    })
  }
  return mermaidPromise
}

export async function reinitializeMermaidTheme(dark: boolean): Promise<void> {
  const mermaid = await loadMermaid()
  mermaid.initialize(baseMermaidConfig(mermaidThemeVariables(dark)))
}

export function errorBlock(message: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `${MERMAID_CLASS}-error`
  const title = document.createElement('strong')
  title.textContent = 'Mermaid render error'
  const pre = document.createElement('pre')
  pre.textContent = message
  el.append(title, pre)
  return el
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

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.5
const ZOOM_MAX = 4

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function createToolbarButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'mermaid-toolbar-btn'
  button.textContent = label
  button.title = title
  button.setAttribute('aria-label', title)
  return button
}

export function attachMermaidToolbar(host: HTMLElement, svg: SVGSVGElement, natural: number | null): void {
  const zoomOut = createToolbarButton('−', 'Zoom out')
  const zoomIn = createToolbarButton('+', 'Zoom in')
  const reset = createToolbarButton('100%', 'Reset zoom')

  const bar = document.createElement('div')
  bar.className = 'mermaid-toolbar'
  bar.append(zoomOut, zoomIn, reset)
  host.appendChild(bar)

  if (natural === null) {
    zoomOut.disabled = true
    zoomIn.disabled = true
    reset.disabled = true
    return
  }

  let factor = 1

  const applyZoom = (): void => {
    svg.style.width = `${natural * factor}px`
    svg.style.minWidth = '0'
    svg.style.maxWidth = 'none'
    svg.style.height = 'auto'
  }

  const resetZoom = (): void => {
    factor = 1
    responsifySvg(svg)
  }

  bar.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  zoomIn.addEventListener('click', () => {
    factor = clamp(factor * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
    applyZoom()
  })
  zoomOut.addEventListener('click', () => {
    factor = clamp(factor / ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
    applyZoom()
  })
  reset.addEventListener('click', resetZoom)
}

export async function renderPendingMermaid(container: HTMLElement): Promise<void> {
  const pending = collectPendingMermaid(container)
  if (pending.length === 0) {
    return
  }

  const mermaid = await loadMermaid()
  let seed = 0
  const now = Date.now()

  for (const el of pending) {
    const code = el.textContent ?? ''
    const id = `mermaid-${now}-${seed++}`

    try {
      const { svg } = await mermaid.render(id, code)
      const holder = document.createElement('div')
      holder.className = MERMAID_CLASS
      holder.dataset.state = 'done'
      holder.innerHTML = svg
      const svgEl = holder.querySelector<SVGSVGElement>('svg')
      if (svgEl) {
        const natural = responsifySvg(svgEl)
        attachMermaidToolbar(holder, svgEl, natural)
      }
      el.replaceWith(holder)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      el.replaceWith(errorBlock(message))
    }
  }
}

export function mermaidFenceTokens(source: string): string[] {
  const blocks: string[] = []
  const lines = source.split('\n')
  let index = 0
  while (index < lines.length) {
    const match = /^\s*```\s*(mermaid)\s*$/.exec(lines[index])
    if (match) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push(body.join('\n'))
    } else {
      index += 1
    }
  }
  return blocks
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
 * snapshot freezes the current zoom level. ``var(--font-sans)`` is a
 * page-level custom property a standalone SVG document cannot resolve, so it is
 * replaced with the concrete font stack.
 */
async function rasterizeSvgToBase64Png(svg: SVGSVGElement): Promise<string | null> {
  // Rasterize the on-screen footprint. The displayed size is authoritative —
  // the viewBox can't be trusted for sizing (e.g. gantt diagrams sometimes
  // ship a degenerate 0-width viewBox while rendering fine at 100% width).
  const displayed = svg.getBoundingClientRect()
  const pixelWidth = Math.round(displayed.width)
  const pixelHeight = Math.round(displayed.height)
  if (pixelWidth <= 0 || pixelHeight <= 0) return null

  // Snapshot the live diagram on a detached clone (read-only on the live svg),
  // freezing its displayed size — zoom included — into width/height attributes
  // so the image rasterizes at exactly the pixel footprint the user sees.
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

  // 2x for a crisp paste; diagrams pasted into Confluence/Word etc.
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, pixelWidth * scale)
  canvas.height = Math.max(1, pixelHeight * scale)
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

export interface CopyMermaidResult {
  ok: boolean
  error?: string
}

/**
 * Copy the on-screen mermaid diagram (as PNG) to the system clipboard so it can
 * be pasted into apps with no real mermaid support, e.g. Confluence.
 *
 * The live diagram is rasterized by Chromium itself (see
 * ``rasterizeSvgToBase64Png``), so the image matches what the user sees,
 * including the theme's background color behind the diagram; the PNG bytes are
 * shipped to the native shell which owns the clipboard. Never throws; the
 * error message is returned so the caller can show it to the user.
 */
export async function copyMermaidAsImage(svg: SVGSVGElement): Promise<CopyMermaidResult> {
  try {
    if (!hasBridge()) {
      return {
        ok: false,
        error: 'Copying mermaid images requires the native app (no developer browser support).',
      }
    }
    const data = await rasterizeSvgToBase64Png(svg)
    if (!data) return { ok: false, error: 'Could not rasterize the diagram' }
    await invoke('copyImage', { data })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
