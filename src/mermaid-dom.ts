/**
 * The rendered SVG, as mermaid actually draws it.
 *
 * Mermaid's output is not a public API: its class names and the shape of its
 * SVG are implementation details that a minor upgrade is free to change. Every
 * selector that reads them therefore lives here, next to one rule per diagram
 * family that needs it, so an upgrade has a single file to audit.
 *
 * Selectors for Edi's own elements (`.mermaid`, `.mermaid-preview`,
 * `.mermaid-editables`, the board chrome) stay with the modules that own them.
 */

/**
 * Diagram families whose labels map onto a known source construct. Everything
 * else is `generic`, which is enough for a diagram whose labels each occur once
 * in the source (pie, mindmap, gantt, timeline, quadrant, treemap, …).
 */
export type DiagramFamily =
  | 'graph'
  | 'sequence'
  | 'kanban'
  | 'state'
  | 'er'
  | 'class'
  | 'git'
  | 'requirement'
  | 'sankey'
  | 'wardley'
  | 'venn'
  | 'journey'
  | 'treemap'
  | 'xychart'
  | 'packet'
  | 'generic'

/** How a label relates to the rest of the source. */
export type LabelRole = 'text' | 'entity'

// ── label structure ────────────────────────────────────────────────────────

/** Mermaid's native label elements plus the HTML labels it wraps in foreignObjects. */
const LABEL_SELECTOR = [
  'text',
  '.nodeLabel',
  '.edgeLabel',
  '.labelText',
  '.loopText',
  '.loopLabel',
  '.titleText',
  '.sectionTitle',
  '.taskText',
  '.taskTextOutside',
  '.pieTitleText',
].join(', ')

/**
 * Labels mermaid generates rather than reads: axis ticks, pie percentages and
 * the icon sprites under `defs`/`marker`/`symbol`.
 */
const GENERATED_LABEL_SELECTOR = 'g.tick, g.xAxis, g.yAxis, .slice, defs, marker, symbol, pattern, style'

/**
 * Per-family labels to leave out, because the value on screen is computed from
 * the source rather than read out of it: a treemap's per-section totals, a
 * packet field's bit range, an xy chart's y-axis tick numbers.
 */
const GENERATED_BY_FAMILY: Partial<Record<DiagramFamily, string>> = {
  treemap: '.treemapSectionValue, .treemapValue',
  xychart: 'g.left-axis .label',
  packet: '.packetByte',
}

/** Elements a label may wrap, all of which round-trip to plain text. */
const LABEL_WRAPPERS = new Set(['P', 'SPAN', 'TSPAN', 'DIV', 'B', 'I', 'EM', 'STRONG'])

/**
 * The plain text of a label element, or `null` when it cannot round-trip: a
 * `<br/>` turns "a<br/>b" into "ab", markdown bold turns `**x**` into `x`, and
 * an icon contributes nothing at all. Those labels are left uneditable rather
 * than patched into something the source never said.
 */
export function labelTextOf(element: Element): string | null {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) continue
    if (node.nodeType !== 1) return null
    const child = node as Element
    // SVG element names are case-sensitive and `tagName` is lowercase for
    // them (`tspan`), so compare case-insensitively or every native label
    // mermaid wraps in a tspan (sequence participants, gantt, pie) is skipped.
    if (!LABEL_WRAPPERS.has(child.tagName.toUpperCase())) return null
    if (labelTextOf(child) === null) return null
  }
  const text = (element.textContent ?? '').trim()
  return text.length > 0 ? text : null
}

/**
 * Every label element mermaid drew for the generic label walk, minus the ones
 * the family computes for itself.
 */
export function labelElements(svg: SVGSVGElement, family: DiagramFamily): Element[] {
  const generated = GENERATED_BY_FAMILY[family] ?? ''
  return Array.from(svg.querySelectorAll(LABEL_SELECTOR)).filter(
    (el) => !el.closest(GENERATED_LABEL_SELECTOR) && (generated === '' || !el.closest(generated)),
  )
}

/** The innermost label element of a group, skipping the empty spacer labels. */
export function labelElementIn(scope: Element | null): Element | null {
  if (!scope) return null
  for (const el of Array.from(scope.querySelectorAll('.nodeLabel, .edgeLabel, text'))) {
    if (labelTextOf(el) !== null) return el
  }
  return null
}

function inGroup(el: Element, selector: string): boolean {
  return el.closest(selector) !== null
}

/**
 * How each family marks a label as naming a thing rather than describing one.
 * One rule per family, so a new family's selectors are added here and nowhere
 * else.
 */
const FAMILY_LABEL_ROLES: Partial<
  Record<DiagramFamily, (el: Element, text: string) => LabelRole>
> = {
  state: (el) => (inGroup(el, '.statediagram-state') ? 'entity' : 'text'),
  er: (el) => {
    if (inGroup(el, '.attribute-type')) return 'text'
    if (inGroup(el, '.attribute-name')) return 'text'
    return inGroup(el, 'g.node') ? 'entity' : 'text'
  },
  class: (el) => (inGroup(el, '.label-group') ? 'entity' : 'text'),
  git: (el) => (inGroup(el, '.branchLabel') ? 'entity' : 'text'),
  sankey: () => 'entity',
  wardley: (el) => (inGroup(el, '.wardley-node-label') ? 'entity' : 'text'),
  venn: (el) => (inGroup(el, '.venn-circle') ? 'entity' : 'text'),
  journey: (el) => (inGroup(el, '.legend') ? 'entity' : 'text'),
  // A requirement's rows are drawn as `Key: value`; what is left names the
  // requirement, and the relations between them refer to it.
  requirement: (_el, text) => (text.includes(':') ? 'text' : 'entity'),
}

/**
 * Whether a label names a thing rather than describing one. Only families with
 * references to rewrite need the distinction; everything else is prose.
 */
export function labelRole(family: DiagramFamily, el: Element, text: string): LabelRole {
  return FAMILY_LABEL_ROLES[family]?.(el, text) ?? 'text'
}

// ── labels drawn on a board ────────────────────────────────────────────────

const BAND_SELECTOR = '.cluster-label'
const HEADER_SELECTOR = '.cluster-label, .cluster-title'
const BAND_LABEL_SELECTOR = '.cluster-label .nodeLabel, .cluster-title, .nodeLabel'

/** A column's header label, or `null` for a group that has none. */
export function bandHeaderIn(scope: Element | null | undefined): Element | null {
  return scope?.querySelector(BAND_SELECTOR) ?? null
}

/** Either header mermaid may draw for a column. */
export function headerIn(scope: Element | null | undefined): Element | null {
  return scope?.querySelector(HEADER_SELECTOR) ?? null
}

/** The header a press landed on, which is a rename rather than a grab. */
export function headerAt(el: Element): Element | null {
  return el.closest(HEADER_SELECTOR)
}

/** The label text a board control dresses, or the element that holds it. */
export function bandLabelIn(scope: Element | null | undefined): Element | null {
  const label = scope?.querySelector(BAND_LABEL_SELECTOR) ?? null
  return label?.querySelector('p') ?? label
}

/** The column a label or card is drawn in, or `null` off a board. */
export function sectionGroupOf(el: Element): SVGElement | null {
  return el.closest<SVGElement>('.sections > g')
}

/** The card a label or element belongs to, or `null` for one that is not a card. */
export function cardGroupOf(el: Element): SVGElement | null {
  return el.closest<SVGElement>('.items > .node')
}

/** The node group of a generic diagram, if the element is inside one. */
export function nodeGroupOf(el: Element): SVGElement | null {
  return el.closest<SVGElement>('g.node')
}

// ── columns and cards ─────────────────────────────────────────────────────

/** A drawn card, whether or not it is one of the model's cards. */
export const CARD_SELECTOR = '.items > .node'

/** Every real column, in board order. */
export function sectionElements(svg: SVGSVGElement): SVGElement[] {
  return Array.from(svg.querySelectorAll<SVGElement>('.sections > g[class*="section-"]'))
}

/** Every card, drawn slots included, in board order. */
export function cardElements(svg: SVGSVGElement): SVGElement[] {
  return Array.from(svg.querySelectorAll<SVGElement>('.items > g.node'))
}

/** The card list, which the drop line is inserted before. */
export function itemLayer(svg: SVGSVGElement): Element | null {
  return svg.querySelector('.items')
}

/** The column list, which a column's drop line is inserted before. */
export function sectionLayer(svg: SVGSVGElement): Element | null {
  return svg.querySelector('.sections')
}

/** The background rect that sizes a column or card. */
export function sectionFrame(section: Element): SVGRectElement | null {
  return section.querySelector('rect')
}

/** The two pieces of a card a composer touches: its frame and its HTML label box. */
export function cardPieces(el: Element): {
  rect: SVGRectElement | null
  frame: SVGForeignObjectElement | null
} {
  return {
    rect: el.querySelector<SVGRectElement>('rect'),
    frame: el.querySelector<SVGForeignObjectElement>('foreignObject'),
  }
}

// ── native drawing primitives ─────────────────────────────────────────────

/** Native SVG text, including the tspans mermaid wraps labels in. */
export function textElements(svg: SVGSVGElement): SVGTextElement[] {
  return Array.from(svg.querySelectorAll<SVGTextElement>('text, text tspan'))
}

/** Whether an element is one of mermaid's HTML labels rather than native text. */
export function isHtmlLabel(el: Element): boolean {
  return el.closest('foreignObject') !== null
}

/** Shapes whose fill and stroke mermaid may have hardcoded. */
export function shapeElements(svg: SVGSVGElement): SVGElement[] {
  return Array.from(svg.querySelectorAll<SVGElement>('line, rect, path, polygon, polyline'))
}

/** Arrowhead and marker paths, which carry their own fill. */
export function markerPaths(svg: SVGSVGElement): SVGPathElement[] {
  return Array.from(svg.querySelectorAll<SVGPathElement>('marker path'))
}

// ── the theme rule mermaid measures with ──────────────────────────────────

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
export const MERMAID_LABEL_WRAP_CSS = `
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
