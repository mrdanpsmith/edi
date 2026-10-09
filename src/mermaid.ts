import { hasBridge, invoke } from './bridge'
import { pickImageSavePath, writeBinaryFile } from './files'
import { DOC_ZOOM_EVENT } from './zoom'

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
  // Diagrams that colour by *category* rather than by role — treemap sections,
  // radar curves, pie slices — read `cScale0..11`, an ordinal scale: the first
  // name a diagram meets takes slot 0, the next slot 1, and so on. Left to
  // itself the `base` theme fills it by hue-rotating `primaryColor`, so our
  // flowchart node fill was deciding the colours: `cScale0` *was* `primaryColor`
  // and `cScale3..11` were it at +30° of hue apiece. From a light blue that
  // spends the early slots on blue/indigo/violet and leaves `cScale1`/`cScale2`
  // holding `secondaryColor`/`tertiaryColor` — two near-white greys — so a
  // treemap came out one blue board with its first two sections indistinguishable.
  // Slot 0 keeps `primaryColor`'s hue so a node fill and a first section still
  // agree; the rest are an even wheel around it, front-loaded so the four slots a
  // diagram usually shows are the four furthest apart (ΔE 23 between them, 11.1
  // across all twelve once treemap's 0.6/0.3 fills are composited onto the page).
  cScale0: '#5487c9',
  cScale1: '#c95487',
  cScale2: '#87c954',
  cScale3: '#54c997',
  cScale4: '#9754c9',
  cScale5: '#c99754',
  cScale6: '#5c54c9',
  cScale7: '#c95c54',
  cScale8: '#54c95c',
  cScale9: '#54c1c9',
  cScale10: '#c954c1',
  cScale11: '#c1c954',
}

const MERMAID_THEME_DARK: Record<string, string> = {
  primaryColor: '#1d3a5f',
  primaryTextColor: '#e6edf3',
  primaryBorderColor: '#4d7bb5',
  lineColor: '#8b949e',
  secondaryColor: '#2f3a45',
  tertiaryColor: '#232a31',
}
// The app's dark editor background — some diagram types (wardley, xychart, …)
// paint their own backdrop rect from `themeVariables.background`, and its
// default (`#fff`) is exactly why those diagrams were white-on-white in dark
// mode while every text label had turned light.
const MERMAID_DARK_BACKGROUND = '#0d1117'

/**
 * Where a label with nowhere to break may break.
 *
 * Mermaid measures a label *before* it draws it, and it measures with the
 * wrapping rules it ships with: `white-space: break-spaces`, which breaks at
 * whitespace and nowhere else. A run with no whitespace in it — a long
 * identifier, a URL, an acronym somebody pasted — is therefore measured as one
 * unbroken line, and everything is then sized from that measurement. On a board,
 * whose card width is fixed by `kanban.sectionWidth`, the consequence is that the
 * label's `foreignObject` comes out several times the card's width and the title
 * paints *outside* the card it is in, over its neighbours.
 *
 * This is the rule that gives a label somewhere else to break, and it belongs in
 * `themeCSS` rather than in our own stylesheet for a reason that is the whole of
 * the bug: `themeCSS` goes into the stylesheet mermaid embeds in the drawing it
 * is measuring, so the label is already wrapped when mermaid measures it and the
 * card, the column and the board are sized from what the reader will see. A rule
 * applied after the render fixes the overflow and leaves every one of those boxes
 * the height of the un-wrapped text — the text is inside the card and sticking out
 * of the bottom of it instead.
 *
 * It is also additive by construction: `overflow-wrap` only permits a break at a
 * point where there was none, so a label that fits, or that already breaks at a
 * space, is laid out exactly as before.
 */
const MERMAID_LABEL_WRAP_CSS = `
.nodeLabel,
.nodeLabel p,
.edgeLabel,
.edgeLabel p,
.cluster-label,
.cluster-label p,
.cluster-label span,
.labelText,
.labelText p {
  overflow-wrap: anywhere;
}`

export function mermaidThemeVariables(dark: boolean): Record<string, string> {
  return dark ? { ...MERMAID_THEME_DARK, background: MERMAID_DARK_BACKGROUND } : MERMAID_THEME_LIGHT
}

function baseMermaidConfig(
  themeVariables: Record<string, string>,
  dark: boolean,
): Record<string, unknown> {
  return {
    startOnLoad: false,
    // Theme choice matters: 'base' (+ a handful of overrides) is a *light* theme
    // and its unoverridden defaults stay light, so dark mode must use mermaid's
    // complete built-in 'dark' palette (backgrounds, actor fills, pie swatches,
    // grid/axis colors, …) or every diagram that reads a variable we don't set
    // falls back to a light value — e.g. white-on-white wardley/xychart labels.
    theme: dark ? 'dark' : 'base',
    themeVariables: {
      fontFamily: 'var(--font-sans)',
      ...themeVariables,
    },
    themeCSS: MERMAID_LABEL_WRAP_CSS,
  }
}

let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null

export async function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      mod.default.initialize(baseMermaidConfig(mermaidThemeVariables(dark), dark))
      return mod.default
    })
  }
  return mermaidPromise
}

export async function reinitializeMermaidTheme(dark: boolean): Promise<void> {
  const mermaid = await loadMermaid()
  mermaid.initialize(baseMermaidConfig(mermaidThemeVariables(dark), dark))
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

/**
 * Resolve the effective fill of an SVG text element: computed style first (covers
 * CSS-rule colors), then an explicit inline/attribute walk up the ancestor chain
 * (covers cascade inheritance where the computed style is unavailable). Stops at
 * the SVG root — native SVG text that resolves to nothing is left untouched.
 */
function resolvedTextFill(el: SVGElement): string | null {
  const computed = getComputedStyle(el).fill
  if (computed && computed !== 'inherit' && computed !== 'currentColor') return computed.trim()
  for (let node: Element | null = el; node instanceof SVGElement; node = node.parentElement) {
    const inline = node.style.getPropertyValue('fill')
    if (inline) return inline.trim()
    const attr = node.getAttribute('fill')
    if (attr && attr !== 'inherit') return attr.trim()
  }
  return null
}

/**
 * Pin every native SVG ``<text>`` glyph to its own resolved fill.
 *
 * QtWebEngine re-colors SVG text glyphs to the root element's ``color`` on some
 * repaints (e.g. ProseMirror's selection side-effect). Mermaid text carries an
 * explicit ``fill`` (C4: white) but no ``color``, so it inherits the dark root
 * color and the offending repaint turns light labels black — most visibly for
 * diagrams with native text (C4, sequence, gantt, pie, …); HTML ``foreignObject``
 * labels are unaffected. Baking ``fill`` *and* ``color`` inline removes the
 * ambiguity: whatever property the engine honors on repaint now resolves to the
 * label's own color. HTML labels inside ``foreignObject`` are left untouched.
 */
export function pinSvgTextColors(svg: SVGSVGElement): void {
  for (const el of Array.from(svg.querySelectorAll<SVGTextElement>('text, text tspan'))) {
    if (el.closest('foreignObject')) continue
    const fill = resolvedTextFill(el)
    if (!fill) continue
    el.style.fill = fill
    el.style.color = fill
  }
}

/** Parse a CSS color (hex / rgb() / rgba() / basic named) to [r,g,b] or null. */
function parseCssColor(value: string): [number, number, number] | null {
  const v = value.trim().toLowerCase()
  let match: RegExpMatchArray | null
  if ((match = v.match(/^#([0-9a-f]{3})$/))) {
    const c = match[1]!
    return [parseInt(c[0]! + c[0]!, 16), parseInt(c[1]! + c[1]!, 16), parseInt(c[2]! + c[2]!, 16)]
  }
  if ((match = v.match(/^#([0-9a-f]{6})$/))) {
    return [parseInt(match[1]!.slice(0, 2), 16), parseInt(match[1]!.slice(2, 4), 16), parseInt(match[1]!.slice(4, 6), 16)]
  }
  if ((match = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/))) {
    if (match[4] !== undefined && !v.match(/rgba\(/) && match[4].endsWith('%')) {
      // handle only rgb()
    }
    const a = match[4] !== undefined ? parseFloat(match[4]) : 1
    if (a === 0) return null
    return [Math.round(parseFloat(match[1]!)), Math.round(parseFloat(match[2]!)), Math.round(parseFloat(match[3]!))]
  }
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [255, 255, 255],
    gray: [128, 128, 128],
    grey: [128, 128, 128],
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
  }
  return named[v] ?? null
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** WCAG 2.x contrast ratio between two CSS colors (null-safe). */
function contrastBetween(fg: string | null, bg: string | null): number | null {
  const fc = fg !== null ? parseCssColor(fg) : null
  const bc = bg !== null ? parseCssColor(bg) : null
  if (!fc || !bc) return null
  const l1 = relativeLuminance(fc)
  const l2 = relativeLuminance(bc)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

const SHAPE_TAGS = new Set(['rect', 'path', 'polygon', 'polyline', 'circle', 'ellipse', 'foreignObject'])

/** Resolve an element's computed fill to a solid CSS color (skips none/transparent/gradients). */
function solidFill(el: Element): string | null {
  const fill = getComputedStyle(el).fill || el.getAttribute('fill')
  if (!fill || fill === 'none' || fill === 'transparent' || fill === 'inherit') {
    if (fill === 'inherit') return null
    return null
  }
  if (fill.startsWith('url(')) return null
  if (parseCssColor(fill) === null) return null
  return fill
}

/** True if the shape's geometry contains the point. Browsers-only (getBBox). */
function coversPoint(shape: Element, x: number, y: number): boolean {
  const bb = (shape as SVGGraphicsElement).getBBox()
  if (!bb) return false
  return x >= bb.x && x <= bb.x + bb.width && y >= bb.y && y <= bb.y + bb.height
}

/** Element bounding box via getBBox; throws in non-browser envs (jsdom). */
function shapeBBox(el: Element): { x: number; y: number; width: number; height: number } & SVGRect {
  return (el as SVGGraphicsElement).getBBox()
}

/**
 * The color the page paints behind an element:
 * - nearest enclosing solid-filled shape that covers the element's center
 *   (so C4's white-on-navy text is judged against the navy, not the editor
 *   background), scanning ancestors innermost-first;
 * - else an svg-level full-bleed background rect the diagram drew itself
 *   (wardley/xychart paint `themeVariables.background`);
 * - else the editor's `--bg`.
 */
function effectiveBackgroundFor(el: SVGElement, svg: SVGSVGElement): string {
  let center: { x: number; y: number } | null = null
  try {
    const bb = shapeBBox(el)
    if (bb && isFinite(bb.x) && isFinite(bb.width)) center = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
  } catch {
    center = null
  }
  if (center) {
    for (let node: Element | null = el.parentElement; node !== null && node !== svg && node instanceof SVGElement; node = node.parentElement) {
      for (const shape of Array.from(node.children)) {
        const fill = solidFill(shape)
        if (fill === null || !SHAPE_TAGS.has(shape.tagName) || shape === el) continue
        try {
          if (coversPoint(shape, center.x, center.y)) return fill
        } catch {
          // getBBox unavailable (test env) — fall through to the diagram bg
        }
      }
    }
  }
  // Full-bleed diagram background rect.
  let svgCoverage: string | null = null
  try {
    const big = shapeBBox(svg)
    if (big && isFinite(big.width) && big.width > 0) {
      for (const shape of Array.from(svg.children)) {
        const fill = solidFill(shape)
        if (fill === null || !SHAPE_TAGS.has(shape.tagName)) continue
        const bb = shapeBBox(shape)
        if (bb && bb.width >= big.width * 0.9 && bb.height >= big.height * 0.9) {
          svgCoverage = fill
          break
        }
      }
    }
  } catch {
    svgCoverage = null
  }
  if (svgCoverage) return svgCoverage
  const cssBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (cssBg && parseCssColor(cssBg)) return cssBg
  return document.documentElement.dataset.colorScheme === 'dark' ? '#0d1117' : '#ffffff'
}

const TEXT_CONTRAST_MIN = 3.2
const STROKE_LUM_MAX = 0.12
const STROKE_CONTRAST_MIN = 2.5

/**
 * Adapt diagrams whose renderers hardcode colors (no theme variables) to the
 * current color scheme, so dark mode stays readable without a per-type sidecar.
 *
 * The heuristic is contrast-driven, not provenance-driven: every native glyph
 * and connector stroke is scored against the color actually painted behind it
 * (enclosing shape → full-bleed diagram background → editor `--bg`). Anything
 * that would be unreadable — dark-on-dark text or strokes, light-on-light
 * fills — is flipped to the CURRENT theme's palette (text → `primaryTextColor`,
 * strokes/arrowheads → `lineColor`), so the result tracks re-themes and the
 * flipped colors are inlined and survive baking (the rasterizer snapshots
 * inline styles, not stylesheets).
 *
 * Theme-aware diagrams score high contrast and are left untouched; foreignObject
 * HTML labels are styled by the app's own CSS and never touched here. Stroke
 * surgery is gated to dark mode and near-black strokes so diagram gridlines and
 * deliberately faint lines (theme lineColor sits far above the *luminance*
 * cutoff and is already readable) are never disturbed.
 */
export function adaptDiagramColors(svg: SVGSVGElement): void {
  const scheme = document.documentElement.dataset.colorScheme
  if (scheme !== 'dark' && scheme !== 'light') return
  const dark = scheme === 'dark'
  const newTextColor = dark ? MERMAID_THEME_DARK.primaryTextColor : MERMAID_THEME_LIGHT.primaryTextColor
  const newLineColor = MERMAID_THEME_DARK.lineColor

  for (const el of Array.from(svg.querySelectorAll<SVGTextElement>('text, text tspan'))) {
    if (el.closest('foreignObject')) continue
    const fill = resolvedTextFill(el)
    if (!fill) continue
    const bg = effectiveBackgroundFor(el, svg)
    const contrast = contrastBetween(fill, bg)
    if (contrast === null || contrast >= TEXT_CONTRAST_MIN) continue
    el.style.fill = newTextColor
    el.style.color = newTextColor
  }

  if (dark) {
    for (const el of Array.from(svg.querySelectorAll<SVGLineElement | SVGRectElement | SVGPathElement>('line, rect, path, polygon, polyline'))) {
      const stroke = getComputedStyle(el).stroke || el.getAttribute('stroke')
      if (!stroke || stroke === 'none' || stroke === 'transparent' || stroke.startsWith('url(')) continue
      const sc = parseCssColor(stroke)
      if (sc === null || relativeLuminance(sc) > STROKE_LUM_MAX) continue
      const bg = effectiveBackgroundFor(el, svg)
      const contrast = contrastBetween(stroke, bg)
      if (contrast === null || contrast >= STROKE_CONTRAST_MIN) continue
      el.style.stroke = newLineColor
    }
    // C4's arrowhead/arrowend markers carry no fill and default to black.
    for (const markerPath of Array.from(svg.querySelectorAll<SVGPathElement>('marker path'))) {
      const fill = getComputedStyle(markerPath).fill || markerPath.getAttribute('fill')
      if (!fill || fill === 'none' || fill.startsWith('url(')) continue
      const sc = parseCssColor(fill)
      if (sc === null || relativeLuminance(sc) > STROKE_LUM_MAX) continue
      const bg = effectiveBackgroundFor(markerPath, svg)
      const contrast = contrastBetween(fill, bg)
      if (contrast === null || contrast >= STROKE_CONTRAST_MIN) continue
      markerPath.style.fill = newLineColor
    }
  }
}

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
let rebakeListener: ((event: Event) => void) | null = null

function rebakeOnDocumentZoom(): void {
  if (rebakeListener !== null) return
  rebakeListener = (): void => {
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
  document.documentElement.addEventListener(DOC_ZOOM_EVENT, rebakeListener)
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

const MERMAID_IMG_CLASS = 'mermaid-img'
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
        adaptDiagramColors(svgEl)
        pinSvgTextColors(svgEl)
        void bakeDiagram(holder, svgEl, natural)
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
 * snapshot is frozen at the pixel footprint asked for. ``var(--font-sans)`` is a
 * page-level custom property a standalone SVG document cannot resolve, so it is
 * replaced with the concrete font stack.
 */
async function rasterizeSvgToBase64Png(
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

export interface CopyMermaidResult {
  ok: boolean
  error?: string
  /** Set when a file was actually written (Save image), so callers can report it. */
  path?: string
}

/**
 * Rasterize the on-screen diagram (live SVG vector or, after a bake, the shown
 * image) to a base64 PNG at 2x the *displayed* pixel footprint, so the result
 * matches what the user sees — including the theme's background. Shared by the
 * copy and save-as-image flows.
 */
async function rasterizeMermaidSource(
  source: SVGSVGElement | HTMLImageElement,
): Promise<{ data: string | null; error: string | null }> {
  const preview = source.closest?.('.mermaid-preview') as HTMLElement | null
  const shown = preview?.querySelector<HTMLImageElement>(`.${MERMAID_IMG_CLASS}`) ?? null
  const display = shown ?? source
  const svg =
    shown !== null
      ? (preview?.querySelector<SVGSVGElement>('svg') ?? null)
      : (source as SVGSVGElement)
  if (!svg) return { data: null, error: 'Could not find the diagram' }
  const rect = display.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return { data: null, error: 'Could not rasterize the diagram' }
  }
  // 2x for a crisp result; diagrams pasted into Confluence/Word etc.
  const data = await rasterizeSvgToBase64Png(
    svg,
    Math.round(rect.width * 2),
    Math.round(rect.height * 2),
  )
  if (!data) return { data: null, error: 'Could not rasterize the diagram' }
  return { data, error: null }
}

/**
 * Copy the on-screen mermaid diagram (as PNG) to the system clipboard so it can
 * be pasted into apps with no real mermaid support, e.g. Confluence. The PNG
 * bytes are shipped to the native shell which owns the clipboard. Never throws;
 * the error message is returned so the caller can show it to the user.
 */
export async function copyMermaidAsImage(
  source: SVGSVGElement | HTMLImageElement,
): Promise<CopyMermaidResult> {
  try {
    if (!hasBridge()) {
      return {
        ok: false,
        error: 'Copying mermaid images requires the native app (no developer browser support).',
      }
    }
    const { data, error } = await rasterizeMermaidSource(source)
    if (!data) return { ok: false, error: error ?? 'Could not rasterize the diagram' }
    await invoke('copyImage', { data })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Save the on-screen mermaid diagram as a PNG file. The native shell shows a
 * save dialog first (default name from the open document); on cancel this
 * resolves immediately with ``ok: true`` (nothing to report). On confirm the
 * diagram is rasterized and written to the chosen path; ``path`` is set on
 * success so the caller can flash it in the status bar.
 */
export async function saveMermaidAsImage(
  source: SVGSVGElement | HTMLImageElement,
  defaultName: string,
): Promise<CopyMermaidResult> {
  try {
    if (!hasBridge()) {
      return {
        ok: false,
        error: 'Saving mermaid images requires the native app (no developer browser support).',
      }
    }
    const path = await pickImageSavePath(defaultName)
    if (!path) return { ok: true }
    const { data, error } = await rasterizeMermaidSource(source)
    if (!data) return { ok: false, error: error ?? 'Could not rasterize the diagram' }
    await writeBinaryFile(path, data)
    return { ok: true, path }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
