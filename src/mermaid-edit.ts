/**
 * Visual editing for rendered mermaid diagrams: reading the labels out of a
 * rendered SVG, mapping them back onto the source, and patching that source.
 *
 * The block's `value` is the source of truth and the SVG is derived state:
 * every visual edit (retitling a label, dragging a kanban card) patches the
 * mermaid source and re-renders through `renderDiagram` — the same pipeline
 * the initial render and node updates already use. When a
 * patch produces source mermaid refuses to parse, the last good diagram stays
 * on screen and a transient notice explains why, instead of the whole diagram
 * being replaced by an error block.
 *
 * Everything *stateful* about that lives in `src/mermaid-session.ts`, one
 * `DiagramSession` per block: the source every patch is computed from, which
 * phase the block is in, the field, the drag, the menu, and the placement of
 * every overlay on the board. This file holds the two pure halves — the label
 * model and the source model — and the three things that need the DOM: the
 * editing layer of one render, the field a label is edited in, and the drag.
 * Nothing here holds state between renders, and nothing here patches a source
 * snapshot it took when it was built.
 */

import {
  adaptDiagramColors,
  bakeDiagram,
  errorBlock,
  loadMermaid,
  pinSvgTextColors,
  responsifySvg,
} from './mermaid'
import { promptForKanbanDelete } from './urlDialog'
import type { DiagramSession, EditSubject, RenderScope } from './mermaid-session'
import { FIELD_CLASS, sessionFor, stopEditing } from './mermaid-session'
export { endSession as discardMermaidSession } from './mermaid-session'

/** The box a field is placed in, so the node view can keep its events out of ProseMirror. */
export { FIELD_CLASS }

// ── classes and timings ────────────────────────────────────────────────────

const EDITABLE_CLASS = 'mermaid-editables'
const NOTICE_TEXT =
  "Couldn't parse diagram — keeping the previous version. Edit the source to fix it."
/** The card being dragged: the real one, lifted out of the board to follow the pointer. */
const DRAG_CARD_CLASS = 'kanban-dragging-card'
/** On the preview while a card is in flight, so the board stops clipping it. */
const DRAG_CONTAINER_CLASS = 'kanban-dragging'

/** On a whole lifted list: the frame, so the list reads as one thing leaving. */
const DRAG_COLUMN_CLASS = 'kanban-dragging-column'
/**
 * On the group a lifted list is held in — the one thing on the board that is
 * neither a frame nor a card, and exists only while a column is in the air.
 */
const DRAG_LAYER_CLASS = 'kanban-drag-layer'
/** The line drawn in the gap the card will drop into. */
const DROP_LINE_CLASS = 'kanban-drop-line'
const DROP_TARGET_CLASS = 'kanban-drop-target'
/** How far a line sits outside the cards bracketing a gap, in px. */
const DROP_LINE_GAP = 5
/** How far the line reaches past its column, so it still shows either side of
 *  the card that covers it — mermaid draws a card ~15px narrower than its column. */
const DROP_LINE_OVERHANG = 4
/** How much the lifted card grows while it is held, about its own corner. */
const DRAG_LIFT_SCALE = 1.04

/**
 * The board's own controls in edit mode, all of them this class plus one naming
 * the thing they do. The node view keys its own event handling off the base
 * class, so a button added here is excluded from ProseMirror and from the
 * double-click that ends an edit session without touching any of them.
 */
export const KANBAN_BUTTON_CLASS = 'mermaid-kanban-btn'
/** The quiet `⋯` in a column's corner, and the menu it opens. */
export const MENU_BUTTON_CLASS = 'mermaid-kanban-menu'
const MENU_LIST_CLASS = 'mermaid-kanban-menu-list'
const MENU_ITEM_CLASS = 'mermaid-kanban-menu-item'
/** Drawn on the board for the card a column is offered next, and its composer. */
export const ADD_SLOT_CLASS = 'mermaid-kanban-slot'
/** Drawn on the board for the column the board is offered next. */
export const COLUMN_SLOT_CLASS = 'mermaid-kanban-column-slot'
/**
 * The layer every board control is built into, exported because the node view
 * keys its own event handling off it: it holds the buttons *and* the menu list,
 * which is not a button but is just as much the editor's own surface — a double
 * click inside an open menu is a click on a menu, not a request to end the edit.
 */
export const KANBAN_CHROME_CLASS = 'mermaid-kanban-chrome'
/** The bin's mark, drawn in the band's own name — see `trashIcon`. */
const KANBAN_BIN_MARK_CLASS = 'mermaid-kanban-bin-mark'
/**
 * The card slot in the drawn column, which is the bin for the length of a card's
 * drag and nothing at all the rest of the time. It is drawn rather than added on
 * demand because mermaid laid the board out with it and a drag may not re-render
 * the drawing out from under the card it is holding, so the class is how it is
 * *blank* instead — see where it is put on.
 */
const KANBAN_BIN_SLOT_CLASS = 'mermaid-kanban-bin-slot'
const MENU_ITEM_KIND_CLASS = 'mermaid-kanban-menu-item-'
const MENU_ITEM_DANGER_CLASS = 'is-danger'
/**
 * The list is placed flush with the bottom of the `⋯` it belongs to, and this
 * used to be the distance between them instead. A gap there is a hole in the
 * popover: the board shows through it, so the menu reads as something floating
 * under a button rather than hanging off it, and the pointer crosses it on its
 * way down to the items every single time. Bridging the hole closed it for a hit
 * test and not for the eye — the `::before` that closed it had no background, so
 * what the user saw was the board. There is no gap to bridge now.
 */
// A column's name is one line of text, and the field that asks for it is placed
// where a new column will stand — which on a board of empty columns is a band
// only as tall as its header. A composer taller than the slot it fills hangs off
// the bottom of the board, so it is one line here; the *card* composer is the one
// that grows with the title being written.
const COMPOSER_HEIGHT = 30
/** Half a board button's side, in px. */
const KANBAN_BUTTON_HALF = 9
/** From a column's own corner to the edge of its control. */
const KANBAN_BUTTON_EDGE = 8
/** The menu's own width, in px — it is the width of its longest item. */
const MENU_WIDTH = 190
/** A field retyping an existing label, in px. */
const RENAME_FIELD_WIDTH = 140


/** Marks a `.mermaid` block that is in edit mode rather than previewing. */
export const EDITING_CLASS = 'mermaid-editing'
/** Pointer travel, in px, before a card press turns into a drag rather than a click. */
const DRAG_THRESHOLD = 4

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

interface Span {
  start: number
  end: number
}

let renderSeed = 0

// ── diagram type ───────────────────────────────────────────────────────────

/**
 * The first meaningful line of a diagram names its type: `kanban`,
 * `sequenceDiagram`, `graph TD` / `flowchart-elk LR`, `stateDiagram-v2`,
 * `pie title …`, `C4Context`, … Blank lines, `%%` comments and a leading YAML
 * frontmatter block are skipped.
 */
export function detectDiagramType(source: string): string {
  const lines = source.split('\n')
  let inFrontmatter = false
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (index === 0 && line === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false
      continue
    }
    if (!line || line.startsWith('%%')) continue
    return line.split(/\s+/, 1)[0]
  }
  return ''
}

function diagramFamily(type: string): DiagramFamily {
  switch (type.toLowerCase()) {
    case 'graph':
    case 'flowchart':
    case 'flowchart-elk':
      return 'graph'
    case 'sequencediagram':
      return 'sequence'
    case 'kanban':
      return 'kanban'
    case 'statediagram':
    case 'statediagram-v2':
      return 'state'
    case 'erdigram':
    case 'erdiagram':
      return 'er'
    case 'classdiagram':
    case 'classdiagram-v2':
      return 'class'
    case 'gitgraph':
      return 'git'
    case 'requirementdiagram':
      return 'requirement'
    case 'sankey-beta':
      return 'sankey'
    case 'wardley-beta':
      return 'wardley'
    case 'venn-beta':
      return 'venn'
    case 'journey':
      return 'journey'
    case 'treemap-beta':
      return 'treemap'
    case 'xychart-beta':
      return 'xychart'
    case 'packet-beta':
      return 'packet'
    default:
      return 'generic'
  }
}

// ── reading labels out of the rendered SVG ─────────────────────────────────

/** Elements a label may wrap, all of which round-trip to plain text. */
const LABEL_WRAPPERS = new Set(['P', 'SPAN', 'TSPAN', 'DIV', 'B', 'I', 'EM', 'STRONG'])

/**
 * The plain text of a label element, or `null` when it cannot round-trip: a
 * `<br/>` turns "a<br/>b" into "ab", markdown bold turns `**x**` into `x`, and
 * an icon contributes nothing at all. Those labels are left uneditable rather
 * than patched into something the source never said.
 */
function labelTextOf(element: Element): string | null {
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
 * How a label relates to the rest of the source. A `text` label is prose that
 * happens to sit in the source verbatim; an `entity` label *names* something the
 * source also refers to elsewhere (an ER entity, a state, a git branch), so
 * renaming it has to rewrite every reference with it.
 */
type LabelRole = 'text' | 'entity'

/** Everything a mapper needs about a rendered label, minus the DOM. */
interface LabelRef {
  text: string
  role: LabelRole
  /** Which copy of a repeated label this is, in DOM order. */
  occurrence: number
  /** How many labels in this diagram share the same text. */
  count: number
}

interface LabelTarget extends LabelRef {
  el: Element
  /**
   * The label as the source spells it, whenever the DOM shows it wrapped in
   * something the patch will not touch: mermaid wraps a long label across
   * `tspan`s and `textContent` reads them back with the spaces dropped
   * (`Lack of Training` renders as `Lack ofTraining`), a sankey node shares its
   * element with its computed total, and a requirement row is drawn under
   * mermaid's own idea of the key (`verifymethod: test` shows as
   * `Verification: Test`). Editing the source's own spelling keeps its spacing
   * and replaces exactly the span the mapper resolved — an edit to a drawn
   * prefix would be dropped on commit.
   */
  sourceText?: string
}

/** Label elements that render something the source never spelled out. */
const STEREO = /^<<.+>>$/

/**
 * Per-family labels to leave out, because the value on screen is computed from
 * the source rather than read out of it: a treemap's per-section totals, a
 * packet field's bit range, an xy chart's y-axis tick numbers. Renaming any of
 * them would patch an unrelated number or string elsewhere in the source, so
 * they are not offered at all rather than offered and failed.
 */
const GENERATED_BY_FAMILY: Partial<Record<DiagramFamily, string>> = {
  treemap: '.treemapSectionValue, .treemapValue',
  xychart: 'g.left-axis .label',
  packet: '.packetByte',
}

/**
 * Every label of a rendered diagram that can be mapped back to source text.
 * Mermaid emits HTML labels inside `foreignObject` (the default) and native
 * `<text>` (sequence, gantt, pie, …); both are elements whose rect the overlay
 * is positioned from, so both are collected.
 *
 * A label is only collected when the same mapper that patches it can find a
 * source range for it right now: a diagram must never show a label as editable
 * and then fail the edit.
 */
function labelTargets(svg: SVGSVGElement, family: DiagramFamily, source: string): LabelTarget[] {
  const targets: LabelTarget[] = []
  if (family === 'kanban') {
    // Kanban renders three label slots per card (title, spacer, assignee) and
    // only the first is the card's own text; a section's label is its header.
    for (const section of sectionElements(svg)) {
      const label = labelElementIn(section.querySelector('.cluster-label') ?? section)
      const text = label && labelTextOf(label)
      if (label && text) targets.push({ el: label, text, role: 'text', occurrence: 0, count: 1 })
    }
    for (const card of cardElements(svg)) {
      const label = labelElementIn(card)
      const text = label && labelTextOf(label)
      if (label && text) targets.push({ el: label, text, role: 'text', occurrence: 0, count: 1 })
    }
    return editable(indexTargets(targets), family, source)
  }

  const generated = GENERATED_BY_FAMILY[family] ?? ''
  for (const el of Array.from(svg.querySelectorAll(LABEL_SELECTOR))) {
    if (el.closest(GENERATED_LABEL_SELECTOR)) continue
    if (generated && el.closest(generated)) continue
    const raw = labelTextOf(el)
    if (!raw) continue
    // A sankey node draws its name above a generated total in one text element;
    // only the name line is the label.
    const text = family === 'sankey' ? (raw.split('\n')[0].trim() ?? '') : raw
    if (!text || STEREO.test(text)) continue
    targets.push({ el, text, role: labelRole(family, el, text), occurrence: 0, count: 1 })
  }
  return editable(indexTargets(outermost(targets)), family, source)
}

/**
 * Number the labels by how often their text repeats, and drop the ones no
 * mapper can resolve — the DOM's copy of the label is the only evidence of
 * which copy of a repeated text was clicked, so it is what tells two identical
 * labels apart.
 */
function indexTargets(targets: LabelTarget[]): LabelTarget[] {
  const counts = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const target of targets) counts.set(target.text, (counts.get(target.text) ?? 0) + 1)
  for (const target of targets) {
    target.count = counts.get(target.text) ?? 1
    target.occurrence = seen.get(target.text) ?? 0
    seen.set(target.text, target.occurrence + 1)
  }
  return targets
}

/**
 * Only offer a label the mapper can already resolve. This is what keeps the
 * promise the editor makes: every label that looks editable really is, and a
 * label whose text mermaid merely derived — a truncated cell, a default axis
 * name, an implicit branch — is not offered at all.
 */
function editable(
  targets: LabelTarget[],
  family: DiagramFamily,
  source: string,
): LabelTarget[] {
  return targets.filter((target) => {
    const resolved = resolveLabelSpans(source, family, target)
    if (resolved === null || resolved === 'ambiguous') return false
    const first = resolved.spans[0]
    if (first) {
      // The source's own spelling of what the patch will replace, whenever
      // mermaid drew that inside something else: a dropped space, a computed
      // value, a key (and sometimes a case) of its own invention. Compared
      // case-blindly, since a drawn row capitalises a value the source
      // lowercases; equal counts as a suffix, so the wrapped-tspan case needs
      // no rule of its own.
      const spelled = source.slice(first.start, first.end).trim()
      const shown = squeeze(target.text).text.toLowerCase()
      const spelledShown = squeeze(renderedText(spelled)).text.toLowerCase()
      if (spelled && spelled !== target.text && (shown.endsWith(squeeze(spelled).text.toLowerCase()) || shown === spelledShown)) {
        target.sourceText = spelled
      }
    }
    return true
  })
}

/**
 * Whether a label names a thing rather than describing one. Only families with
 * references to rewrite need the distinction; everything else is prose.
 */
function labelRole(family: DiagramFamily, el: Element, text: string): LabelRole {
  const inNode = (selector: string): boolean => el.closest(selector) !== null
  switch (family) {
    case 'state':
      return inNode('.statediagram-state') ? 'entity' : 'text'
    case 'er':
      if (inNode('.attribute-type')) return 'text'
      if (inNode('.attribute-name')) return 'text'
      return inNode('g.node') ? 'entity' : 'text'
    case 'class':
      return inNode('.label-group') ? 'entity' : 'text'
    case 'git':
      return inNode('.branchLabel') ? 'entity' : 'text'
    case 'sankey':
      return 'entity'
    case 'wardley':
      return inNode('.wardley-node-label') ? 'entity' : 'text'
    case 'venn':
      return inNode('.venn-circle') ? 'entity' : 'text'
    case 'journey':
      return inNode('.legend') ? 'entity' : 'text'
    case 'requirement':
      // A requirement's rows are drawn as `Key: value`; what is left names the
      // requirement, and the relations between them refer to it.
      return text.includes(':') ? 'text' : 'entity'
    default:
      return 'text'
  }
}

/**
 * Drop labels nested inside another label. Mermaid wraps a label in several
 * matching elements (`span.nodeLabel > p.nodeLabel`), and they all show the same
 * text, so only the outermost one is the label.
 */
function outermost(targets: LabelTarget[]): LabelTarget[] {
  const found = new Set(targets.map((target) => target.el))
  return targets.filter((target) => {
    for (let el = target.el.parentElement; el; el = el.parentElement) {
      if (found.has(el)) return false
    }
    return true
  })
}

/** The innermost label element of a group, skipping the empty spacer labels. */
function labelElementIn(scope: Element | null): Element | null {
  if (!scope) return null
  for (const el of Array.from(scope.querySelectorAll('.nodeLabel, .edgeLabel, text'))) {
    if (labelTextOf(el) !== null) return el
  }
  return null
}

function sectionElements(svg: SVGSVGElement): SVGElement[] {
  return Array.from(svg.querySelectorAll<SVGElement>('.sections > g[class*="section-"]'))
}

function cardElements(svg: SVGSVGElement): SVGElement[] {
  return Array.from(svg.querySelectorAll<SVGElement>('.items > g.node'))
}

// ── mapping a label back onto the source text ──────────────────────────────

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceSpans(source: string, spans: Span[], next: string): string {
  let out = ''
  let cursor = 0
  for (const span of spans) {
    out += source.slice(cursor, span.start) + next
    cursor = span.end
  }
  return out + source.slice(cursor)
}

interface MapperResult {
  spans: Span[]
  /**
   * Rename semantics: an actor declared without an `as` alias has to be
   * renamed everywhere it is referenced, so every match is rewritten. Every
   * other mapper is a "replace this one label" edit and is refused when the
   * label is not unique.
   */
  all?: boolean
  /**
   * What to write over the spans when the drawn label is not the source text it
   * stands for — a requirement row is drawn as `Verification: Test` and lives in
   * the source as `verifymethod: test`, so the key is part of the label on
   * screen and none of it is part of the text being replaced.
   */
  render?: (newLabel: string) => string
}

/**
 * Span of the label inside a flowchart-style node: `A[Old]`, `A"Old"`,
 * `A((Old))`, `A{{Old}}`, `A>Old]`, `A[/Old/]`, `A[/Old\]`, `A[[Old]]`, …
 * The lookbehind keeps `-- text -->B` from reading `>B` as a shape delimiter.
 */
function graphNodeSpans(source: string, label: string): MapperResult {
  const re = new RegExp(
    `([A-Za-z_][\\w.-]*[ ]*(?<![-=])[\\(\\[\\{<>]{1,3}["']?)(${escapeRe(label)})["']?[\\)\\]\\}>]{1,3}`,
    'g',
  )
  const spans: Span[] = []
  for (let match = re.exec(source); match; match = re.exec(source)) {
    const start = match.index + match[1].length
    spans.push({ start, end: start + match[2].length })
  }
  return { spans }
}

/** Span of an edge label: `A -->|Old| B`, `A -- Old --> B`, `A-. Old .-> B`, `A == Old ==> B`. */
function graphEdgeSpans(source: string, label: string): MapperResult {
  const escaped = escapeRe(label)
  const patterns = [
    // …|Old|…
    new RegExp(`(\\|[ ]*["']?)(${escaped})(["']?[ ]*\\|)`, 'g'),
    // …arrow1…Old…arrow2…  (longest arrow forms first so `---` beats `--`)
    new RegExp(`((?:--|-\\.|==)[ ]*["']?)(${escaped})(["']?[ ]*(?:-->|---|\\.->|==>|==))`, 'g'),
  ]
  const spans: Span[] = []
  for (const re of patterns) {
    for (let match = re.exec(source); match; match = re.exec(source)) {
      if (!ARROW.test(lineAt(source, match.index))) continue
      const start = match.index + match[1].length
      spans.push({ start, end: start + match[2].length })
    }
  }
  return { spans }
}

const ARROW = /[-=<>]{2,}|-\.|\(-/

function lineAt(source: string, offset: number): string {
  const start = source.lastIndexOf('\n', offset) + 1
  const end = source.indexOf('\n', offset)
  return source.slice(start, end < 0 ? undefined : end)
}

const SEQ_DECL = /^[ \t]*(participant|actor)[ \t]+(\S+)(?:[ \t]+as[ \t]+(.*?))?[ \t]*$/

/**
 * Sequence spans, in order of specificity:
 *
 * - a participant declared by bare name (`participant Alice`) is shown as its
 *   own id, so retitling it renames the id — the declaration and every
 *   reference to it, but never an occurrence inside message text, which is
 *   prose rather than the actor's name;
 * - an aliased participant (`participant S as Server`) renames in its alias;
 * - everything else is the text after the `:` of a message or a note.
 */
function sequenceSpans(source: string, label: string): MapperResult {
  const lines = sourceLines(source).filter((line) => !line.comment)
  const bare = bareParticipant(lines, label)
  if (bare !== null) return { spans: participantRenameSpans(lines, bare), all: true }

  const spans: Span[] = []
  for (const line of lines) {
    const decl = SEQ_DECL.exec(line.text)
    if (decl) {
      if (decl[3] === label) {
        const end = line.offset + line.text.trimEnd().length
        spans.push({ start: end - label.length, end })
      }
      continue
    }
    const message = messageSpan(line, label)
    if (message) spans.push(message)
  }
  return { spans }
}

/** The id of a participant declared without an `as` alias, when it is the label. */
function bareParticipant(lines: SourceLine[], label: string): string | null {
  for (const line of lines) {
    const decl = SEQ_DECL.exec(line.text)
    if (decl && decl[3] === undefined && decl[2] === label) return decl[2]
  }
  return null
}

function participantRenameSpans(lines: SourceLine[], id: string): Span[] {
  const spans: Span[] = []
  for (const line of lines) {
    const decl = SEQ_DECL.exec(line.text)
    if (decl) {
      if (decl[3] === undefined) spans.push(...wholeWordSpans(line, id, line.text.length))
      continue
    }
    // Message endpoints, `Note over …` subjects and `activate`/`deactivate`
    // targets are all references to the actor; message text is not.
    const colon = line.text.indexOf(':')
    spans.push(...wholeWordSpans(line, id, colon < 0 ? line.text.length : colon))
  }
  return spans
}

/** The span of `label` as the text of a `…: message` line. */
function messageSpan(line: SourceLine, label: string): Span | null {
  const colon = line.text.indexOf(':')
  if (colon < 0) return null
  const rest = line.text.slice(colon + 1)
  if (rest.trim() !== label) return null
  const start = line.offset + colon + 1 + (rest.length - rest.trimStart().length)
  return { start, end: start + label.length }
}

/**
 * Whole-word occurrences of `word` between `from` and `limit` in a line. The
 * window is what keeps a rename off syntax: the id after a `branch` keyword, or
 * the state id before a transition's `:`.
 */
function wholeWordSpans(
  line: SourceLine,
  word: string,
  limit: number,
  from = 0,
): Span[] {
  const spans: Span[] = []
  // A participant id is delimited by punctuation, so an id followed by an arrow
  // (`Alice->>S`) matches while a hyphenated one (`my-actor`) never matches
  // half of itself.
  const re = new RegExp(`(?<![-\\w])${escapeRe(word)}(?!\\w)(?![-]\\w)`, 'g')
  for (let match = re.exec(line.text); match; match = re.exec(line.text)) {
    if (match.index < from) continue
    if (match.index >= limit) break
    spans.push({ start: line.offset + match.index, end: line.offset + match.index + word.length })
  }
  return spans
}

/** A label that is one whole emphasis run, e.g. `*italic*`, `**bold**`. */
const EMPHASIS_WRAP = /^(\*\*\*|\*\*|\*|___|__|_|~~|`)([\s\S]+)\1$/

/** The label mermaid draws from a source spelling: inline emphasis and code
 * markers render as elements, so the board shows the text without them. */
function renderedText(label: string): string {
  return label
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/___([^_]+)___/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}


function kanbanSpans(source: string, label: string): MapperResult {
  const spans: Span[] = []
  let quoted = false
  for (const line of parseKanban(source).lines) {
    if (line.kind !== 'column' && line.kind !== 'card') continue
    if (!line.label) continue
    // The board draws a label's inline markdown, so the text on screen is the
    // source's spelling minus its markers — match either spelling.
    if (line.label !== label && renderedText(line.label) !== label) continue
    const isQuoted = source[line.labelStart] === '"' && source[line.labelEnd - 1] === '"'
    if (isQuoted) quoted = true
    const marks = EMPHASIS_WRAP.exec(line.label)
    if (marks) {
      // The markers are drawn as elements, so when the user edits the inner
      // text they stay in the source and the emphasis survives the rename.
      const innerOffset = (isQuoted ? 1 : 0) + marks[1].length
      spans.push({ start: line.labelStart + innerOffset, end: line.labelEnd - innerOffset })
    } else {
      spans.push({ start: line.labelStart, end: line.labelEnd })
    }
  }
  // A label the source already spells as a quoted run keeps its quotes:
  // mermaid draws a quoted label exactly as it draws a bare one, so the quotes
  // are invisible in the board, and stripping them would silently rewrite
  // source the rename was not asked to change. A bare label is spelled bare
  // when it can be and quoted when the title needs it, so `Plain` renamed to
  // `Fix (bug)` writes `["Fix (bug)"]` — a title no bare form can carry.
  return { spans, render: quoted ? kanbanQuotedLabel : kanbanInnerLabel }
}

/** A state id is referenced by every transition that touches it. */
function stateSpans(source: string, ref: LabelRef): MapperResult | null {
  const lines = sourceLines(source).filter((line) => !line.comment)
  if (ref.role === 'text') {
    // A transition label is the text after the `:` of an edge.
    const spans = lines
      .map((line) => messageSpan(line, ref.text))
      .filter((span): span is Span => span !== null)
    return spans.length > 0 ? { spans } : null
  }
  const spans: Span[] = []
  for (const line of lines) {
    const colon = line.text.indexOf(':')
    spans.push(...wholeWordSpans(line, ref.text, colon < 0 ? line.text.length : colon))
  }
  return spans.length > 0 ? { spans, all: true } : null
}

const ER_ATTRIBUTE = /^\s*\w+\s+\w+(?:\s+(?:PK|FK|UK))?\s*$/
const ER_RELATION = /(?:\.\.)|(?:--)/
const ER_ATTRIBUTE_LINE = /^\s*(\S+)\s+(\S+)\s*$/

/**
 * An ER attribute is drawn as two labels, its type (`string`) and its name
 * (`email`), on a line of its own. Matching the tokens rather than the text
 * anywhere in the source is what keeps `date` from being found inside
 * `order_date` as well, which would make the label ambiguous and withhold it.
 */
function erAttributeSpans(source: string, ref: LabelRef): MapperResult | null {
  if (ref.role !== 'text') return null
  const spans: Span[] = []
  for (const line of sourceLines(source).filter((l) => !l.comment)) {
    const attribute = ER_ATTRIBUTE_LINE.exec(line.text)
    if (!attribute) continue
    const [, type, name] = attribute
    const typeAt = line.text.indexOf(type)
    // Search past the type, so an attribute named `date` on a `date` line is
    // found on the right of it.
    const nameAt = line.text.indexOf(name, typeAt + type.length)
    if (type === ref.text && typeAt >= 0) {
      spans.push({ start: line.offset + typeAt, end: line.offset + typeAt + type.length })
    }
    if (name === ref.text && nameAt >= 0) {
      spans.push({ start: line.offset + nameAt, end: line.offset + nameAt + name.length })
    }
  }
  return spans.length > 0 ? { spans } : null
}

/**
 * An ER entity is named by its own attribute block and by every relationship it
 * takes part in, so a rename rewrites those; the lines declaring an attribute
 * (`string name`) are a different label and are left out.
 */
function erSpans(source: string, ref: LabelRef): MapperResult | null {
  if (ref.role !== 'entity') return null
  const spans: Span[] = []
  for (const line of sourceLines(source).filter((l) => !l.comment)) {
    if (ER_ATTRIBUTE.test(line.text)) continue
    if (!ER_RELATION.test(line.text) && !/^\s*\S+\s*\{/.test(line.text)) continue
    spans.push(...wholeWordSpans(line, ref.text, line.text.length))
  }
  return spans.length > 0 ? { spans, all: true } : null
}

const CLASS_DECL = /^\s*class\s+(\S+)/
const CLASS_RELATION = /(?:\.\.)|(?:--)|(?:\*--)|(?:o--)/

/** A class is named by its declaration and by every relation it takes part in. */
function classSpans(source: string, ref: LabelRef): MapperResult | null {
  if (ref.role !== 'entity') return null
  const spans: Span[] = []
  for (const line of sourceLines(source).filter((l) => !l.comment)) {
    const decl = CLASS_DECL.exec(line.text)
    if (decl) {
      // Group 0 already covers the name, so the window is the tail of the
      // match: the class id itself, never its `class` keyword.
      const end = decl[0].length
      spans.push(...wholeWordSpans(line, ref.text, end, end - decl[1].length))
    } else if (CLASS_RELATION.test(line.text)) {
      spans.push(...wholeWordSpans(line, ref.text, line.text.length))
    }
  }
  return spans.length > 0 ? { spans, all: true } : null
}

const GIT_REF = /^\s*(?:branch|checkout|switch|merge)\s+/i

/**
 * A git branch is named by `branch` and referred to by `checkout`, `switch` and
 * `merge`. Mermaid's implicit `main` is not in the source at all, so it resolves
 * to nothing and is never offered.
 */
function gitSpans(source: string, ref: LabelRef): MapperResult | null {
  if (ref.role !== 'entity') return null
  const spans: Span[] = []
  for (const line of sourceLines(source).filter((l) => !l.comment)) {
    const keyword = GIT_REF.exec(line.text)
    if (keyword) spans.push(...wholeWordSpans(line, ref.text, line.text.length, keyword[0].length))
  }
  return spans.length > 0 ? { spans, all: true } : null
}

const REQUIREMENT_ROW = /^[ \t]*[\w ]+?:[ \t]*(.*?)[ \t]*$/

/**
 * A requirement is named by its declaration and by the `- satisfies ->` /
 * `- verifies ->` relations that point at it. Its rows are `key: value` pairs
 * of which mermaid shows the value alone under its own idea of the key
 * (`verifymethod` is drawn as "Verification") and sometimes shortened, so a row
 * is matched on the value and rewritten whole.
 */
function requirementSpans(source: string, ref: LabelRef): MapperResult | null {
  const lines = sourceLines(source).filter((line) => !line.comment)
  if (ref.role === 'text') {
    const colon = ref.text.indexOf(':')
    const shown = colon < 0 ? '' : ref.text.slice(colon + 1).trim()
    if (!shown) return null
    const spans: Span[] = []
    for (const line of lines) {
      const row = REQUIREMENT_ROW.exec(line.text)
      if (!row || !shortens(row[1], shown)) continue
      const start = line.offset + row.index + row[0].length - row[1].length
      spans.push({ start, end: start + row[1].length })
    }
    if (spans.length === 0) return null
    // The drawn label repeats the key above the value; only the value is text
    // the source is being asked to change.
    return { spans, render: (next) => valueOf(next) }
  }
  const spans: Span[] = []
  for (const line of lines) {
    if (REQUIREMENT_ROW.test(line.text)) continue
    spans.push(...wholeWordSpans(line, ref.text, line.text.length))
  }
  return spans.length > 0 ? { spans, all: true } : null
}

/** The value part of a drawn `Key: value` row. */
function valueOf(label: string): string {
  const colon = label.indexOf(':')
  const value = colon < 0 ? label : label.slice(colon + 1)
  return value.trim()
}

/**
 * Whether the rendered value is the whole source value or the start of it,
 * mermaid having wrapped the rest away. Only a cut at a word boundary counts, so
 * the drawn `1` of an `id: 10` never matches the drawn `1` of an `id: 1`.
 */
function shortens(value: string, shown: string): boolean {
  const source = value.toLowerCase()
  const rendered = shown.toLowerCase()
  if (source === rendered) return true
  return source.startsWith(rendered) && /^\s/.test(source.slice(rendered.length))
}

/** A sankey node's name is a field in the CSV the diagram is drawn from. */
function sankeySpans(source: string, ref: LabelRef): MapperResult | null {
  const spans: Span[] = []
  for (const line of sourceLines(source)) {
    let at = 0
    for (const field of line.text.split(',')) {
      const trimmed = field.trim()
      if (trimmed === ref.text) {
        const start = line.offset + at + (field.length - field.trimStart().length)
        spans.push({ start, end: start + trimmed.length })
      }
      at += field.length + 1
    }
  }
  return spans.length > 0 ? { spans, all: true } : null
}

const WARDLEY_DECL = /^\s*(?:anchor|component)\s+/
const WARDLEY_LINK = /(?:->)|(?:\bevolve\s)/

/**
 * A wardley node is named by its `anchor`/`component` declaration and referred
 * to by the links and `evolve` lines between nodes. The axes and the evolution
 * stage names are mermaid's own unless the source spells them out, so they
 * resolve to nothing and stay uneditable.
 */
function wardleySpans(source: string, ref: LabelRef): MapperResult | null {
  if (ref.role !== 'entity') return null
  const spans: Span[] = []
  for (const line of sourceLines(source).filter((l) => !l.comment)) {
    const decl = WARDLEY_DECL.exec(line.text)
    if (decl) {
      spans.push(...wholeWordSpans(line, ref.text, line.text.length, decl[0].length))
    } else if (WARDLEY_LINK.test(line.text)) {
      spans.push(...wholeWordSpans(line, ref.text, line.text.length))
    }
  }
  return spans.length > 0 ? { spans, all: true } : null
}

const VENN_SET = /^\s*set\s+/i
const VENN_UNION = /^\s*union\s+/i

/** A venn set is named by its `set` line and by the union it appears in. */
function vennSpans(source: string, ref: LabelRef): MapperResult | null {
  if (ref.role !== 'entity') return null
  const spans: Span[] = []
  for (const line of sourceLines(source).filter((l) => !l.comment)) {
    const decl = VENN_SET.exec(line.text)
    if (decl) {
      spans.push(...wholeWordSpans(line, ref.text, line.text.length, decl[0].length))
    } else if (VENN_UNION.test(line.text)) {
      spans.push(...wholeWordSpans(line, ref.text, line.text.length))
    }
  }
  return spans.length > 0 ? { spans, all: true } : null
}

const JOURNEY_HEAD = /^\s*(?:title|section)\b/i

/**
 * The journey legend names the actor every task line scores, so a rename
 * rewrites the actor in each task and leaves the title and section headers —
 * which are prose that may well contain the same words — alone.
 */
function journeySpans(source: string, ref: LabelRef): MapperResult | null {
  if (ref.role !== 'entity') return null
  const spans: Span[] = []
  for (const line of sourceLines(source).filter((l) => !l.comment)) {
    if (JOURNEY_HEAD.test(line.text)) continue
    spans.push(...wholeWordSpans(line, ref.text, line.text.length))
  }
  return spans.length > 0 ? { spans, all: true } : null
}

function familyMapper(
  family: DiagramFamily,
  source: string,
  ref: LabelRef,
): MapperResult | null {
  switch (family) {
    case 'graph':
      return mergeSpans(graphNodeSpans(source, ref.text), graphEdgeSpans(source, ref.text))
    case 'sequence':
      return sequenceSpans(source, ref.text)
    case 'kanban':
      return kanbanSpans(source, ref.text)
    case 'state':
      return stateSpans(source, ref)
    case 'er':
      return erSpans(source, ref) ?? erAttributeSpans(source, ref)
    case 'class':
      return classSpans(source, ref)
    case 'git':
      return gitSpans(source, ref)
    case 'requirement':
      return requirementSpans(source, ref)
    case 'sankey':
      return sankeySpans(source, ref)
    case 'wardley':
      return wardleySpans(source, ref)
    case 'venn':
      return vennSpans(source, ref)
    case 'journey':
      return journeySpans(source, ref)
    default:
      return null
  }
}

/** Every standalone occurrence of the label anywhere in the source. */
function substringSpans(source: string, label: string): Span[] {
  const spans: Span[] = []
  for (let at = source.indexOf(label); at >= 0; at = source.indexOf(label, at + label.length)) {
    spans.push({ start: at, end: at + label.length })
  }
  return spans
}

/**
 * The label as the content of a quoted string — how treemap, packet, venn,
 * wardley and C4 spell their labels. Preferred over a bare occurrence, since
 * the same words may also appear as syntax or as another label.
 */
function quotedSpans(source: string, label: string): Span[] {
  const spans: Span[] = []
  const re = new RegExp(`(["'])${escapeRe(label)}\\1`, 'g')
  for (let match = re.exec(source); match; match = re.exec(source)) {
    const start = match.index + match[1].length
    spans.push({ start, end: start + label.length })
  }
  return spans
}

/**
 * Occurrences of the label with whitespace ignored, which is what a wrapped
 * label needs: mermaid splits "Lack of Training" across tspans, so the DOM reads
 * `Lack ofTraining` where the source reads `Lack of Training`. Matches that
 * would run across a line break are dropped, so a label cannot match a phrase
 * that merely ends one line and starts the next.
 */
function squeezedSpans(source: string, label: string): Span[] {
  const haystack = squeeze(source)
  const needle = squeeze(label).text
  const spans: Span[] = []
  if (!needle) return spans
  for (let at = haystack.text.indexOf(needle); at >= 0; at = haystack.text.indexOf(needle, at + needle.length)) {
    const start = haystack.at[at]
    const end = haystack.at[at + needle.length - 1] + 1
    if (lineAt(source, start) !== lineAt(source, end - 1)) continue
    spans.push({ start, end })
  }
  return spans
}

/** The text with whitespace dropped, plus where each kept character came from. */
function squeeze(text: string): { text: string; at: number[] } {
  const chars: string[] = []
  const at: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    chars.push(text[i])
    at.push(i)
  }
  return { text: chars.join(''), at }
}

const GENERIC_STRATEGIES: Array<(source: string, label: string) => Span[]> = [
  quotedSpans,
  substringSpans,
  squeezedSpans,
]

/** Source ranges a label maps to, or why it cannot be mapped. */
type Resolution = MapperResult | 'ambiguous' | null

/**
 * The source ranges a rendered label stands for: the family's own mapper where
 * there is one, else the first generic strategy that finds the label. A label
 * that resolves to more than one copy is narrowed to the copy that was clicked
 * when the diagram shows exactly as many copies as the source has, and is
 * otherwise reported as ambiguous.
 */
function resolveLabelSpans(
  source: string,
  family: DiagramFamily,
  ref: LabelRef,
): Resolution {
  const mapped = familyMapper(family, source, ref)
  if (mapped && mapped.spans.length > 0) return pickCopy(mapped, ref)
  for (const strategy of GENERIC_STRATEGIES) {
    const spans = strategy(source, ref.text)
    if (spans.length > 0) return pickCopy({ spans }, ref)
  }
  return null
}

function pickCopy(result: MapperResult, ref: LabelRef): Resolution {
  if (result.all || result.spans.length <= 1) return result
  // The DOM and the source list their copies in the same order, so the k-th of
  // n labels on screen is the k-th of n occurrences in the source.
  if (result.spans.length === ref.count) {
    return { spans: [result.spans[ref.occurrence]], render: result.render }
  }
  return 'ambiguous'
}

export type PatchOutcome =
  | { status: 'ok'; text: string }
  /** The label occurs more than once and no mapper can tell the copies apart. */
  | { status: 'ambiguous' }
  | { status: 'unmapped' }

/**
 * Resolve a label edit to a new mermaid source, or explain why it cannot be
 * applied. `ref` carries what the editor knew about the clicked label — whether
 * it names a thing, and which copy of a repeated label it was — so the ranges
 * found here are the ones that were resolved when the label was offered.
 */
export function patchLabel(
  source: string,
  family: DiagramFamily,
  oldLabel: string,
  newLabel: string,
  ref: Partial<LabelRef> = {},
): PatchOutcome {
  if (!oldLabel) return { status: 'unmapped' }
  const resolved = resolveLabelSpans(source, family, {
    role: 'text',
    occurrence: 0,
    count: 1,
    ...ref,
    text: oldLabel,
  })
  if (resolved === 'ambiguous') return { status: 'ambiguous' }
  if (resolved === null) return { status: 'unmapped' }
  const next = resolved.render?.(newLabel) ?? newLabel
  return { status: 'ok', text: replaceSpans(source, resolved.spans, next) }
}

function mergeSpans(...results: MapperResult[]): MapperResult {
  return { spans: results.flatMap((result) => result.spans).sort((a, b) => a.start - b.start) }
}

interface SourceLine {
  text: string
  offset: number
  comment: boolean
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let offset = 0
  for (const text of source.split('\n')) {
    lines.push({ text, offset, comment: text.trim().startsWith('%%') })
    offset += text.length + 1
  }
  return lines
}

// ── kanban line model ───────────────────────────────────────────────────────

export type KanbanLineKind = 'header' | 'column' | 'card' | 'comment' | 'blank'

export interface KanbanLine {
  /** The line without its indentation. */
  text: string
  indent: string
  /** Offset of the line's first character in the source. */
  offset: number
  kind: KanbanLineKind
  /** The text a column header or card shows, or `null` for an unknown shape. */
  label: string | null
  labelStart: number
  labelEnd: number
}

/** A node line whose column/card role depends on the first node's indent. */
type RawKanbanLine = KanbanLine | (Omit<KanbanLine, 'kind'> & { kind: 'pending' })

export interface KanbanCard {
  /** Index into `KanbanDoc.lines`. */
  line: number
  /** Index into `KanbanDoc.columns`, or -1 for a card with no column above it. */
  column: number
  /** Position of the card inside its column, top to bottom. */
  index: number
  label: string | null
  labelStart: number
  labelEnd: number
}

export interface KanbanDoc {
  lines: KanbanLine[]
  /** Line indices of the column headers, in source order. */
  columns: number[]
  cards: KanbanCard[]
}

const KANBAN_OPENERS: Record<string, string> = { '[': ']', '(': ')', '{': '}' }
const KANBAN_OPEN_CHARS = Object.keys(KANBAN_OPENERS).join('')
const KANBAN_METADATA = /\s*@\s*\{[^@]*\}\s*$/

/**
 * Where a column header or card shows its text inside the line: `id1[Label]`
 * and `[Label]` render as `Label`, a bare `id1` renders as itself, and trailing
 * `@{ … }` metadata is not part of the label. Shapes mermaid's kanban grammar
 * rejects (`id6>Ang Label]` renders whole) come back as `null` so they are
 * never patched blind.
 *
 * A *quoted* label is mermaid's own escape for text holding the shape
 * delimiters, and it draws the text inside the quotes and nothing else. The
 * span therefore covers the **whole quoted run, quotes included**, while the
 * label itself is the text inside them (`parseKanban` unquotes and unescapes,
 * so the label is what the board draws): a rename replaces the run, so
 * `kanbanInnerLabel` can quote a title that needs it and unquote one that no
 * longer does, without knowing which of the two it is looking at. Recognised
 * before the shape search, or a bare `"Fix (bug)"` finds its own `(` and gets
 * mapped to `bug`.
 */
function kanbanLabelSpan(body: string): Span | null {
  const metadata = KANBAN_METADATA.exec(body)
  const head = metadata ? body.slice(0, metadata.index) : body
  if (head.startsWith('"')) {
    return head.length > 1 && head.endsWith('"') ? { start: 0, end: head.length } : null
  }

  const open = head.search(new RegExp(`[${KANBAN_OPEN_CHARS}>]`))
  if (open < 0) return { start: 0, end: head.length }

  const opener = head[open]
  const closer = KANBAN_OPENERS[opener]
  if (closer === undefined) return null
  // `((Label))` and `[In Progress]`: the label is between the delimiter runs.
  const openRun = runForward(head, open, opener)
  const closeRun = runBackward(head, head.length - 1, closer)
  if (closeRun < openRun) return null
  const start = open + openRun
  const end = head.length - closeRun
  // `["Fix (bug)"]`: the quoted run ends before the closing `]`, so it is bounded
  // by the quote and not by the delimiter run. An unterminated quote is never
  // patched blind.
  if (head[start] === '"') {
    const close = head.indexOf('"', start + 1)
    return close < 0 || close > end ? null : { start, end: close + 1 }
  }
  return end < start ? null : { start, end }
}

/** A quoted label is drawn as the text inside its quotes, so that is the label. */
function unquoteKanbanLabel(text: string): string {
  const bare = text.length > 1 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
  return unescapeKanbanEntities(bare)
}

function runForward(text: string, from: number, char: string): number {
  let count = 0
  while (text[from + count] === char) count += 1
  return count
}

function runBackward(text: string, from: number, char: string): number {
  let count = 0
  while (text[from - count] === char) count += 1
  return count
}

/**
 * Kanban source as lines: the `kanban` header, column headers, cards, comments
 * and blank lines.
 *
 * Mermaid's kanban grammar is purely indentation based and whitespace agnostic:
 * a node's "level" is the *length* of its leading whitespace, the first node
 * sets the section level, and every later node at that same length opens a new
 * column while anything deeper is a card in the column above it. So
 * `  Todo` / `    id1[Card]`, `\tTodo` / `\t\tid1[Card]` and even
 * `Todo` / `  id1[Card]` are the same document.
 */
export function parseKanban(source: string): KanbanDoc {
  const lines = kanbanLines(source)
  const first = lines.find((line) => line.kind === 'pending')
  const sectionLevel = first ? first.indent.length : 0

  const columns: number[] = []
  const cards: KanbanCard[] = []
  const cardCounts: number[] = []
  const resolved: KanbanLine[] = []
  let column = -1

  for (const [index, raw] of lines.entries()) {
    if (raw.kind !== 'pending') {
      resolved.push(raw)
      continue
    }
    const body = raw.text.trim()
    const span = kanbanLabelSpan(body)
    // The label is relative to the trimmed body, so shift the absolute offset
    // past the indent and any space between the indent and the body.
    const start = raw.offset + raw.indent.length + (raw.text.length - body.length) + (span?.start ?? 0)
    const labelled = span ? body.slice(span.start, span.end) : null
    const line: KanbanLine = {
      text: raw.text,
      indent: raw.indent,
      offset: raw.offset,
      kind: 'card',
      // A quoted label is *drawn* as the text inside its quotes, so that is the
      // label — while the span keeps the run whole, for the rename to replace.
      label: labelled === null ? null : unquoteKanbanLabel(labelled),
      labelStart: span ? start : raw.labelStart,
      labelEnd: span ? start + labelled!.length : raw.labelEnd,
    }

    if (raw.indent.length === sectionLevel) {
      line.kind = 'column'
      columns.push(index)
      column = columns.length - 1
      cardCounts.push(0)
      resolved.push(line)
      continue
    }

    const count = column < 0 ? 0 : cardCounts[column]
    if (column >= 0) cardCounts[column] = count + 1
    cards.push({
      line: index,
      column,
      index: count,
      label: line.label,
      labelStart: line.labelStart,
      labelEnd: line.labelEnd,
    })
    resolved.push(line)
  }

  return { lines: resolved, columns, cards }
}

function kanbanLines(source: string): RawKanbanLine[] {
  const lines: RawKanbanLine[] = []
  let offset = 0
  let headerSeen = false
  for (const raw of source.split('\n')) {
    const indent = /^[ \t]*/.exec(raw)?.[0] ?? ''
    const text = raw.slice(indent.length)
    const content = text.trim()
    let kind: RawKanbanLine['kind']
    if (!content) kind = 'blank'
    else if (content.startsWith('%%')) kind = 'comment'
    else if (headerSeen) kind = 'pending'
    else {
      kind = 'header'
      headerSeen = true
    }
    lines.push({
      text,
      indent,
      offset,
      kind,
      label: null,
      labelStart: offset,
      labelEnd: offset,
    })
    offset += raw.length + 1
  }
  return lines
}

/**
 * Every line, indentation included, so a move only reorders lines: a card's own
 * indent already marks it as a card in any column, and preserving every other
 * line byte-for-byte keeps comments, blank lines and metadata exactly as typed.
 */
export function rebuildKanban(lines: KanbanLine[]): string {
  return lines.map((line) => line.indent + line.text).join('\n')
}

/**
 * Move a card to `index` inside `column`, deriving the insertion point from the
 * line model so comments, blank lines and `@{ … }` metadata stay where they
 * were. Returns `null` when the move changes nothing.
 */
export function moveKanbanCard(source: string, from: number, column: number, index: number): string | null {
  const doc = parseKanban(source)
  const card = doc.cards[from]
  const header = doc.columns[column]
  if (!card || header === undefined) return null

  const siblings = doc.cards.filter((entry) => entry.column === column && entry !== card)
  const at = Math.max(0, Math.min(index, siblings.length))
  if (column === card.column && at === card.index) return null

  const lines = doc.lines.slice()
  const [moved] = lines.splice(card.line, 1)
  // Everything the moved card used to precede has shifted down by one line.
  const shifted = (line: number): number => (line > card.line ? line - 1 : line)

  let insertAt: number
  if (siblings.length === 0) insertAt = shifted(header) + 1
  else if (at >= siblings.length) insertAt = shifted(siblings[at - 1].line) + 1
  else insertAt = shifted(siblings[at].line)

  lines.splice(insertAt, 0, moved)
  const text = rebuildKanban(lines)
  return text === source ? null : text
}

/**
 * Characters that make a kanban label worth quoting. A bracketed node is not
 * "everything up to the closing bracket": the delimiters are the *shape* syntax
 * mermaid reuses from flowcharts.
 *
 * The set is deliberately the whole shape syntax rather than the minimum, which
 * real mermaid (a 40-diagram sweep, one per character) turned out to be `]`,
 * `(`, `)` and `}` — `[`, `{`, `<` and a stray `>` all render bare. A superset
 * costs one pair of invisible quotes and buys two things a minimum cannot: an
 * unquoted label holding `@{ … }` is *silently eaten as metadata*, and one
 * holding `>` renders but our own mapper refuses it as a shape with no closer.
 * Both mean a title the user typed is not the title the board shows. Quoting
 * the shape syntax is the line that keeps the two in step.
 */
const KANBAN_QUOTE_CHARS = /[[\](){}@>"&]/

/**
 * The text to write *inside* a `[…]`'s delimiters. Mermaid's kanban grammar
 * takes a quoted label and draws it without the quotes, so `["Fix (bug)"]` is
 * the text `Fix (bug)` on the board and in the label editor — the quotes are a
 * source-level spelling detail, never part of what the user typed. One function
 * for all three writers (a new card, a new column, a rename) so a label cannot
 * be writable one way and not the other.
 */
function kanbanInnerLabel(text: string): string {
  return KANBAN_QUOTE_CHARS.test(text) ? kanbanQuotedLabel(text) : text
}

/** A label whose source already carries quotes keeps them across a rename. */
function kanbanQuotedLabel(text: string): string {
  return `"${escapeKanbanEntities(text)}"`
}

/**
 * Mermaid's own escape inside a label, which is what lets a double quote exist
 * on a board at all. A quoted label is drawn as the text inside its quotes, so
 * a `"` written raw would close the label the quote opened and the rest of the
 * title would be read as source: `["He said "hi" (loud)"]` is a parse error.
 * `&quot;` is not a quote to the grammar and survives the quoted run, and
 * mermaid draws it as `"` -- so `["He said &quot;hi&quot; (loud)"]` is the text
 * `He said "hi" (loud)`. `&` is escaped first, since a title holding the literal
 * text `&quot;` must come back as that text and not as a quote.
 */
function escapeKanbanEntities(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** The inverse of `escapeKanbanEntities`, so a label reads as what is drawn. */
function unescapeKanbanEntities(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

/**
 * What no quoting can carry: a line break is not text at all, and a title
 * spanning one cannot be a single card. Everything else mermaid refuses in a
 * bare label is quoted above, so the refusal is about the *representable*, not
 * the convenient — and a card is refused before it reaches the source, because
 * committing one that cannot render strands the board on its last good diagram
 * with the card the user just typed visible nowhere.
 */
const UNUSABLE_KANBAN_LABEL = /\n/

/** Whether `name` can be written as a kanban column header or card label. */
export function usableKanbanLabel(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && !UNUSABLE_KANBAN_LABEL.test(trimmed)
}

/**
 * Why `name` cannot be a kanban label, or `''` when it can. Names the rule the
 * user just hit, because "could not parse" says nothing about which of their own
 * keystrokes to take back.
 */
export function kanbanLabelRefusal(name: string): string {
  if (name.trim().length === 0) return 'A kanban label cannot be empty.'
  return 'A kanban label cannot span more than one line.'
}

/**
 * Insert a new card into `column` at `index` (among that column's cards), or
 * `null` when there is nothing to insert: no such column, an empty or unusable
 * label (see `usableKanbanLabel`), or a rebuild that would not change the
 * source. `null` is the caller's cue to flash `mermaid-edit-invalid` rather
 * than commit a no-op.
 *
 * The insertion point is `moveKanbanCard`'s, so a card lands in the same place
 * a drop would put it and comments, blank lines and `@{ … }` metadata keep
 * their position. Card identity here is purely positional — the label is the
 * only thing a new card brings, and every later edit re-derives the model from
 * the patched source.
 */
export function addKanbanCard(
  source: string,
  column: number,
  index: number,
  label: string,
): string | null {
  const doc = parseKanban(source)
  const header = doc.columns[column]
  const headerLine = header === undefined ? undefined : doc.lines[header]
  if (!headerLine || !usableKanbanLabel(label)) return null
  const text = label.trim()

  const siblings = doc.cards.filter((entry) => entry.column === column)
  const at = Math.max(0, Math.min(index, siblings.length))
  // Reusing an existing card's indent keeps a tab-indented or six-space board
  // consistent: one level deeper than the column would mix tabs and spaces.
  const model = siblings[0] ?? doc.cards[0]
  const indent = (model === undefined ? undefined : doc.lines[model.line]?.indent) ?? `${headerLine.indent}  `
  // The label is what the user typed; the body is how that label is spelled in
  // the source, which is the same thing for an ordinary title and a quoted one
  // for a title holding a delimiter.
  const inner = kanbanInnerLabel(text)
  // The span is the whole run between the delimiters — quotes included — so a
  // later rename re-spells it the same way this insert did.
  const start = indent.length + 1
  const card: KanbanLine = {
    text: `[${inner}]`,
    indent,
    offset: 0,
    kind: 'card',
    label: text,
    labelStart: start,
    labelEnd: start + inner.length,
  }

  const lines = doc.lines.slice()
  let insertAt: number
  if (siblings.length === 0) insertAt = header + 1
  else if (at >= siblings.length) insertAt = siblings[at - 1].line + 1
  else insertAt = siblings[at].line
  lines.splice(insertAt, 0, card)

  const next = rebuildKanban(lines)
  return next === source ? null : next
}

/**
 * A runnable kanban diagram for `columns`, or `''` when none of them is usable
 * (the caller reports that rather than inserting a board that cannot render).
  *
  * Headers are always emitted as `id[Name]`: a bare word renders too, but not a
  * name holding a delimiter, and the `id[Name]` shape is the one
  * `kanbanLabelSpan` maps, so every generated column is immediately renamable in
  * the editor. Ids are positional (`col1…`) and labels are de-duplicated with a
  * ` (2)` suffix, so a board asked for two `Doing` columns still renders. A name
  * holding a delimiter is quoted by `kanbanInnerLabel` exactly as a card's is,
  * which is what lets a column be called `Q3 (launch)`.
  */
export function buildKanbanSource(columns: string[], opts: { firstCard?: string } = {}): string {
  const names = columns.map((name) => name.trim()).filter(usableKanbanLabel)
  if (names.length === 0) return ''

  const seen = new Map<string, number>()
  const lines = names.map((name, index) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return `  col${index + 1}[${kanbanInnerLabel(count === 0 ? name : `${name} (${count + 1})`)}]`
  })
  // The seed card belongs to the first column, the one a board is read from.
  const firstCard = opts.firstCard?.trim() ?? ''
  if (usableKanbanLabel(firstCard)) lines.splice(1, 0, `    [${kanbanInnerLabel(firstCard)}]`)
  return ['kanban', ...lines].join('\n')
}

// ── the slots a board is drawn with in edit mode ─────────────────────────────
//
// A board is authored from the board, so the two places a card or a column can
// be added have to be *drawn*: mermaid lays out the slot the way it lays out the
// real thing, which is the whole point — a card slot is in the next card's own
// place rather than a bar laid over the one above it, and a column slot is a
// column, as wide and as tall as the real ones, so nothing about the board has
// to be positioned by hand and nothing about it can be laid over.
//
// A slot is therefore part of the *source the board is drawn from* and never part
// of the source that is committed: the document holds the board, and the slots
// are re-derived from it on every render. Every visual edit is patched against
// the drawn source and comes back through `kanbanRealSource`, which keeps a slot
// the user has typed a name for — that is the edit — and drops one that still
// says what it says.

/** What a column's next card says while it is still only a place to put one. */
export const KANBAN_CARD_SLOT = '+ Add a card'
/** What the next column says while it is still only a place to put one. */
export const KANBAN_COLUMN_SLOT = '+ Add a column'
// A reserved id, so a slot is recognisable by what it *is* rather than by what
// it says: a card the user has genuinely titled `+ Add a card` is a real card,
// and only the drawn slot carries an id nothing else on a board would.
const SLOT_ID = /^slot[cn]\d*$/
const isSlotId = (id: string): boolean => SLOT_ID.test(id)

/** Whether a line is one of the board's own slots, rather than content. */
function isKanbanSlotLine(line: KanbanLine): boolean {
  return line.kind !== 'blank' && isSlotId(kanbanNodeId(line.text))
}

/**
 * The source a board is *drawn* from in edit mode: `source` with a card slot at
 * the end of every column and a column slot at the end of the board. Anything
 * that is not a board is handed back untouched, so a diagram family that has no
 * slots is never touched by this.
 *
 * The card slot goes directly after the column's last card — where a new card
 * would land — and keeps that column's own card indent, so a board written with
 * tabs or six spaces is drawn the way it was written.
 *
 * The new column is drawn as a column like any other, and that includes a card
 * slot in it: it is a list, it is the size of one, and a card-shaped thing drawn
 * in it is what gives a card something to be dropped onto. (That card slot is
 * also the bin a card is dropped on to be deleted, so it cannot be a place to
 * add a card — the column it belongs to does not exist yet, and nothing can be
 * added to it. `onSlotClick` says so, and the whole press names the column.)
 */
export function kanbanAuthoringSource(source: string): string {
  // Only a board has columns to offer, and the line model is generous enough to
  // read one out of any indented node list — a flowchart's nodes are exactly that
  // shape, so the diagram itself has to say which of the two this is.
  if (detectDiagramType(source) !== 'kanban') return source
  const doc = parseKanban(source)
  const first = doc.columns[0]
  if (first === undefined) return source
  const columnIndent = doc.lines[first].indent
  const card = doc.cards.find((entry) => entry.column === 0)
  const cardIndent = doc.lines[card?.line ?? -1]?.indent ?? `${columnIndent}  `
  const cardSlot = (id: number): string => `${cardIndent}slotc${id}[${KANBAN_CARD_SLOT}]`
  const columnSlot = (): string => `${columnIndent}slotn[${KANBAN_COLUMN_SLOT}]`

  // Where each column's slot lines go: after the last thing that belongs to it.
  const after = new Map<number, string[]>()
  doc.columns.forEach((_header, column) => {
    const end = lastColumnLine(doc, column)
    // The board's own slot column is the last one, so the new column is drawn
    // after the last column's card slot — a board read left to right, ending in
    // the place the next one goes. It carries a card slot of its own, so it is
    // drawn as the column it is about to become rather than as a bare header, and
    // that slot's id is the next one along: the drawn column is not a column of
    // the document, so it has no index of its own to take.
    const lines = [cardSlot(column)]
    if (column === doc.columns.length - 1) {
      lines.push(columnSlot(), cardSlot(doc.columns.length))
    }
    after.set(end, [...(after.get(end) ?? []), ...lines])
  })

  const out: string[] = []
  doc.lines.forEach((line, index) => {
    out.push(line.indent + line.text)
    for (const slot of after.get(index) ?? []) out.push(slot)
  })
  return out.join('\n')
}

/**
 * The document's own source behind a board that was drawn with slots: a slot
 * that still carries its placeholder is a place and is dropped, and one the user
 * has typed a name for is content, so it is kept — rewritten to an ordinary
 * node, because a slot's reserved id is not something to commit to a document.
 *
 * Every visual edit comes through here, whichever affordance made it: a card
 * typed into a drawn slot, a column named where the next one was drawn, a card
 * dragged between columns, a label renamed. Only the slots that became content
 * are rewritten, a line whose label could not be read is passed through rather
 * than guessed at, and a new column is given an id nothing on the board already
 * uses (`freshKanbanId`) — it is a header like any other, and a duplicate id is
 * what ties a card to the wrong column.
 */
export function kanbanRealSource(patched: string): string {
  const doc = parseKanban(patched)
  if (!doc.lines.some(isKanbanSlotLine)) return patched
  const out: string[] = []
  for (const line of doc.lines) {
    if (isKanbanSlotLine(line)) {
      if (line.label === null) {
        out.push(line.indent + line.text)
        continue
      }
      // Still a placeholder: nothing was typed, so nothing is added.
      if (line.label === KANBAN_CARD_SLOT || line.label === KANBAN_COLUMN_SLOT) continue
      if (line.kind === 'column') {
        out.push(`${line.indent}${freshKanbanId(doc.lines)}[${kanbanInnerLabel(line.label)}]`)
      } else {
        out.push(`${line.indent}[${kanbanInnerLabel(line.label)}]`)
      }
      continue
    }
    out.push(line.indent + line.text)
  }
  return out.join('\n')
}

/**
 * Whether a card in the drawn model is one of the board's own slots, and so is
 * a place to add a card rather than a card to move or delete.
 */
function isKanbanCardSlot(card: KanbanCard, doc: KanbanDoc): boolean {
  return card.label === KANBAN_CARD_SLOT && isSlotId(kanbanNodeId(doc.lines[card.line].text))
}

/** Whether a column in the drawn model is the board's own slot column. */
function isKanbanColumnSlot(column: number, doc: KanbanDoc): boolean {
  const line = doc.lines[doc.columns[column]]
  return line !== undefined && isSlotId(kanbanNodeId(line.text))
}

/**
 * The board's drawn slots, as the elements the DOM walk found them in. A slot is
 * a card or a column of the drawn model — that is what makes mermaid lay it out
 * like one — so the walks that line the model up with the DOM find it there, and
 * this says which of the things they found is a place to add to rather than
 * content: not draggable, not deletable, and not something a drop may land in.
 */
export interface KanbanSlots {
  /** Every drawn card slot, in whichever column it stands. */
  cards: Set<SVGElement>
  /** The drawn column's index in the model, or `-1` for a board drawn without one. */
  column: number
  /**
   * The card slot *inside* that drawn column. It is the board's own bin: the
   * column it stands in is a place rather than a list, so nothing can be added
   * there, and while a card is in the air there is nothing that place would
   * rather be.
   */
  columnCard: SVGElement | null
}

function kanbanSlotElements(
  svg: SVGSVGElement,
  doc: KanbanDoc,
): KanbanSlots {
  const cards = cardElements(svg)
  const sections = sectionElements(svg)
  const slots = new Set<SVGElement>()
  const column = doc.columns.findIndex((_line, index) => isKanbanColumnSlot(index, doc))
  let columnCard: SVGElement | null = null
  doc.cards.forEach((card, index) => {
    const el = cards[index]
    if (el === undefined || !isKanbanCardSlot(card, doc)) return
    slots.add(el)
    if (card.column === column) columnCard = el
  })
  return { cards: slots, column: sections[column] === undefined ? -1 : column, columnCard }
}

/**
 * A node's own id, or `''` for a bare label (which *is* the id). The id is what
 * ties a card to the column above it, and it is the one thing a new column has
 * to bring: nothing in mermaid's kanban depends on the ids being consecutive or
 * ordered, so a fresh one is enough to insert a column anywhere on the board.
 */
function kanbanNodeId(text: string): string {
  return /^(\S*?)\s*(?:[[({>]|")/.exec(text)?.[1] ?? ''
}

/** An id nothing else on the board already uses, so a new column is its own. */
function freshKanbanId(lines: readonly KanbanLine[]): string {
  const taken = new Set(lines.map((line) => kanbanNodeId(line.text)).filter(Boolean))
  let n = 1
  while (taken.has(`col${n}`)) n += 1
  return `col${n}`
}

/** The last line belonging to `column`: its header, or the card below it. */
function lastColumnLine(doc: KanbanDoc, column: number): number {
  const cards = doc.cards.filter((card) => card.column === column)
  const last = cards.length === 0 ? -1 : cards[cards.length - 1].line
  return Math.max(doc.columns[column], last)
}

/**
 * The whole run of lines a column is made of: its header and everything down to
 * the next column header. `lastColumnLine` stops at the last *node*; this does
 * not, and the difference is the point — a comment or a blank line written
 * inside a column is part of that column, so a move takes it along and a board
 * with a blank line between two of its cards does not end up orphaning the
 * second one.
 */
function columnBlock(doc: KanbanDoc, column: number): { start: number; end: number } {
  const start = doc.columns[column]
  if (start === undefined) return { start: -1, end: -1 }
  let end = start
  for (let line = start + 1; line < doc.lines.length && doc.lines[line]!.kind !== 'column'; line += 1) {
    end = line
  }
  return { start, end }
}

/**
 * Remove a card, or `null` when there is no such card or the removal would not
 * change the source. Like every other edit here it drops a whole line, so a
 * comment or a blank line the user wrote around the card is left where it was,
 * and the delete is one transaction the editor can undo.
 */
export function removeKanbanCard(source: string, card: number): string | null {
  const doc = parseKanban(source)
  const entry = doc.cards[card]
  if (!entry) return null
  const lines = doc.lines.filter((_, index) => index !== entry.line)
  const next = rebuildKanban(lines)
  return next === source ? null : next
}

/**
 * Remove a column with every card in it, or `null` when there is no such column
 * or the removal would not change the source. A board keeps at least one column:
 * with none left there is no board left to show, so the last column is not
 * offered a delete in the first place and this refuses it too.
 */
export function removeKanbanColumn(source: string, column: number): string | null {
  const doc = parseKanban(source)
  const header = doc.columns[column]
  // A board keeps at least one column, and the slot column the board is drawn
  // with is a place rather than one: a board of one real column is still a board
  // of one, and emptying it would leave nothing for the new column to follow.
  if (header === undefined || realKanbanColumns(doc).length < 2) return null
  const doomed = new Set([header, ...doc.cards.filter((card) => card.column === column).map((card) => card.line)])
  const lines = doc.lines.filter((_, index) => !doomed.has(index))
  const next = rebuildKanban(lines)
  return next === source ? null : next
}

/** How many cards a column delete would take with it, for the prompt to say. */
export function kanbanColumnCardCount(source: string, column: number): number {
  const doc = parseKanban(source)
  return doc.cards.filter((card) => card.column === column && !isKanbanCardSlot(card, doc)).length
}

/** The columns a board really has: a drawn slot is a place to add one, not one. */
function realKanbanColumns(doc: KanbanDoc): number[] {
  return doc.columns.filter((_line, index) => !isKanbanColumnSlot(index, doc))
}

/** How many columns a board has, not counting the slot it is drawn with. */
export function kanbanColumnCount(source: string): number {
  return realKanbanColumns(parseKanban(source)).length
}

/**
 * Move the column at `from` so it ends up at `to` among the board's columns, or
 * `null` when there is no such column or the move would not change the source.
 *
 * A column travels as a whole block — its header, its cards and anything written
 * inside it (`columnBlock`) — because the grammar is indentation based: a card is
 * only a card by being indented under the header above it, so leaving a card
 * behind would silently turn it into a column of its own. Nothing else moves,
 * which is what keeps a comment above the column where the user put it.
 *
 * The insertion point is the same kind of arithmetic `addKanbanColumn` does, from
 * the other side: before the target column's header, or after the target's own
 * block. A move rewrites no line's text, so ids, quoting and indentation are all
 * preserved exactly — a reordered board is the same board read in a new order.
 */
export function moveKanbanColumn(source: string, from: number, to: number): string | null {
  const doc = parseKanban(source)
  const block = columnBlock(doc, from)
  if (block.start < 0 || doc.columns.length < 2) return null
  const position = Math.max(0, Math.min(to, doc.columns.length - 1))
  if (position === from) return null

  const lines = doc.lines.slice()
  const moved = lines.splice(block.start, block.end - block.start + 1)
  // Everything after the lifted block has moved up by its length, so the target
  // is addressed after the removal rather than before it.
  const shift = moved.length
  const shifted = (line: number): number => (line > block.end ? line - shift : line)

  let insertAt: number
  if (position < from) insertAt = doc.columns[position]!
  else insertAt = shifted(columnBlock(doc, position).end) + 1
  lines.splice(insertAt, 0, ...moved)

  const next = rebuildKanban(lines)
  return next === source ? null : next
}

// ── rendering ──────────────────────────────────────────────────────────────

export interface MermaidDiagramOptions {
  /** The `.mermaid` block that owns the preview and the overlays. */
  host: HTMLElement
  /**
   * Called with the patched source; the node view turns it into a transaction.
   * Supplying it puts the diagram in *edit mode*: the editing layer is
   * attached and the vector is deliberately left unbaked, so every label —
   * including the native `<text>` ones a baked bitmap would hide — is live and
   * clickable. Without it the diagram is a read-only preview and bakes as
   * usual.
   */
  commit?: (source: string) => void
}

/**
 * Render `code` into `container` and, in edit mode, wire up visual editing.
 *
 * The render goes through the block's `DiagramSession`, which is what makes it
 * safe to call from three places at once: it hands out a ticket and writes
 * nothing if a newer render has been asked for since, it owns the source every
 * patch is computed from, and it keeps an open field alive across the wholesale
 * DOM replacement this does.
 *
 * Success replaces the container's contents wholesale (the editing layer is
 * re-attached); failure leaves the last good diagram in place behind a
 * transient notice, unless there is no diagram yet — then an error block stands
 * in for it. A failure in edit mode records the refused source rather than the
 * one on screen, so the *next* edit is made against the document rather than
 * against the board that is about to be replaced: a patch made from the stale
 * one would carry on as if the refused edit had never happened, and commit a
 * board without it.
 */
export async function renderDiagram(
  container: HTMLElement,
  code: string,
  options: MermaidDiagramOptions,
): Promise<void> {
  const { host, commit } = options
  const session = sessionFor(host, commit ?? noop)
  session.bind(commit, container)
  const ticket = session.beginRender()
  const hadDiagram = container.querySelector('svg') !== null
  if (!hadDiagram) container.textContent = code
  try {
    const mermaid = await loadMermaid()
    const { svg } = await mermaid.render(`mermaid-diagram-${renderSeed++}`, code)
    // Overtaken: a newer render was asked for while this one was waiting on
    // mermaid, so this one is a snapshot of a board the document has moved past.
    if (!session.isCurrent(ticket)) return
    // A preview is not an editing block: a render without a commit handler *is* the
    // block having stopped being editable — leaving edit mode is the only thing
    // that produces one — so the layer and its controls go with it, and a field
    // in progress is accepted rather than dropped, because the render is there
    // because the user finished the diagram and a half-typed label is an edit they
    // made.
    //
    // The overlays are children of the preview rather than of the drawing this is
    // about to replace, so they come down first. Which may itself commit — and a
    // commit is a document change and therefore a newer render, which is the
    // second check: this one is now a snapshot of a board that has already moved
    // on, and the newer one will draw it.
    if (!commit) session.setEditing(false, true)
    if (!session.isCurrent(ticket)) return
    container.innerHTML = svg
    const svgEl = container.querySelector<SVGSVGElement>('svg')
    if (!svgEl) return
    const natural = responsifySvg(svgEl)
    adaptDiagramColors(svgEl)
    pinSvgTextColors(svgEl)
    // A baked diagram is a bitmap under an invisible vector, which would put
    // every native label out of reach while editing, so edit mode keeps the
    // live SVG on top instead.
    if (!commit) void bakeDiagram(host, svgEl, natural)
    if (commit) attachEditingLayer(session, svgEl, code)
  } catch (error) {
    if (!session.isCurrent(ticket)) return
    const message = error instanceof Error ? error.message : String(error)
    if (hadDiagram) {
      session.noteSource(code)
      session.notice(NOTICE_TEXT, message)
    } else {
      container.innerHTML = ''
      container.appendChild(errorBlock(message))
    }
  }
}

const noop = (): void => undefined

// ── what one render of a diagram holds ─────────────────────────────────────

/**
 * Everything the editing layer needs to know about a render, collected once.
 *
 * Every feature used to walk the drawing and parse the source for itself, so
 * "what is on this board" had one answer per feature and they agreed only
 * because they happened to agree. One walk, one parse: the slots, the cards and
 * the columns are the same objects the drag moves, the chrome labels and the
 * field re-anchors to.
 */
function buildScope(svg: SVGSVGElement, source: string, family: DiagramFamily): RenderScope {
  const doc = family === 'kanban' ? parseKanban(source) : null
  const cards = family === 'kanban' ? cardElements(svg) : []
  const sections = family === 'kanban' ? sectionElements(svg) : []
  const slots = doc === null ? null : kanbanSlotElements(svg, doc)
  let labels = labelTargets(svg, family, source)
  // A drawn slot is a place to add rather than a thing to re-title. A card's is
  // not even a label target — the chrome opens a wrapping composer for the slot
  // instead, so a card is written rather than renamed — while a column's *is*
  // one, because a column's name is a label like any other and the slot is named
  // by the very editor that renames it.
  if (slots !== null) {
    labels = labels.filter((target) => {
      const node = target.el.closest('g.node')
      return node === null || !slots.cards.has(node as SVGElement)
    })
  }
  return {
    svg,
    source,
    cards,
    sections,
    slots,
    model: doc,
    labels,
    targets: labels.map((target) => target.el),
  }
}

/**
 * The editing layer of one render. Everything it builds is *render-scoped* — a
 * listener on the preview, the classes on this render's labels, the board's own
 * controls — and is registered on the session, which takes all of it down before
 * the next render and again when the block stops being editable. The one thing
 * that is not render-scoped is an open field, which re-anchors instead.
 */
function attachEditingLayer(session: DiagramSession, svg: SVGSVGElement, source: string): void {
  const container = session.preview
  const family = diagramFamily(detectDiagramType(source))
  const scope = buildScope(svg, source, family)
  session.reset()
  session.adopt(scope)
  session.setEditing(true)

  const targets = labelsOf(scope)
  for (const target of targets) target.el.classList.add(EDITABLE_CLASS)
  session.onRender(() => {
    for (const target of targets) target.el.classList.remove(EDITABLE_CLASS)
  })

  // Diagram glyphs are never natively draggable, and a press on a label must not
  // start a ProseMirror node selection underneath the click. `mousedown` rather
  // than `pointerdown`: canceling the pointer event would also suppress the
  // `click` the editor opens from.
  session.listen(container, 'dragstart', (event) => event.preventDefault())
  session.listen(container, 'mousedown', ((event: MouseEvent) => {
    if (event.button !== 0) return
    // A press on the text being edited is the caret's own business — canceling
    // it would swallow the caret placement and the blur.
    const open = session.openSubject
    if (open !== null) {
      const hit = labelTargetAt(event, targets)
      if (hit !== null && (open.contains(hit.el) || hit.el.contains(open))) return
      if (open.contains(event.target as Node)) return
    }
    if (!labelTargetAt(event, targets) && cardAt(event, scope.cards) === null) return
    event.preventDefault()
    event.stopPropagation()
  }) as EventListener)

  // One click handler for every label on the diagram, whatever kind of thing it
  // is: a flow node, an edge label, a sequence participant, a card title, a
  // column's name, or the name of a column the board is drawn with but does not
  // have yet. Only the *box* the field stands in differs — over a card rather
  // than over its text — so only that is asked for here.
  session.listen(container, 'click', ((event: MouseEvent) => {
    if (event.button !== 0) return
    const target = labelTargetAt(event, targets)
    if (!target) return
    const open = session.openSubject
    if (open !== null && (open.contains(target.el) || target.el.contains(open))) return
    const index = targets.indexOf(target)
    const card = target.el.closest('.items > .node')
    const cardIndex = card === null ? -1 : scope.cards.indexOf(card as SVGElement)
    if (cardIndex >= 0) {
      editCardTitle(session, cardIndex, false)
      return
    }
    // A column's name is one line in its band, whether the column is drawn at the
    // end of the board and has none yet or has a name already — so a press on its
    // header and a press on the band around it open the same field, because a
    // band is card-tall and its label says where a name goes rather than what the
    // name is.
    const band = sectionOf(target.el)
    if (band !== null) {
      editColumnName(session, index, band)
      return
    }
    editLabel(session, { index })
  }) as EventListener)

  if (family === 'kanban') {
    session.onRender(attachKanbanDrag(session, scope))
    session.onRender(attachKanbanChrome(session, scope))
  }
  session.watch()
  session.reanchor()
}

/** The labels a render offered, as the mapper's own records. */
function labelsOf(scope: RenderScope | null): LabelTarget[] {
  return (scope?.labels ?? []) as LabelTarget[]
}

/** The label at `index` of the render on screen, as the mapper's own record. */
function labelAt(session: DiagramSession, index: number): LabelTarget | undefined {
  return labelsOf(session.scope)[index]
}

/** Where the label at `index` sits among the render's labels. */
function indexOfLabel(scope: RenderScope, label: Element | null): number {
  return label === null ? -1 : scope.targets.indexOf(label)
}

/**
 * Take a diagram out of edit mode: the layer and the board's controls go, and a
 * field in progress is accepted unless told otherwise. The session itself lives
 * on — it is what orders the renders either side of the change — so this is
 * repeatable, and a diagram that goes back into edit mode picks up a fresh layer
 * rather than a new identity.
 */
export function finishMermaidLabelEditing(block: Node | null | undefined, accept = true): void {
  stopEditing(block, accept)
}

/**
 * Make a rendered diagram editable, for a caller that already has the drawing in
 * hand. `renderDiagram` does this on its own for a render with a commit handler;
 * it is exported because a caller can build a layer over a drawing it rendered
 * itself, and because a test does.
 */
export function attachMermaidEditing(
  container: HTMLElement,
  svg: SVGSVGElement,
  source: string,
  commit: (source: string) => void,
): void {
  const host = container.closest<HTMLElement>('.mermaid') ?? container.parentElement ?? container
  const session = sessionFor(host, commit)
  session.bind(commit, container)
  attachEditingLayer(session, svg, source)
}

/** The box a field stands in when nothing has a better one to offer: the label's own. */
function boxFor(el: Element): DOMRect {
  return el.getBoundingClientRect()
}

/**
 * The box a field that *adds* a column's name stands in: the whole band, at one
 * line. The band is card-tall (that is what gives it somewhere to add) and its
 * label is a placeholder rather than a name, so the field stands where the column
 * will stand rather than over the words drawn on it — and a column's name is a
 * single line, the growing composer being for a card title.
 */
function bandBox(band: Element): () => DOMRect {
  return () => {
    const at = band.getBoundingClientRect()
    return new DOMRect(at.left, at.top, at.width, COMPOSER_HEIGHT)
  }
}

/**
 * The label under the pointer. The direct DOM hit is preferred, but a diagram
 * shown as a baked bitmap (dark-mode native text, see `bakeDiagram`) puts an
 * `<img>` over the vector, so fall back to hit-testing the label rects — which
 * keeps working because the hidden SVG still has layout.
 */
function labelTargetAt(event: MouseEvent, targets: LabelTarget[]): LabelTarget | null {
  const el = event.target
  if (el instanceof Element) {
    const direct = el.closest(`.${EDITABLE_CLASS}`)
    if (direct) {
      const hit = targets.find((target) => target.el === direct)
      if (hit) return hit
    }
  }
  return hitTest(event, targets, (target) => target.el.getBoundingClientRect())
}

/**
 * The smallest candidate under the pointer. Smallest-wins so that a node's own
 * label beats the diagram-wide label it is nested in, whichever DOM shape
 * mermaid chose for the diagram.
 */
function hitTest<T>(
  event: MouseEvent,
  candidates: T[],
  rectOf: (candidate: T) => DOMRect,
): T | null {
  let best: T | null = null
  let bestArea = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const rect = rectOf(candidate)
    if (!contains(rect, event.clientX, event.clientY)) continue
    const area = rect.width * rect.height
    if (area < bestArea) {
      best = candidate
      bestArea = area
    }
  }
  return best
}

function contains(rect: DOMRect, x: number, y: number): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

// ── what a field is anchored to ─────────────────────────────────────────────

/**
 * A label, addressed by what it *is* rather than by the element it happens to be
 * this time.
 *
 * A position is not an address: a render can drop a label that came *before* this
 * one — a card deleted, a diagram changed — and the same index would then point at
 * whatever moved into it, so a rename would land on the wrong thing or the field
 * would carry on over a label the user never chose. So the index is a starting
 * point and the identity decides: the label's own text, and which copy of a
 * repeated text it is, which is exactly the pair that tells two identical labels
 * apart.
 *
 * `boxOf` is the only thing that varies between the labels on a board, and it is
 * the only thing that varies between them: the name of a column the board is
 * drawn with stands in the band rather than on the placeholder drawn in it.
 */
function labelSubject(session: DiagramSession, index: number, boxOf: (el: Element) => DOMRect): EditSubject {
  const ref = labelAt(session, index)
  return {
    locate: (render) => {
      if (render === null || ref === undefined) return null
      const labels = render.labels as LabelTarget[]
      const at = sameLabel(labels[index], ref)
        ? index
        : labels.findIndex((label) => sameLabel(label, ref))
      return at < 0 ? null : (render.targets[at] ?? null)
    },
    box: boxOf,
    // The label being replaced stops being drawn, so it cannot read through the
    // field that is replacing it.
    enter: (el) => hide(el),
    leave: (el) => reveal(el),
  }
}

/** Whether two of a render's labels are the same label, repeats included. */
function sameLabel(label: LabelTarget | undefined, ref: LabelRef): boolean {
  return label !== undefined && label.text === ref.text && label.occurrence === ref.occurrence
}

function hide(el: Element): void {
  ;(el as HTMLElement).style.visibility = 'hidden'
}

function reveal(el: Element): void {
  ;(el as HTMLElement).style.visibility = ''
}

/**
 * A card, addressed by where it sits in the render's card list. A card is not in
 * the target list at all when it is one of the board's drawn slots — a slot is a
 * place to put a card rather than a card to re-title — so this addresses the
 * drawn cards directly and serves both a card being retyped and a slot being
 * given a title.
 *
 * It also grows the card while a title is being written into it, because a card
 * is sized for a card and a title is not one: a composer that stopped at the
 * card's own height would show the first two lines of a five-line title and cover
 * the columns behind it with the rest. The height is remembered when the field
 * takes the card over and put back when it gives it up, so a card is its own size
 * again whatever the edit turned out to be — and whatever renders happened in
 * between, since a re-anchored card is remembered afresh.
 */
function cardSubject(card: number): EditSubject {
  const heights = new WeakMap<Element, { rect: SVGRectElement; frame: SVGForeignObjectElement | null; at: number }>()
  const own = (el: Element): HTMLElement | null => labelElementIn(el) as HTMLElement | null
  return {
    locate: (render) => render?.cards[card] ?? null,
    box: (el) => el.getBoundingClientRect(),
    enter: (el) => {
      // By local name rather than by constructor: jsdom does not expose the SVG
      // element classes as globals, and what a card's frame *is* is a name
      // mermaid gave it rather than anything to do with which realm it came from.
      const rect = el.querySelector<SVGRectElement>('rect')
      const frame = el.querySelector<SVGForeignObjectElement>('foreignObject')
      if (rect !== null) {
        heights.set(el, {
          rect,
          frame,
          at: Number(rect.getAttribute('height')) || rect.getBoundingClientRect().height,
        })
      }
      el.classList.add('mermaid-node-editing')
      const shown = own(el)
      if (shown !== null) hide(shown)
    },
    leave: (el) => {
      el.classList.remove('mermaid-node-editing')
      const was = heights.get(el)
      if (was !== undefined) {
        was.rect.setAttribute('height', String(was.at))
        was.frame?.setAttribute('height', String(was.at))
      }
      const shown = own(el)
      if (shown !== null) reveal(shown)
    },
    grow: (el, input) => {
      const was = heights.get(el)
      if (was === undefined) return
      const at = Math.ceil(input.scrollHeight) + 8
      if (at <= was.at) return
      was.rect.setAttribute('height', String(at))
      was.frame?.setAttribute('height', String(at))
    },
  }
}

/**
 * Re-type a label, in one line. One edit for every label on every diagram that is
 * not a card: a flow node, an edge, a sequence participant, a state, an ER
 * attribute, and a column's name — which is also the name of a column the board
 * is drawn with but does not have yet, because naming the drawn column rewrites
 * the placeholder it is drawn with and `kanbanRealSource` turns *that* into a
 * header of its own.
 *
 * One line, whatever the family. What decides a field's shape is *what kind of
 * thing the label names*, not which diagram it is on: a card's title is written
 * rather than replaced and is usually longer than the card it sits in, so it gets
 * the wrapping composer that grows with it (`editCardTitle`); a column's name is
 * one line whatever the column, so it gets one line. A field that grows for a
 * name that cannot wrap is the same class of bug as a card composer that grows
 * without the text, with less of it — and a board whose *new* columns are typed
 * into a band-wide line must not have its existing ones retyped into something
 * else, or the two drift apart the moment either changes.
 *
 * The mapper is resolved when the value is accepted rather than when the field
 * opened, from the label the field is standing in *now*: a render in between may
 * have re-ordered the diagram, and patching against a label that has since been
 * replaced by a different one is how an edit lands on the wrong thing.
 */
function editLabel(
  session: DiagramSession,
  options: {
    index: number
    /** The box the field stands in. Defaults to the label's own. */
    box?: (el: Element) => DOMRect
    /** A floor for a box too narrow to type a name into. */
    minWidth?: number
    /** Set when the field *adds* a name, which is also what makes it empty. */
    placeholder?: string
  },
): void {
  const { index } = options
  const adds = options.placeholder !== undefined
  session.openField({
    subject: labelSubject(session, index, options.box ?? boxFor),
    // A rename holds the name it is replacing, selected, so typing replaces it. A
    // field that adds holds nothing, and says what it is for instead.
    value: adds ? '' : (spellingOf(labelAt(session, index)) ?? ''),
    placeholder: options.placeholder,
    tone: adds ? 'new' : 'label',
    // A card's own box is sized for the card, so a short label would otherwise be
    // retyped in a field too narrow to see it in. A band is sized for the board,
    // so it is wide enough on its own and needs no floor.
    minWidth: options.minWidth ?? RENAME_FIELD_WIDTH,
    onAccept: (value) => commitRename(session, index, value),
  })
}

/**
 * A column's name, in its band at one line: the drawn column at the end of the
 * board, which is being named, and a column that has a name already, which is
 * being re-typed. One field for both, so the two cannot drift apart — the same
 * edit on the same thing, from a press on the name and from a press on the band
 * around it and from the `⋯` menu, which all land here.
 */
function editColumnName(session: DiagramSession, index: number, band: Element): void {
  editLabel(session, {
    index,
    box: bandBox(band),
    minWidth: 0,
    placeholder: band.classList.contains(COLUMN_SLOT_CLASS) ? 'Column name' : undefined,
  })
}

/** The band a label is drawn in, on a board, or `null` off one. */
function sectionOf(label: Element): Element | null {
  return label.closest('.sections > g')
}

/**
 * A card's title, over the card itself rather than over its text: a wrapping
 * composer that stands where the card is drawn, so the font, the padding and the
 * wrapping are the card's by construction and nothing jumps when editing starts.
 * Enter commits, Esc restores, blur commits, and a finish from outside — another
 * editor, Done, the diagram going away — resolves through the same one path every
 * other edit does.
 *
 * `fresh` is the same thing for the card the board is *drawn* with: the composer
 * opens empty over the slot, and a title typed into it becomes a card in the
 * column the slot stands in.
 */
function editCardTitle(session: DiagramSession, card: number, fresh: boolean): void {
  session.openField({
    subject: cardSubject(card),
    value: fresh ? '' : (spellingOf(cardLabelAt(session, card)) ?? ''),
    placeholder: fresh ? 'Card title' : undefined,
    tone: fresh ? 'new' : 'label',
    multiline: true,
    minWidth: 0,
    onAccept: (value) =>
      fresh ? commitNewCard(session, card, value) : commitRename(session, cardIndexOfCard(session, card), value),
  })
}

/** What the source spells a label as, which is not always what is drawn. */
function spellingOf(target: LabelTarget | undefined): string | null {
  return target === undefined ? null : (target.sourceText ?? target.text)
}

/** The diagram family of a render, which decides which mapper a rename uses. */
function familyOf(scope: RenderScope | null): DiagramFamily {
  return diagramFamily(detectDiagramType(scope?.source ?? ''))
}

/** The mapper's record of the label the drawn card at `card` carries. */
function cardLabelAt(session: DiagramSession, card: number): LabelTarget | undefined {
  const scope = session.scope
  if (scope === null) return undefined
  return labelAt(session, indexOfLabel(scope, labelElementIn(scope.cards[card] ?? null)))
}

/** Where the drawn card at `card` sits among the render's offered labels. */
function cardIndexOfCard(session: DiagramSession, card: number): number {
  const scope = session.scope
  if (scope === null) return -1
  return indexOfLabel(scope, labelElementIn(scope.cards[card] ?? null))
}

/**
 * Retype the label at `index`. The value is compared against the *source's* own
 * spelling of it rather than against what is on screen: a title the grammar has
 * to quote reads back on the board without its quotes, and a requirement row is
 * drawn under mermaid's own idea of the key, so the drawn text and the text a
 * patch replaces are not always the same string — and an unchanged value is a
 * cancel either way.
 */
function commitRename(session: DiagramSession, index: number, value: string): boolean | string {
  const target = labelAt(session, index)
  if (target === undefined) return true
  if (value === spellingOf(target)) return true
  const family = familyOf(session.scope)
  // A title the grammar cannot write at all is refused here rather than
  // committed: the patch would land, mermaid would refuse the source, and the
  // board would sit on its last good render with the title the user just typed
  // on no screen anywhere.
  if (family === 'kanban' && !usableKanbanLabel(value)) return kanbanLabelRefusal(value)
  const outcome = patchLabel(session.source, family, target.text, value, target)
  if (outcome.status !== 'ok') return outcome.status === 'ambiguous'
  session.patch(() => outcome.text)
  return true
}

/**
 * Give the card drawn at `card` a title.
 *
 * The slot is found again by its reserved id rather than by its index, and the
 * column and the place are read from the source as it is *when the title is
 * accepted*: the drawing the press landed in can be a render behind the document
 * — a commit made a moment ago has not come back through a render yet — and an
 * index read off the older drawing would put the card in the wrong column, or the
 * wrong gap in the right one. An id is the same id in every drawing of the same
 * board, so the slot stands for itself and the card lands where it was pressed,
 * leaving the slot as the place the next card would go.
 */
function commitNewCard(session: DiagramSession, card: number, value: string): boolean | string {
  const scope = session.scope
  const drawn = scope?.model as KanbanDoc | null
  if (scope === null || drawn === null) return true
  if (value.trim() === '') return true
  if (!usableKanbanLabel(value)) return kanbanLabelRefusal(value)
  const line = drawn.lines[drawn.cards[card]?.line ?? -1]
  const id = line === undefined ? '' : kanbanNodeId(line.text)
  if (!isSlotId(id)) return true
  return session.patch((source) => {
    const doc = parseKanban(source)
    const slot = doc.cards.find((entry) => kanbanNodeId(doc.lines[entry.line]!.text) === id)
    if (slot === undefined) return null
    const column = slot.column
    return addKanbanCard(source, column, doc.cards.filter((entry) => entry.column === column).indexOf(slot), value)
  })
}

// ── kanban drag ────────────────────────────────────────────────────────────

// ── kanban drag ────────────────────────────────────────────────────────────

/**
 * Drag a card into another column, or to another spot in its own. Cards are
 * laid out in source order, so a card's index in the DOM is its index in
 * `parseKanban`'s card list — no reliance on mermaid's sanitised element ids.
 *
 * The gesture arms on press and starts on the first movement past
 * `DRAG_THRESHOLD`, so a press-and-release on a card title still reaches the
 * title editor, and nothing is canceled on the press itself (canceling the
 * pointer press would take the `click` with it).
 *
 * An armed drag is a *phase*, so it is the session's to end: a render replaces
 * the drawing a drag is measured against and takes the window listeners with it,
 * and a drag that survived a render would go on moving elements the render threw
 * away and commit a move computed from the board that render replaced.
 */
function attachKanbanDrag(session: DiagramSession, scope: RenderScope): () => void {
  const { cards, sections, slots } = scope
  const doc = scope.model as KanbanDoc
  // A model that does not line up with the DOM would mis-attribute the move.
  if (doc.cards.length !== cards.length || doc.columns.length !== sections.length) return () => undefined

  const onPointerDown = (event: Event): void => {
    const down = event as PointerEvent
    if (down.button !== 0) return
    // A press on a card whose title is being edited is the caret's, not a drag.
    if (session.hasField) return
    // A card wins over the column it sits in: the cards are a layer of their own,
    // painted above the frames, so a press that landed on one means the card.
    const card = cardAt(down, cards)
    const slotColumn = slots?.column ?? -1
    const dragged: ArmedDrag = { session, scope, from: -1, down }
    if (card !== null) {
      // A drawn slot is a place, not a card: pressing one asks for a title
      // rather than lifting anything, and it falls through to nothing so the
      // column it stands in is not dragged instead.
      if (slots?.cards.has(card)) return
      dragged.from = cards.indexOf(card)
      armCardDrag(dragged, kanbanTrash(dragged))
      return
    }
    const column = columnAt(down, sections, cards)
    if (column >= 0 && column !== slotColumn) {
      dragged.from = column
      armColumnDrag(dragged)
    }
  }
  // Cancelling dragstart keeps the browser's own SVG drag (which swallows the
  // pointer stream) from ever starting; preventing pointerdown instead would also
  // kill the click that opens a card's title editor.
  const onDragStart = (event: Event): void => event.preventDefault()
  const preview = session.preview
  session.listen(preview, 'pointerdown', onPointerDown as EventListener)
  session.listen(preview, 'dragstart', onDragStart)
  return () => undefined
}

/**
 * A press that may turn into a drag: what was pressed, and where the pointer
 * started. Everything else — the board, the model, the source — is read from the
 * session, so an armed drag cannot be holding a snapshot the document has since
 * moved past.
 */
interface ArmedDrag {
  session: DiagramSession
  scope: RenderScope
  /** The card's index for a card drag, the column's for a column drag. */
  from: number
  down: PointerEvent
}

/**
 * The section a release would land in, or `null` for the drawn slot column: it
 * is a place to *name*, not a column to put anything in, so nothing is offered
 * over it and a release there does nothing.
 */
function liveHit(event: PointerEvent, sections: SVGElement[], slotColumn: number): SVGElement | null {
  const target = hitTest(event, sections, sectionRect)
  return target !== null && sections.indexOf(target) === slotColumn ? null : target
}

/** How a lift is driven: where the pointer is over, and what a release does. */
interface DragHooks {
  /** The element the pointer is over, marked as the drop target. */
  highlight: (event: PointerEvent) => SVGElement | null
  /**
   * Where the line goes, which is the only part of a drag the user can see, in
   * viewport coordinates — the drawing's own units are this group's business.
   * `null` promises nothing: there is nowhere to land.
   */
  place: (event: PointerEvent, target: SVGElement | null) => { x1: number; y1: number; x2: number; y2: number } | null
  /** The commit, once the release has been acted on. */
  drop: (event: PointerEvent, target: SVGElement | null, moved: boolean) => void
  /** Once the press has become a drag, which is not the press itself. */
  begin?: () => void
  /** However the drag ended, which is the only moment a drag-only thing goes. */
  end?: () => void
}

function cardAt(event: MouseEvent, cards: SVGElement[]): SVGElement | null {
  return drawnElementAt(event, '.items > .node', cards)
}

/**
 * The drawn element a press or click landed in, and one rule for both: the
 * element the pointer is *on* first, then the coordinates. A card or a slot is
 * part of the diagram rather than a control on top of it, so the pointer can be
 * over its label, its box or its background, and an element's own box alone
 * answers only for the part of it that is the card.
 */
function drawnElementAt(event: MouseEvent, selector: string, candidates: SVGElement[]): SVGElement | null {
  const el = event.target
  if (el instanceof Element) {
    const direct = el.closest<SVGElement>(selector)
    if (direct && candidates.includes(direct)) return direct
  }
  return hitTest(event, candidates, (candidate) => candidate.getBoundingClientRect())
}

/**
 * The column a press that missed every card belongs to — the column's own frame,
 * which is the only part of a list that is not one of its cards. A press on the
 * header label is none of its business (that is a rename, and the label editor
 * opens on the click), so a list is grabbed by the frame around its name, which
 * is also where a hand goes for a whole list. `-1` when the press is not a grab.
 */
function columnAt(event: MouseEvent, sections: SVGElement[], cards: SVGElement[]): number {
  if (hitTest(event, cards, (card) => card.getBoundingClientRect()) !== null) return -1
  const el = event.target
  if (el instanceof Element) {
    if (el.closest('.cluster-label') || el.closest('.cluster-title')) return -1
    const direct = el.closest<SVGElement>('.sections > g')
    if (direct) {
      const index = sections.indexOf(direct)
      return index < 0 ? -1 : index
    }
  }
  // The coordinate fallback for a diagram shown as a baked bitmap, where the
  // press lands on an `<img>` rather than on the section: one whose own label is
  // under the pointer is still a rename and not a grab.
  const hit = hitTest(event, sections, sectionRect)
  if (hit === null) return -1
  const label = hit.querySelector('.cluster-label, .cluster-title')
  if (label && contains(label.getBoundingClientRect(), event.clientX, event.clientY)) return -1
  return sections.indexOf(hit)
}

/**
 * Lift `elements` and have them follow the pointer, then put every one of them
 * back exactly as it was.
 *
 * What moves *is* the thing: no clone, no ghost, and the hole it leaves behind is
 * the only record of where it came from. Every transform mermaid gave an element
 * is read first and kept, so restoring a lift is putting a string back rather
 * than recomputing a position — which is also why an element that had no
 * transform at all (a column frame) is restored by removing one.
 *
 * Two things have to be arranged for a lifted element to be visible, and both are
 * about paint order rather than geometry: SVG paints in document order, so a
 * lifted element is re-appended to the end of its own parent to be *on top* of
 * what it is passing over, and put back before its captured follower on the way
 * out. The follower is captured rather than re-walked, because the model→element
 * mapping these callers hold is the captured array.
 *
 * `into` is for a thing that is not one element: the whole set goes into that
 * container, in the order given, instead of each into its own parent. Re-appending
 * each to its own parent is the right answer for a card and cannot answer for a
 * column, whose frame and cards are two sibling lists that are ordered against
 * each other — see `kanbanDragLayer`. The restore is the same either way, because
 * every element's own place was captured before it moved.
 *
 * A lift grows a *single* thing and only a single thing. `scale` is 1 for a
 * column, and that is not a lesser version of the card's: an svg transform scales
 * about the element's own local origin, and a column's frame and its cards do not
 * share one — the frame's origin is the board's corner, each card's is its own —
 * so scaling them all by the same factor grows the frame's edges out from under
 * cards that stay put. The column is *carried*: rigid, one thing, the outline
 * saying so.
 */
function liftElements(
  elements: readonly SVGElement[],
  cls: string,
  scale = DRAG_LIFT_SCALE,
  into?: Element | null,
): { move: (dx: number, dy: number) => void; restore: () => void } {
  const bases = elements.map((element) => ({
    element,
    transform: element.getAttribute('transform'),
    parent: element.parentNode,
    follower: element.nextSibling,
  }))
  for (const { element, parent } of bases) {
    if (into) into.appendChild(element)
    else parent?.appendChild(element)
    element.classList.add(cls)
  }
  const grow = scale === 1 ? '' : ` scale(${scale})`
  return {
    move: (dx, dy) => {
      for (const { element, transform } of bases) {
        element.setAttribute('transform', `${transform ?? ''} translate(${dx}, ${dy})${grow}`.trim())
      }
    },
    restore: () => {
      // Backwards. Every element is put back before the *follower* it was
      // captured with, and that follower is the next element in the same list —
      // which, when the whole set is held in a group of its own, is another
      // lifted element still standing in the group. Restored in the order they
      // were captured, the first card would be asked to go in before a node that
      // is not in that list any more, which throws and takes the rest of the
      // restore, and the drop, with it. In reverse, anything still in front of an
      // element is either where it always was or already back.
      for (const { element, transform, parent, follower } of [...bases].reverse()) {
        if (transform === null) element.removeAttribute('transform')
        else element.setAttribute('transform', transform)
        element.classList.remove(cls)
        if (parent) parent.insertBefore(element, follower)
      }
    },
  }
}

/**
 * The drop indicator, created on the first move and inserted *into the svg ahead
 * of the things it runs under*: it is a hint about where the release lands, and
 * whatever it points between is the subject, so that paints over it. An overlay
 * in the preview cannot do this — a positioned child of the preview paints above
 * the whole drawing, which is how the line used to draw across the very card it
 * was previewing.
 *
 * What it runs under is the caller's answer, because a card and a column are
 * indicated against different things: a card line sits among cards (`.items`),
 * while a column line stands in the gutter *between* frames — so it goes ahead of
 * `.sections`, where the frame it is drawn across is over it rather than under.
 */
function createDropLine(svg: SVGSVGElement, before: Element | null): SVGLineElement {
  const line = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line')
  line.setAttribute('class', DROP_LINE_CLASS)
  svg.insertBefore(line, before)
  return line
}

/**
 * The home of a held column, above the whole board rather than inside either of
 * mermaid's two lists.
 *
 * A board is drawn as two sibling lists — the frames in `.sections`, the cards in
 * `.items`, the frames *first* — and svg paints in document order, so every card
 * on the board is painted over every frame. A lift puts a single element on top
 * by re-appending it to the end of its own parent, which is enough for a card and
 * cannot be enough for a column: moved to the end of `.sections`, a frame is over
 * the other frames and still under every card in `.items`, so a column in flight
 * is drawn with its neighbours' cards lying across it. That is not a cosmetic
 * slip in one direction only — a neighbouring column's cards on top of a column
 * that is passing over them read as cards the held column picked up, which is
 * exactly the second thing a lift has to get right.
 *
 * A column is not one element, so where one element sits cannot put it on top of
 * the board. The frame and the cards it carries are moved into a group of their
 * own, appended as the last child of the svg, frame first so the column's own
 * cards stay on top of it — the order the board itself is drawn in. Nothing about
 * how either element is *painted* changes: mermaid's kanban styles key on the
 * element's own classes (`.section-N rect`, `.node rect`, `.kanban-label`), never
 * on the list it happens to be in. And the drop line stays *under* the held
 * column, the way a card's line stays under the held card.
 */
function kanbanDragLayer(svg: SVGSVGElement): SVGElement {
  const layer = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g')
  layer.setAttribute('class', DRAG_LAYER_CLASS)
  svg.appendChild(layer)
  return layer
}

/**
 * How a drag is *presented*: what the lift does to the thing being held, and
 * where the indicator goes underneath it. Both belong to *what* is being dragged
 * rather than to how a drag works, which is why they are not in `hooks`.
 */
interface DragLift {
  /** The sibling the indicator is inserted ahead of: a card line runs under the
   *  cards, a column line under the frames. */
  before: Element | null
  /** How much the lift grows. A column is carried, not grown — see `liftElements`. */
  scale?: number
  /** A container the whole lifted set is moved into, for a thing that spans two
   *  sibling lists — see `kanbanDragLayer`. Removed when the drag ends. */
  layer?: SVGElement | null
}

/**
 * The bin a card is dropped on to be deleted: the card slot the board is drawn
 * with at the end of the board, turned into a bin for the length of one drag.
 *
 * It is *the board's own card slot* rather than anything laid over the board, and
 * that is not a detail of appearance. A card's own corner is its own title —
 * mermaid lays a label into the whole inner width of a card, so a title long
 * enough to fill the card runs right up to its edge — so a ✕ in that corner is
 * drawn over the first line of exactly the cards a user most wants to read, and
 * there is no padding to move into and no other corner that is not the same
 * problem. The board already ends in a card slot like every other column, it is
 * card-shaped, mermaid laid it out and sized it, and while a card is in the air
 * there is nothing that card would rather be: it cannot be a place to add one,
 * because the column it stands in is a place rather than a list.
 *
 * Being *of* the drawing is also what puts the bin **under** the card being
 * dragged: a board is two sibling lists, the frames in `.sections` and the cards
 * in `.items`, painted frames first, and a lift puts its element on top by
 * re-appending it. Anything laid over the drawing — a positioned panel, a
 * sibling of the svg — paints above the whole board instead, so the bin came out
 * over the very card on its way to it.
 *
 * The band goes red as well as the card, and the band's own name says what the
 * card says, because the one thing a card being dragged does is cover the slot it
 * is being aimed at: the band is taller than a card (it has a header above it),
 * so the header is what is still readable while the card is over the middle, and
 * a red column with a red card-shaped thing in it is legible as a whole whether
 * or not either half can be read on its own.
 *
 * At rest the slot says what it is — `+ Add a card` — and the bin is not there at
 * all, so a board nobody is dragging on is a board to add a column to and not a
 * board with a delete round it. Two gestures therefore share the one column
 * without ever being on screen at the same time: a *press* anywhere in the drawn
 * column, card slot included, names a new column (`onSlotClick` sends it to the
 * header's own field), and the bin is gone before any press could reach it.
 */
interface KanbanTrash {
  /** Dress the drawn column as a bin, for as long as a card is in the air. */
  show: () => void
  /** Take the dressing off, which is what every end of a drag does. */
  hide: () => void
  /** Whether a release at this point deletes rather than moves. */
  over: (event: MouseEvent) => boolean
  /** The pointer being on it, which is what makes the release a delete. */
  armed: (on: boolean) => void
  /** The delete itself, for the card at `from` — asked for, then patched. */
  drop: (from: number) => void
}

function kanbanTrash(drag: ArmedDrag): KanbanTrash {
  const { scope, session } = drag
  const slots = scope.slots as KanbanSlots
  const band = slots.column < 0 ? null : (scope.sections[slots.column] ?? null)
  // The two things that are dressed: the card the bin is, and the band it stands
  // in. Mermaid paints both from its own stylesheet, so a bin's colour has to be
  // inline — a presentation attribute loses to a rule and an inline style does
  // not — and what was there is kept, because the column has to be itself again
  // the moment the drag is over. This is a rendering of the drawing, not an edit
  // to it: nothing is patched until a delete is confirmed.
  const card = slots.columnCard
  const parts = [
    dressable(band?.querySelector('rect') ?? null, labelOf(band), 'Delete card'),
    // The card says less than the band does, and it is not a whim: mermaid sized
    // each label box to the words it drew, and a `foreignObject` clips. The band's
    // box was sized for `+ Add a column` and holds the mark and both words with
    // room to spare; the card's was sized for `+ Add a card`, and the mark and both
    // words are wider than that by more than the mark. Both strings are fixed, so
    // both boxes are the same size on every board -- which means the words that
    // fit are the same on every board, and a bin never says half of itself.
    dressable(card?.querySelector('rect') ?? null, labelOf(card), 'Delete'),
  ]
  let lit = false

  const paint = (): void => {
    for (const part of parts) part.paint(lit)
  }

  return {
    show: () => {
      // Off before the words are written, and both in the same turn, so there is
      // no frame in which the slot is revealed and still says what it said at
      // rest. Undressing first would do the same, since a hidden label has no
      // box to measure — the words are the dressing.
      card?.classList.remove(KANBAN_BIN_SLOT_CLASS)
      for (const part of parts) part.dress(trashIcon())
      paint()
    },
    hide: () => {
      for (const part of parts) part.undress()
      card?.classList.add(KANBAN_BIN_SLOT_CLASS)
    },
    // The whole column is the bin, so a release anywhere in it is a release on
    // it — including the part of the band the card slot does not reach.
    over: (event) => band !== null && hitTest(event, [band], sectionRect) !== null,
    // Lit rather than outlined: a bin is a place a pointer is aimed into, and the
    // aim is the whole answer.
    armed: (on) => {
      if (on === lit) return
      lit = on
      paint()
    },
    drop: (from) => {
      const doc = scope.model as KanbanDoc
      const card = doc.cards[from]
      const title = card?.label ?? 'this card'
      const column = card === undefined ? 'this column' : doc.lines[doc.columns[card.column]]?.label ?? 'this column'
      // Asked first and patched after: the prompt is up long enough for an undo
      // to have happened under it, so the patch is a function of the source read
      // once the answer is in rather than a string computed before the question.
      void confirmThen(
        session,
        `“${title}”`,
        `It is removed from the ${column} column.`,
        (source) => removeKanbanCard(source, from),
      )
    },
  }
}

/**
 * Ask before removing something, then remove it from whatever the board is by
 * then. One flow for both deletes on a board — a card dropped on the bin and a
 * column chosen from its menu — so the answer to "what happens if I confirm
 * after an undo" is the same for both.
 */
function confirmThen(
  session: DiagramSession,
  subject: string,
  consequence: string,
  run: (source: string) => string | null,
): Promise<void> {
  return promptForKanbanDelete(subject, consequence).then((confirmed) => {
    if (confirmed) session.patch(run)
  })
}
function labelOf(el: Element | null | undefined): Element | null {
  const label = el?.querySelector('.cluster-label .nodeLabel, .cluster-title, .nodeLabel') ?? null
  return label?.querySelector('p') ?? label
}

/**
 * One part of the bin — a band or the card in it — and what the drag puts on it
 * and takes off again. Both are the same two things, so they are one thing: an
 * inline tint, and a label replaced with the bin's own words. A part with no
 * label (a renderer that draws its header as bare text, say) is still tinted,
 * because the colour is the half that never goes missing.
 *
 * `label` is this part's own words rather than one pair shared by both, because
 * the two label boxes are not the same size and a `foreignObject` clips what does
 * not fit (see `kanbanTrash`). The mark is an inline svg for the same reason: the
 * drawing's own `svg` rule is `display: block`, and a block mark pushes the words
 * after it onto a second line that the one-line box then cuts.
 */
function dressable(
  frame: SVGElement | null,
  words: Element | null,
  label: string,
): { dress: (mark: SVGSVGElement) => void; paint: (lit: boolean) => void; undress: () => void } {
  const was = {
    fill: frame?.style.fill ?? '',
    opacity: frame?.style.fillOpacity ?? '',
    stroke: frame?.style.stroke ?? '',
    width: frame?.style.strokeWidth ?? '',
    words: words?.innerHTML ?? '',
    colour: words instanceof HTMLElement ? words.style.color : '',
  }
  let dressed = false
  return {
    dress: (mark) => {
      if (dressed) return
      dressed = true
      if (words !== null) {
        words.innerHTML = mark.outerHTML + label
        if (words instanceof HTMLElement) words.style.color = 'var(--danger)'
      }
    },
    paint: (lit) => {
      if (frame === null || !dressed) return
      frame.style.fill = 'var(--danger)'
      frame.style.fillOpacity = lit ? '0.28' : '0.14'
      frame.style.stroke = 'var(--danger)'
      frame.style.strokeWidth = lit ? '2.5px' : '1.5px'
    },
    undress: () => {
      if (!dressed) return
      dressed = false
      if (frame !== null) {
        frame.style.fill = was.fill
        frame.style.fillOpacity = was.opacity
        frame.style.stroke = was.stroke
        frame.style.strokeWidth = was.width
      }
      if (words !== null) {
        words.innerHTML = was.words
        if (words instanceof HTMLElement) words.style.color = was.colour
      }
    },
  }
}

/**
 * The bin's own mark, drawn rather than typed: there is no text glyph for a
 * trash can that is not an emoji, and every other mark on a board is drawn or
 * typographic. It goes inside the label it stands in — the card's own, or the
 * band's — so it is laid out and clipped by mermaid's label box like any other
 * word on the board, which is the point: a mark the board laid out cannot end up
 * outside the thing it is marking.
 */
function trashIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', KANBAN_BIN_MARK_CLASS)
  svg.setAttribute('aria-hidden', 'true')
  // Lid, handle, body, and the two ribs inside it. The colour is inline, and
  // that is not a style preference: mermaid rules style `path` inside a board with
  // its own palette, and such a rule beats both an inherited value and the
  // presentation attribute below — so the mark came out in the diagram's
  // colours, filled rather than drawn, while the words beside it were the
  // danger colour. An inline style is the only thing that wins. `currentColor` is
  // the fallback so the mark can never end up with no colour of its own.
  for (const d of ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7 7.5 20h9L17.5 7', 'M10 10.5v6', 'M14 10.5v6']) {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.8')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    path.style.stroke = 'var(--danger, currentColor)'
    path.style.fill = 'none'
    svg.appendChild(path)
  }
  return svg
}

/**
 * The machinery a card drag and a column drag share: threshold, lift, indicator,
 * restore. Everything that differs is in `hooks`, because "where does this land"
 * is the only real difference — a card lands in a slot inside a list, a list lands
 * in a gap between two lists.
 *
 * The whole gesture is a phase, so it registers itself with the session and the
 * session is what ends it. That is what makes a render during a drag safe: the
 * drawing the drag is measured against and the window listeners that move it both
 * go at once, and a drag that outlived a render would go on moving elements the
 * render threw away and commit a move computed from the board that render
 * replaced.
 */
function armDragGroup(
  drag: ArmedDrag,
  lifted: readonly SVGElement[],
  cls: string,
  hooks: DragHooks,
  lift: DragLift,
): void {
  const { before, scale, layer } = lift
  const { session, scope, down } = drag
  const container = session.preview
  const svg = scope.svg
  let group: ReturnType<typeof liftElements> | null = null
  let line: SVGLineElement | null = null
  let over: SVGElement | null = null
  let stopped = false

  /**
   * The line is an svg child, so its endpoints are written in the drawing's own
   * units — which is why a scrolled or zoomed preview needs no correction here,
   * and why the hooks only ever think in the pixels they are handed.
   */
  const placeLine = (at: { x1: number; y1: number; x2: number; y2: number } | null): void => {
    if (line === null) return
    if (at === null) {
      line.style.display = 'none'
      return
    }
    // Read on every move, not once at the press: a press that grows the block
    // around a composer, a zoom, or a window resize moves the drawing, and a
    // mapping frozen at the press is a line that draws itself somewhere the board
    // no longer is — as laggy, or as far off, as the card it belongs to.
    const map = svgMapping(svg)
    const start = user(map, at.x1, at.y1)
    const end = user(map, at.x2, at.y2)
    line.style.display = ''
    line.setAttribute('x1', `${start.x}`)
    line.setAttribute('y1', `${start.y}`)
    line.setAttribute('x2', `${end.x}`)
    line.setAttribute('y2', `${end.y}`)
  }

  /** A point of the board in viewport px, in the drawing's own user units. */
  const user = (map: SvgMapping, x: number, y: number): { x: number; y: number } => ({
    x: map.x + (x - map.rect.left) / map.scaleX,
    y: map.y + (y - map.rect.top) / map.scaleY,
  })

  const stop = (): void => {
    if (stopped) return
    stopped = true
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    release()
    // Before the restore, so whatever the drag was carrying is back on the board
    // before the board is told anything about it.
    hooks.end?.()
    try {
      group?.restore()
    } finally {
      // A restore that throws must not take the drop with it: the elements that
      // did go back are back, and the one that did not is a card in the wrong
      // place rather than a card lost off the board. Everything else here is
      // cleanup, and cleanup that can be skipped is worse than a failed restore.
      group = null
      container.classList.remove(DRAG_CONTAINER_CLASS)
      // The group a held column was kept in goes with it, whether the drag ever
      // started: an empty `g` on the board outliving the drag is one more thing
      // that has to be accounted for by everything walking it.
      layer?.remove()
      line?.remove()
      line = null
      over?.classList.remove(DROP_TARGET_CLASS)
      over = null
    }
  }

  const onMove = (event: Event): void => {
    const pointer = event as PointerEvent
    if (group === null) {
      if (Math.hypot(pointer.clientX - down.clientX, pointer.clientY - down.clientY) < DRAG_THRESHOLD) return
      group = liftElements(lifted, cls, scale, layer)
      group.move(0, 0)
      container.classList.add(DRAG_CONTAINER_CLASS)
      line = createDropLine(svg, before)
      // Not on the press: a press on a card is a rename, and everything a drag
      // puts on the board has no business being there for one.
      hooks.begin?.()
    }
    // The drag is ours now, so no text selection or native drag should follow.
    pointer.preventDefault()
    // The offset is divided back into the viewBox's own units, so the thing
    // tracks the pointer by a pixel whatever the board is scaled to.
    const map = svgMapping(svg)
    group.move((pointer.clientX - down.clientX) / map.scaleX, (pointer.clientY - down.clientY) / map.scaleY)
    const target = highlight(pointer)
    placeLine(hooks.place(pointer, target))
  }

  const onUp = (event: Event): void => {
    const pointer = event as PointerEvent
    const target = highlight(pointer)
    const moved = group !== null
    stop()
    hooks.drop(pointer, target, moved)
  }

  const onCancel = (): void => stop()

  // The drop target is the element the pointer is over, marked for the drag's
  // duration; the card case marks the column it is in, the column case the list
  // whose gap it would fill.
  const original = hooks.highlight
  const highlight = (event: PointerEvent): SVGElement | null => {
    const next = original(event)
    if (next !== over) {
      over?.classList.remove(DROP_TARGET_CLASS)
      over = next
      over?.classList.add(DROP_TARGET_CLASS)
    }
    return next
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  const release = session.start('drag', () => stop())
}

/** Drag a card into another column, to another spot in its own, or to the bin. */
function armCardDrag(drag: ArmedDrag, trash: KanbanTrash): void {
  const { scope, session } = drag
  const { cards, sections, svg } = scope
  const doc = scope.model as KanbanDoc
  const card = cards[drag.from]

  armDragGroup(
    drag,
    [card],
    DRAG_CARD_CLASS,
    {
      highlight: (event) => {
        // The slot column is a place to *name*, so `liveHit` promises nothing
        // over it and the drop line goes away there. For a card in the air it is
        // the bin instead, and the two answers are not in conflict: no line
        // promises a place, and the lit bin promises the delete.
        trash.armed(trash.over(event))
        return liveHit(event, sections, scope.slots?.column ?? -1)
      },
      begin: () => trash.show(),
      end: () => trash.hide(),
      /**
       * Put the line where a release would drop the card. It is placed on every
       * move rather than only on the target changing, because the *index* changes
       * within one column all the time, and that index is the thing the user
       * cannot see: a card over a three-card column is going to the first, second
       * or third slot, and nothing about the column outline says which.
       */
      place: (event, target) => {
        // Off every column there is nowhere to land, so nothing is promised: the
        // line going away is the answer, and a release here does nothing.
        if (target === null) return null
        const column = sections.indexOf(target)
        const { siblings, slot } = dropColumn(doc, cards, column, drag.from)
        const at = dropLineAt(siblings, dropIndex(event, siblings), sectionRect(target), slot)
        return { x1: at.x, y1: at.y, x2: at.x + at.width, y2: at.y }
      },
      drop: (event, target, moved) => {
        // The one release that is not a move. A press that never travelled is not
        // on the bin, however far it happened to be pointing when it ended.
        if (moved && trash.over(event)) {
          trash.drop(drag.from)
          return
        }
        const column = moved && target !== null ? sections.indexOf(target) : -1
        if (column < 0) return
        const from = drag.from
        const { siblings } = dropColumn(doc, cards, column, from)
        const at = dropIndex(event, siblings)
        session.patch((source) => moveKanbanCard(source, from, column, at))
      },
    },
    { before: svg.querySelector('.items') },
  )
}

/** Drag a whole list to another place on the board. */
function armColumnDrag(drag: ArmedDrag): void {
  const { scope, session } = drag
  const { cards, sections, svg } = scope
  const doc = scope.model as KanbanDoc
  const frame = sections[drag.from]
  if (frame === undefined) return
  // A list is not one element: the frame and its cards are two sibling lists, so
  // the whole list is lifted as the unit it reads as — otherwise the frame would
  // travel and the cards would stay behind. The *order* is the board's own, frame
  // first, and it is what the lift is handed so the group's own paint order is the
  // same drawing the column had on the board.
  const from = drag.from
  const lifted = [frame, ...cards.filter((_, index) => doc.cards[index]?.column === from)]

  armDragGroup(
    drag,
    lifted,
    DRAG_COLUMN_CLASS,
    {
      highlight: (event) => liveHit(event, sections, scope.slots?.column ?? -1),
      /**
       * A vertical line in the gap the list will drop into, spanning the board. The
       * gap is the answer to "where does this land" the same way the card line's gap
       * is, and it has to be drawn *between* two lists: a list held over three
       * columns could go into any of three, and the frames are all the same colour.
       */
      place: (event) => {
        const { rest, end } = dropSections(sections, from, scope.slots?.column ?? -1)
        const at = columnGapAt(rest, end, columnSlotAt(event, rest))
        return at === null ? null : { x1: at.x, y1: at.y, x2: at.x, y2: at.y + at.height }
      },
      drop: (event, _target, moved) => {
        if (!moved) return
        const { rest } = dropSections(sections, from, scope.slots?.column ?? -1)
        const at = columnSlotAt(event, rest)
        session.patch((source) => moveKanbanColumn(source, from, at))
      },
    },
    // Carried, not grown, and held in a group of its own: the frame and its cards
    // are two lists the svg draws one after the other, so neither one's re-append
    // can put the column on top of the board.
    { before: svg.querySelector('.sections'), scale: 1, layer: kanbanDragLayer(svg) },
  )
}
/**
 * Where a column lands: the number of columns whose middle lies left of the
 * pointer, clamped to the board. The same shape as a card's insertion index, one
 * level up, and for the same reason — the slot *is* the answer, so the drop is
 * computed from the pointer's position rather than from the column it happens to
 * be over.
 */
function columnSlotAt(event: PointerEvent, rest: DOMRect[]): number {
  let slot = 0
  for (const rect of rest) {
    if (rect.left + rect.width / 2 < event.clientX) slot += 1
  }
  return slot
}

/**
 * The board's columns a drop can land between, and the drawn column at its end.
 *
 * The drawn column is a place to add, not a column, and the two are told apart
 * here once so nothing downstream has to: it *ends* the board rather than
 * sitting in it, so the last gap is the one before it and there is no gap after
 * it to offer. The list is the real columns with the dragged one lifted out,
 * which is what makes the dragged column's own place count as a gap.
 */
function dropSections(
  sections: SVGElement[],
  from: number,
  slot: number,
): { rest: DOMRect[]; end: DOMRect | null } {
  const rest: DOMRect[] = []
  let end: DOMRect | null = null
  sections.forEach((section, index) => {
    if (index === from) return
    const rect = sectionRect(section)
    if (index === slot) end = rect
    else rest.push(rect)
  })
  return { rest, end }
}

/**
 * The vertical line for a slot: the gap the list will drop into.
 *
 * The neighbours are read off the board *without* the moving column, because that
 * is the row of frames the gap is measured in — `slot` is the index the list will
 * end up at, and a list dragged to the end lands past the last frame that is
 * still there, not past its own old one. Measuring against the untouched row
 * would put the line inside whichever column happened to be adjacent before.
 *
 * That is also why the line's *height* comes from the same row rather than from
 * the board: the moving column is under the pointer and off wherever the pointer
 * is, so a rule that took its top from it grew as the list was dragged upward —
 * off the top of the board and out over the toolbar above it, which the drag's
 * `overflow: visible` (there so a card is not cut off) lets it do. A rule that
 * changes length as you move is a rule that cannot be trusted to mean anything.
 */
function columnGapAt(
  rest: DOMRect[],
  end: DOMRect | null,
  slot: number,
): { x: number; y: number; height: number } | null {
  if (rest.length === 0) return null
  // The last gap is the one *before* the drawn column, which is where a column
  // dropped at the end of the board lands. Without one there is nothing drawn
  // there, so the gap is the last column's own right edge.
  const left = slot === 0 ? rest[0]!.left : rest[slot - 1]!.right
  const right = slot === rest.length
    ? (end ? end.left : rest[rest.length - 1]!.right)
    : rest[slot]!.left
  const top = Math.min(...rest.map((rect) => rect.top))
  const bottom = Math.max(...rest.map((rect) => rect.bottom))
  // The board's own height, top to bottom: a column is inserted between two
  // frames rather than into a slot inside one, so the line is a full-height rule
  // rather than a short bar in a band.
  return { x: (left + right) / 2, y: top, height: bottom - top }
}

/** The section's background rect, i.e. the column area mermaid sized to its cards. */
function sectionRect(section: SVGElement): DOMRect {
  const rect = section.querySelector('rect')
  return rect ? rect.getBoundingClientRect() : section.getBoundingClientRect()
}

/**
 * How the svg's own user units line up with the screen, which a drag has to
 * reconcile twice: a press is measured in screen pixels while the card is moved
 * by an SVG transform inside a viewBox mermaid has scaled to fit, so without
 * this the card drifts away from the pointer as soon as the board is not drawn at
 * 1:1. The two axes are read separately rather than assumed equal, since a
 * container that squashes the drawing letterboxes it.
 */
function svgMapping(svg: SVGSVGElement): SvgMapping {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const rect = svg.getBoundingClientRect()
  const [x = 0, y = 0, unitsX = 0, unitsY = 0] = viewBox?.length === 4 ? viewBox : []
  return {
    x,
    y,
    scaleX: unitsX > 0 && rect.width > 0 ? rect.width / unitsX : 1,
    scaleY: unitsY > 0 && rect.height > 0 ? rect.height / unitsY : 1,
    rect,
  }
}

interface SvgMapping {
  /** The viewBox origin: where its top-left corner sits in user units. */
  x: number
  y: number
  scaleX: number
  scaleY: number
  rect: DOMRect
}

interface DropLine {
  x: number
  y: number
  width: number
}

/**
 * Where the line goes: the gap the card will drop into, in viewport
 * coordinates, spanning the column. A column of n cards offers n+1 gaps
 * and the dragged card's own place is one of them, so this is the whole answer
 * to "where does this land" — the line, not the card, is what the release acts
 * on. `siblings` are the target column's other *real* cards, in board order,
 * which is what makes the dragged card's own slot count as a gap rather than a
 * neighbour; `slot` is the drawn slot, which ends the column rather than sitting
 * in it.
 */
function dropLineAt(
  siblings: DOMRect[],
  index: number,
  section: DOMRect,
  slot: DOMRect | null,
): DropLine {
  const x = section.left - DROP_LINE_OVERHANG
  const width = section.width + DROP_LINE_OVERHANG * 2
  // Where the column's cards end. A drawn slot *is* the foot of the column as it
  // looks, and it is where the next card goes and stays the last thing drawn --
  // so the last gap is above it and there is nothing below it to offer. Without
  // a slot the last gap is under the last card, and a column with no cards at
  // all has a band sized to its header alone, so the middle of the band is
  // where the card will appear.
  const end = slot
    ? slot.top - DROP_LINE_GAP
    : siblings.length
      ? siblings[siblings.length - 1].bottom + DROP_LINE_GAP
      : section.top + section.height / 2
  if (siblings.length === 0) return { x, y: end, width }
  const first = siblings[0]
  const y =
    index <= 0
      ? first.top - DROP_LINE_GAP
      : index >= siblings.length
        ? end
        : (siblings[index - 1].bottom + siblings[index].top) / 2
  return { x, y, width }
}

/**
 * A column's cards a drop can land between, and the drawn slot at its foot.
 *
 * The slot is a place to add, not a card, and the two are told apart here once
 * so that nothing downstream has to: the slot's foot is the *end* of the column
 * rather than a card above the last gap, and the list is the column's real cards
 * in board order with the dragged one lifted out, which is what makes the
 * dragged card's own place count as a gap rather than a neighbour.
 */
function dropColumn(
  doc: KanbanDoc,
  cards: SVGElement[],
  column: number,
  from: number,
): { siblings: DOMRect[]; slot: DOMRect | null } {
  const siblings: DOMRect[] = []
  let slot: DOMRect | null = null
  doc.cards.forEach((card, position) => {
    if (position === from || card.column !== column) return
    const rect = cards[position].getBoundingClientRect()
    if (isKanbanCardSlot(card, doc)) slot = rect
    else siblings.push(rect)
  })
  return { siblings, slot }
}

/**
 * Where a card lands inside a column: the number of the column's *real* cards
 * whose middle sits above the pointer, i.e. the insertion index as if the
 * dragged card were already lifted out of the list. The drawn slot is not one of
 * them, so a pointer over the foot of a column asks for the last gap rather than
 * a gap below the last card.
 */
function dropIndex(event: PointerEvent, siblings: DOMRect[]): number {
  let index = 0
  for (const rect of siblings) {
    if (rect.top + rect.height / 2 < event.clientY) index += 1
  }
  return index
}

// ── kanban board chrome ─────────────────────────────────────────────────────

/**
 * A placed control's box, in viewport coordinates. The width and height are
 * optional because a control is sized by its own content in one case only — the
 * menu, whose height is however many items it has — and every other caller says
 * both, so this is what a full `DOMRect` is accepted as.
 */
interface ChromeBox {
  left: number
  top: number
  width?: number
  height?: number
}

/**
 * The board's own controls in edit mode, and as few of them as a board can be
 * read with: a quiet `⋯` in the corner of every real column. The places to add
 * are not controls at all — they are *drawn* into the board
 * (`kanbanAuthoringSource`), so mermaid lays them out and this layer never has
 * to. A card is not a control surface either: a title long enough to fill its
 * card runs right up against the card's own edge, so anything laid over one is
 * laid over the words, and a card is deleted by being dropped on the column the
 * board is drawn with instead. The `⋯` stays visible whatever the pointer is
 * doing: a control nobody can find is not quieter, it is missing.
 *
 * They are HTML in the preview rather than `foreignObject`s inside mermaid's own
 * layout: a view-mode diagram is a baked bitmap, which cannot host them, and an
 * overlay is rebuilt from the rendered sections on every render anyway.
 *
 * Every control is registered with the session as an *overlay*, which is what
 * makes a control and a field the same kind of thing: one placement function, one
 * coordinate space, one settle loop, and one teardown. That is why a control can
 * no longer drift away from the column it belongs to when the board moves under
 * it — a resize, a zoom, a block that grew around a composer — and why there is
 * no second listener to forget to remove.
 */
function attachKanbanChrome(session: DiagramSession, scope: RenderScope): () => void {
  const { cards, sections, slots } = scope
  const doc = scope.model as KanbanDoc
  // A model that does not line up with the DOM would put a control on a card the
  // user did not press, or offer to delete a neighbour of the one they pressed,
  // and there is no rendering to compare against.
  if (doc.columns.length === 0 || doc.columns.length !== sections.length || doc.cards.length !== cards.length) {
    return () => undefined
  }
  const container = session.preview
  const slotColumn = slots?.column ?? -1

  const columnName = (column: number): string => doc.lines[doc.columns[column]]?.label ?? 'this column'
  /** How many *cards* a column holds: a drawn slot is a place, not one of them. */
  const cardsIn = (column: number): number =>
    doc.cards.filter((card) => card.column === column && !isKanbanCardSlot(card, doc)).length
  /** Where the header of a column is, as an index into the render's labels. */
  const headerOf = (band: Element): number => indexOfLabel(scope, labelElementIn(band?.querySelector('.cluster-label') ?? band))

  const layer = document.createElement('div')
  layer.className = KANBAN_CHROME_CLASS
  container.appendChild(layer)
  const unplaced: Array<() => void> = []

  /**
   * One board control, with the event guards every one of them needs: a press
   * must not reach ProseMirror (it would start a node selection), the drag (it
   * hit-tests cards by coordinate and would arm over a card a control sits on) or
   * the click that opens a label's editor.
   */
  const control = (
    kind: string,
    text: string,
    label: string,
    box: () => ChromeBox,
    onClick: () => void,
  ): HTMLButtonElement => {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = `${KANBAN_BUTTON_CLASS} ${kind}`
    element.textContent = text
    element.title = label
    element.setAttribute('aria-label', label)
    element.addEventListener('click', (event) => {
      event.stopPropagation()
      onClick()
    })
    element.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    element.addEventListener('pointerdown', (event) => event.stopPropagation())
    layer.appendChild(element)
    unplaced.push(session.overlay(element, box))
    return element
  }

  // ── the ⋯ menu ──
  //
  // One at a time, and one per diagram: a board is not a toolbar, and two open
  // menus over it say nothing about either. The list is a positioned sibling of
  // the svg like every other control, so it is chrome too — the double click
  // that ends an edit session must not land inside it.
  let closeMenu: (() => void) | null = null
  // Which `⋯` the open menu belongs to, so pressing *that* one is the toggle and
  // pressing any other is a move: without it, a second `⋯` could only ever close
  // the first menu, and opening a second one took two presses.
  let openMenuFor: HTMLButtonElement | null = null
  const dismissMenu = (): void => {
    closeMenu?.()
    closeMenu = null
    openMenuFor = null
  }

  const menuItem = (text: string, kind: string, danger: boolean, run: () => void | Promise<void>): HTMLButtonElement => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `${MENU_ITEM_CLASS} ${MENU_ITEM_KIND_CLASS}${kind}${danger ? ` ${MENU_ITEM_DANGER_CLASS}` : ''}`
    item.setAttribute('role', 'menuitem')
    item.textContent = text
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    item.addEventListener('pointerdown', (event) => event.stopPropagation())
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      // The menu goes first: an item that opens a composer must not leave its
      // own list on screen over the field that replaced the button.
      dismissMenu()
      void run()
    })
    return item
  }

  /**
   * The list answers for itself, not just for its items: it has padding and 1px
   * gaps between them, and every one of those belongs to the popover. Only the
   * items act on a press, so a press anywhere else in the list is held by it
   * rather than reaching the board.
   */
  const menuList = (label: string): HTMLDivElement => {
    const list = document.createElement('div')
    list.className = MENU_LIST_CLASS
    list.setAttribute('role', 'menu')
    list.setAttribute('aria-label', label)
    for (const type of ['pointerdown', 'mousedown'] as const) {
      list.addEventListener(type, (event) => event.stopPropagation())
    }
    return list
  }

  // The board is drawn with its slots, and this is what says which of the things
  // the DOM walk found are those slots: everything below is built for content.
  for (const el of slots?.cards ?? []) el.classList.add(ADD_SLOT_CLASS)
  if (slotColumn >= 0) sections[slotColumn]!.classList.add(COLUMN_SLOT_CLASS)
  // The card slot in the drawn column is the bin, and at rest it must be nothing.
  // It is the one place on the board that invites a card into a column that does
  // not exist yet, and the press it invites is a press the editor answers with a
  // *column*, so a card drawn there at rest is a caption over the wrong answer.
  // The space stays (mermaid sized the band with it, and the band is what the bin
  // is read against); `kanbanTrash` takes the class off when a card is in the air.
  if (slots?.columnCard) slots.columnCard.classList.add(KANBAN_BIN_SLOT_CLASS)
  session.onRender(() => {
    for (const el of slots?.cards ?? []) el.classList.remove(ADD_SLOT_CLASS)
    if (slotColumn >= 0) sections[slotColumn]?.classList.remove(COLUMN_SLOT_CLASS)
    slots?.columnCard?.classList.remove(KANBAN_BIN_SLOT_CLASS)
  })

  sections.forEach((section, column) => {
    // The new column at the end of the board has no menu: it is a place to type a
    // name, and it is not yet a column to add to, rename or delete.
    if (column === slotColumn) return
    const name = columnName(column)
    const menuBox = (): DOMRect => {
      const rect = sectionRect(section)
      const size = KANBAN_BUTTON_HALF * 2
      // Centred on the column's own name, which is what it belongs to and what
      // the eye lines it up with. The band's top edge is not the header's: the
      // band is padded and the name is drawn inside that padding, so an inset
      // from the band puts the mark below the text it is the menu of. The name's
      // own box is the only thing that knows where the header really is, and a
      // band is the fallback for a name with none: one that is not offered (a
      // repeated name, which has no single target) or one that has not been laid
      // out, which measures as no height at all.
      const shown = labelElementIn(section.querySelector('.cluster-label'))?.getBoundingClientRect()
      const top =
        shown === undefined || shown.height <= 0 ? rect.top + KANBAN_BUTTON_EDGE : shown.top + shown.height / 2 - size / 2
      return new DOMRect(rect.right - KANBAN_BUTTON_EDGE - size, top, size, size)
    }

    // Two items, and both are generic: the menu belongs to the column whose `⋯`
    // it hangs off, so "Rename column" is already "rename *this* column", and
    // nothing it says has to fit inside a name that can be any length. Adding a
    // column is not here at all — the board is drawn with a column slot at its
    // end, which is a place to name rather than an item in a list, so a way to
    // add one that is *only* here would be a way to add one a board has not got.
    const actions: Array<{ text: string; kind: string; danger: boolean; run: () => void | Promise<void> }> = [
      {
        text: 'Rename column',
        kind: 'rename',
        danger: false,
        // The very edit a click on the header makes, found by position rather than
        // by name: two columns may share a name, and the one that renames is the
        // one whose menu was opened.
        run: () => {
          const index = headerOf(section)
          if (index >= 0) editColumnName(session, index, section)
        },
      },
    ]
    // A board keeps at least one column, so a board of one is not offered the
    // delete that would leave nothing behind: what cannot be done is not on the
    // board. `removeKanbanColumn` refuses it as well, and the slot column the
    // board is drawn with is not one of them.
    if (kanbanColumnCount(session.source) > 1) {
      const taken = cardsIn(column)
      actions.push({
        // The name is the *dialog's* to say, not the item's: the prompt is where a
        // delete is confirmed, so that is where "which one" has to be answered,
        // and a list that says it twice is a list twice as wide as it needs to be.
        text: 'Delete column',
        kind: 'delete',
        danger: true,
        run: () =>
          confirmThen(
            session,
            `the ${name} column`,
            taken === 0
              ? 'The column is removed from the board.'
              : `Its ${taken} card${taken === 1 ? '' : 's'} go with it.`,
            (source) => removeKanbanColumn(source, column),
          ),
      })
    }

    const menu = control(MENU_BUTTON_CLASS, '⋯', `${name} column actions`, menuBox, () => {
      if (openMenuFor === menu) {
        dismissMenu()
        return
      }
      // Another column's menu, if one is open, is not this one's business.
      dismissMenu()
      // Claimed *before* anything of this menu is built, because claiming a phase
      // finishes the interaction holding it — which is the menu that was open —
      // and a claim made after would finish this one instead.
      //
      // A menu is the one interaction that does not displace a field: pressing a
      // column's `⋯` mid-rename should not throw the rename away.
      const claimed = session.start('menu', () => dismissMenu())
      const list = menuList(`${name} column actions`)
      for (const action of actions) list.appendChild(menuItem(action.text, action.kind, action.danger, action.run))
      layer.appendChild(list)
      // Placed here rather than on the next resize: the list is built long after
      // the layer's own placement ran, so without this it would sit wherever the
      // markup put it — the top-left of the board, over the first column.
      const unplace = session.overlay(list, () => {
        // Attached to the `⋯`: the list starts exactly where its own button ends,
        // and hangs inside the column because it is right-aligned to it.
        const at = menuBox()
        return { left: at.left + at.width - MENU_WIDTH, top: at.top + at.height, width: MENU_WIDTH }
      })
      unplaced.push(unplace)
      closeMenu = () => {
        list.remove()
        const at = unplaced.indexOf(unplace)
        if (at >= 0) unplaced.splice(at, 1)
        unplace()
        claimed()
      }
      openMenuFor = menu
      ;(list.firstElementChild as HTMLElement | null)?.focus()
    })
    menu.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key !== 'Escape' && key !== 'ArrowDown' && key !== 'ArrowUp') return
      event.preventDefault()
      event.stopPropagation()
      if (key === 'Escape') {
        dismissMenu()
        return
      }
      const items = [...layer.querySelectorAll<HTMLElement>(`.${MENU_ITEM_CLASS}`)]
      const at = items.indexOf(document.activeElement as HTMLElement)
      const step = key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    })
  })

  // ── the two drawn slots ──
  //
  // A board's shape is obvious while you are looking at it and not at all once it
  // is a paragraph of source, so both places a card or a column can be added are
  // *drawn*: a card slot in every column, in the next card's own place, and a
  // column at the end of the board, as wide and as tall as the real ones. Mermaid
  // lays both out as the things they are about to become, so nothing is positioned
  // by hand, nothing can be laid over a card, and the board is exactly the board
  // plus the room it needs to grow.
  //
  // They are resolved from the click rather than pressed as controls: a slot is
  // part of the drawing, so a click in one is a click on the board. A card slot
  // asks for a title in the composer that fills it, and the new column is named
  // with the editor its own header is edited by, so a name is keyed into the band
  // exactly as it is edited once it exists.
  const slotOf = new Map<SVGElement, number>()
  for (const el of slots?.cards ?? []) slotOf.set(el, doc.cards[cards.indexOf(el)]!.column)
  const band = slotColumn < 0 ? null : (sections[slotColumn] ?? null)
  const onSlotClick = ((event: MouseEvent) => {
    if (event.button !== 0) return
    const slot = drawnElementAt(event, `.${ADD_SLOT_CLASS}, .${COLUMN_SLOT_CLASS}`, [
      ...slotOf.keys(),
      ...(band === null ? [] : [band]),
    ])
    if (slot === null) return
    // A click on a label is the label's own business, which is how a card's title
    // and a band's name are edited.
    if (event.target instanceof Element && event.target.closest(`.${EDITABLE_CLASS}`) !== null) return
    const column = slotOf.get(slot)
    // A card slot in a column that exists asks for a card's title. The one in the
    // drawn column cannot: that column is a place rather than a list, so it has
    // nothing to put a card in, and the whole press falls through to naming it.
    if (column !== undefined && column !== slotColumn) {
      event.preventDefault()
      editCardTitle(session, cards.indexOf(slot), true)
      return
    }
    // The new column is named through its own header, which the label editor
    // already owns: a click anywhere in the empty band is that header's click. The
    // field it opens is a *new* one, though — empty, one line tall, standing in the
    // band rather than over the text on it, because the band is card-tall and its
    // label is a placeholder that is not a name to retype.
    if (band === null || !contains(band.getBoundingClientRect(), event.clientX, event.clientY)) return
    const index = headerOf(band)
    if (index < 0) return
    event.preventDefault()
    editColumnName(session, index, band)
  }) as EventListener
  session.listen(container, 'click', onSlotClick)

  // ── what is under the pointer ──
  //
  // Only the menu answers to it now. A card is not covered by a control and is
  // not deleted by one: it is *picked up* and dragged onto the column the board
  // is drawn with, which is a bin for the length of that drag.
  /** The list, or the `⋯` it belongs to: the menu hangs off both, so the pointer
   *  may travel from either to the other. */
  const isOnMenu = (target: Element): boolean =>
    target.closest(`.${MENU_LIST_CLASS}`) !== null ||
    target.closest(`.${MENU_BUTTON_CLASS}`) === openMenuFor
  // A press anywhere that is not the menu's own list dismisses it. The `⋯` and
  // the items stop the press reaching here, so the `⋯`'s own click is the toggle.
  session.listen(container, 'pointerdown', (() => dismissMenu()) as EventListener)
  session.listen(container, 'keydown', ((event: Event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    dismissMenu()
  }) as EventListener)
  // Moving the pointer off it takes it away, because a board is not a dialog and
  // nothing else on it is reachable while one is open. What is *on* it does not:
  // the list, and the `⋯` it hangs off, which the walk up from an item to the mark
  // that opened it crosses on every single pass. A *different* column's `⋯` is a
  // move rather than a return, so it does still take it away.
  session.listen(container, 'pointerover', ((event: Event) => {
    if (closeMenu === null) return
    if (event.target instanceof Element && isOnMenu(event.target)) return
    dismissMenu()
  }) as EventListener)

  return () => {
    for (const unplace of unplaced.splice(0)) unplace()
    layer.remove()
  }
}
