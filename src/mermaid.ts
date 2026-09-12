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

let svgExportHost: HTMLElement | null = null

function svgExportHostEl(): HTMLElement {
  svgExportHost ??= (() => {
    const el = document.createElement('div')
    el.id = 'edi-svg-export-host'
    el.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;opacity:0;pointer-events:none;z-index:-9999'
    document.body.appendChild(el)
    return el
  })()
  return svgExportHost
}

let labelMeasureCtx: CanvasRenderingContext2D | null = null
function getLabelMeasureCtx(): CanvasRenderingContext2D | null {
  labelMeasureCtx ??= document.createElement('canvas').getContext('2d')
  return labelMeasureCtx
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** #rrggbb from an rgb()/named CSS color as computed by the browser. */
function cssColorToHex(color: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color)
  if (!m) return color
  const hex = (v: string): string =>
    Number(v).toString(16).padStart(2, '0')
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
}

/**
 * Read the *visually laid-out* text lines of a label from the DOM. A label's
 * ``innerText`` has no line breaks — Chromium wraps soft using CSS — so each
 * rendered character's ink box is measured and contiguous characters sharing a
 * row become one line. This yields the exact wrapped lines the user sees, with
 * each line's ink-box top/bottom in screen pixels.
 */
interface VisualLine {
  text: string
  inkTop: number
  inkBottom: number
}

function visualTextLines(el: Element): VisualLine[] {
  const range = document.createRange()
  const lines: VisualLine[] = []
  let cur: VisualLine | null = null
  const flush = () => {
    if (cur && cur.text.trim()) {
      lines.push({ text: cur.text.trim(), inkTop: cur.inkTop, inkBottom: cur.inkBottom })
    }
    cur = null
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    for (let i = 0; i < node.length; i++) {
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const r = range.getBoundingClientRect()
      if (r.height >= 1) {
        const top = Math.round(r.top)
        if (!cur) {
          cur = { text: '', inkTop: top, inkBottom: Math.round(r.bottom) }
        } else if (Math.abs(top - cur.inkTop) > 1) {
          flush()
          cur = { text: '', inkTop: top, inkBottom: Math.round(r.bottom) }
        }
      }
      if (cur) {
        cur.text += node.data[i]
        cur.inkBottom = Math.round(r.bottom)
      }
    }
  }
  flush()
  return lines
}

/**
 * Rewrite a mermaid SVG for Qt's QSvgRenderer, which silently drops
 * ``<foreignObject>`` labels. Mermaid puts every label inside XHTML
 * ``<foreignObject>``, so the rasterized image would be shapes with no text.
 *
 * The svg is attached (invisibly) long enough to measure each label's true
 * position and computed style, then each ``foreignObject`` is replaced with
 * plain SVG ``<text>`` nodes at the same spot. Shapes are re-used untouched.
 *
 * Long labels wrap on screen via CSS (``white-space: break-spaces``), so each
 * label becomes one ``<text>`` per *visual* line, read from the DOM; Qt itself
 * cannot wrap, so without this the copied text would be one unwrapped line.
 *
 * Qt ignores ``dominant-baseline`` — it anchors the alphabetic baseline. The
 * ``y`` for each line is therefore the baseline Chromium used: the line's ink
 * top plus the font's ink ascent (both measured on Chromium's own stack), so
 * Qt draws the same glyphs at the same relative baseline.
 */
function convertForeignObjectLabels(svg: SVGSVGElement): void {
  const rect = svg.getBoundingClientRect()
  const scaleX = svg.viewBox.baseVal.width > 0 ? rect.width / svg.viewBox.baseVal.width : 1
  const scaleY = svg.viewBox.baseVal.height > 0 ? rect.height / svg.viewBox.baseVal.height : 1
  const originLeft = rect.left

  const texts: SVGTextElement[] = []
  for (const fo of Array.from(svg.querySelectorAll('foreignObject'))) {
    // The label is the deepest text-carrying element inside the foreignObject.
    const labelEl = (fo.querySelector('p') ?? fo.querySelector('span') ?? fo.querySelector('div') ?? fo) as
      | HTMLElement
      | null
    if (!labelEl) continue
    const lines = visualTextLines(labelEl)
    if (lines.length === 0) {
      fo.remove()
      continue
    }
    const cs = getComputedStyle(labelEl)
    // Positions measured with getBoundingClientRect are in screen pixels (zoomed),
    // so those are divided by the svg's scale to get user units. The label's own
    // layout — font size, ink ascent — lives inside the foreignObject, which lays
    // out 1:1 with svg user units regardless of zoom, so those are already user px.
    const r = labelEl.getBoundingClientRect()
    const x = (r.left - originLeft) / scaleX + r.width / scaleX / 2
    const fontSize = parseFloat(cs.fontSize)
    const ctx = getLabelMeasureCtx()
    if (ctx) {
      ctx.font = `${cs.fontWeight || 400} ${cs.fontSize} ${cs.fontFamily}`
    }

    for (const line of lines) {
      const text = document.createElementNS(SVG_NS, 'text')
      // Chromium's per-character ink rects are actually the CSS *line box*,
      // which vertically centres the glyph ink inside it. Qt draws glyph ink
      // around the alphabetic baseline, so the baseline that reproduces
      // Chromium's ink centre is: line-box centre plus half the (ink ascent -
      // ink descent) delta of the line's own glyphs. Canvas metrics come from
      // the same font stack Qt will use, so this lands the ink in the same spot.
      const tm = ctx ? ctx.measureText(line.text) : null
      const boxCentre = (line.inkTop + line.inkBottom) / 2 / scaleY
      const asc =
        tm && tm.fontBoundingBoxAscent > 0 ? tm.fontBoundingBoxAscent : tm && tm.actualBoundingBoxAscent > 0 ? tm.actualBoundingBoxAscent : 0.72 * fontSize
      const desc =
        tm && tm.fontBoundingBoxDescent > 0 ? tm.fontBoundingBoxDescent : tm && tm.actualBoundingBoxDescent > 0 ? tm.actualBoundingBoxDescent : 0.24 * fontSize
      const y = boxCentre + (asc - desc) / 2
      text.setAttribute('x', String(x))
      text.setAttribute('y', String(y))
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('fill', cssColorToHex(cs.color))
      text.setAttribute('font-family', cs.fontFamily)
      text.setAttribute('font-size', String(fontSize))
      text.setAttribute('font-weight', cs.fontWeight)
      text.textContent = line.text
      texts.push(text)
    }
    fo.remove()
  }
  for (const text of texts) svg.appendChild(text)

  // Prune label <g> groups left empty by the conversion, innermost first.
  for (let pass = 0; pass < 8; pass++) {
    let removed = false
    for (const g of Array.from(svg.querySelectorAll('g'))) {
      if (g.childElementCount === 0 && !(g.textContent ?? '').trim()) {
        g.remove()
        removed = true
      }
    }
    if (!removed) break
  }
}

/**
 * Serialize the on-screen mermaid SVG for native rasterization by Qt.
 *
 * A detached snapshot of the live diagram is used as-is — current zoom level
 * and editor theme — so the copied image matches exactly what the user sees;
 * this also avoids a second mermaid render (and with it, a second rendering
 * stack that can diverge). The live element is only read (for its displayed
 * size); all mutation happens on the clone, so a copy cannot change the
 * editor's render.
 * Mermaid labels live in ``foreignObject`` elements which QSvgRenderer cannot
 * render, so they are rewritten as plain SVG text first.
 * ``var(--font-sans)`` is a page-level custom property that neither a
 * standalone document nor Qt's renderer can resolve, so it is replaced with the
 * concrete font stack.
 */
async function serializeSvgForExport(svg: SVGSVGElement): Promise<string | null> {
  const box = svg.viewBox?.baseVal
  const naturalWidth = box && box.width > 0 ? box.width : 0
  const naturalHeight = box && box.height > 0 ? box.height : 0
  if (naturalWidth <= 0 || naturalHeight <= 0) return null

  const host = svgExportHostEl()
  // Snapshot the live diagram on a detached clone; the on-screen svg is only
  // ever read, never moved or mutated, so a copy cannot change the editor.
  const displayed = svg.getBoundingClientRect()
  const pixelWidth = Math.round(displayed.width)
  const pixelHeight = Math.round(displayed.height)
  if (pixelWidth <= 0 || pixelHeight <= 0) return null

  // Freeze the displayed size (zoom included) into width/height attributes so
  // Qt rasterizes at exactly the pixel size the user sees. viewBox plus these
  // attributes are all QSvgRenderer needs to scale user units.
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width', String(pixelWidth))
  clone.setAttribute('height', String(pixelHeight))
  clone.style.removeProperty('width')
  clone.style.removeProperty('height')
  clone.style.removeProperty('max-width')
  clone.style.removeProperty('min-width')
  host.appendChild(clone)
  try {
    void clone.getBoundingClientRect()
    if (clone.querySelector('foreignObject')) {
      convertForeignObjectLabels(clone)
    }
    let xml = new XMLSerializer().serializeToString(clone)
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()
    if (font) xml = xml.split('var(--font-sans)').join(font)
    return xml
  } finally {
    host.removeChild(clone)
  }
}

export interface CopyMermaidResult {
  ok: boolean
  error?: string
}

/**
 * Copy the on-screen mermaid diagram (as PNG) to the system clipboard so it can
 * be pasted into apps with no real mermaid support, e.g. Confluence.
 *
 * The live rendered SVG is serialized as-is (current zoom level, editor theme),
 * so the image matches what the user sees, including the theme's background
 * color behind the diagram. Rasterization is done natively by Qt
 * (QSvgRenderer): drawing an SVG into a canvas taints it in QtWebEngine
 * because the app runs from a file:// origin, so the web Clipboard image API
 * can never work. Never throws; the error message is returned so the caller can
 * show it to the user.
 */
export async function copyMermaidAsImage(svg: SVGSVGElement): Promise<CopyMermaidResult> {
  try {
    const xml = await serializeSvgForExport(svg)
    if (!xml) return { ok: false, error: 'Could not rasterize the diagram' }
    if (!hasBridge()) {
      return {
        ok: false,
        error: 'Copying mermaid images requires the native app (no developer browser support).',
      }
    }
    const background =
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
    await invoke('copyImage', { svg: xml, background })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
