// Color adaptation for mermaid diagrams: contrast correction and pinning of
// native SVG text fills. Extracted from `mermaid.ts` to keep that module small.
// Re-exported from `mermaid.ts` for backwards compatibility.

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

export const MERMAID_THEME_DARK: Record<string, string> = {
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

export function resolvedTextFill(el: SVGElement): string | null {
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
