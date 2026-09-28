/**
 * Visual editing for rendered mermaid diagrams.
 *
 * The block's `value` is the source of truth and the SVG is derived state:
 * every visual edit (retitling a label, dragging a kanban card) patches the
 * mermaid source and re-renders through `renderDiagram` — the same pipeline
 * the initial render, node updates and the zoom toolbar already use. When a
 * patch produces source mermaid refuses to parse, the last good diagram stays
 * on screen and a transient notice explains why, instead of the whole diagram
 * being replaced by an error block.
 */

import {
  adaptDiagramColors,
  attachMermaidToolbar,
  bakeDiagram,
  errorBlock,
  loadMermaid,
  pinSvgTextColors,
  responsifySvg,
} from './mermaid'
import { promptForKanbanDelete } from './urlDialog'

// ── classes and timings ────────────────────────────────────────────────────

const EDITABLE_CLASS = 'mermaid-editables'
const INPUT_CLASS = 'mermaid-edit-input'
/** The box an inline input is placed and sized by, so a caption rides with it. */
export const FIELD_CLASS = 'mermaid-edit-field'
const CAPTION_CLASS = 'mermaid-edit-caption'
/** On the field above an input that is *adding* something, not replacing it. */
const FIELD_NEW_CLASS = 'mermaid-edit-field-new'
const INVALID_CLASS = 'mermaid-edit-invalid'
const NOTICE_CLASS = 'mermaid-edit-notice'
const NOTICE_TEXT =
  "Couldn't parse diagram — keeping the previous version. Edit the source to fix it."
const NOTICE_MS = 3000
const INVALID_FLASH_MS = 700
/** The card being dragged: the real one, lifted out of the board to follow the pointer. */
const DRAG_CARD_CLASS = 'kanban-dragging-card'
/** On the preview while a card is in flight, so the board stops clipping it. */
const DRAG_CONTAINER_CLASS = 'kanban-dragging'
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
/** The per-column ＋ that creates a card. */
export const ADD_BUTTON_CLASS = 'mermaid-kanban-add'
const COLUMN_ADD_BUTTON_CLASS = 'mermaid-kanban-column-add'
const CARD_REMOVE_BUTTON_CLASS = 'mermaid-kanban-card-remove'
const COLUMN_REMOVE_BUTTON_CLASS = 'mermaid-kanban-column-remove'
/** Half the board buttons' side, in px: they are placed by their centre. */
const KANBAN_BUTTON_HALF = 11
/** Half a card's delete button, which is smaller than a ＋. */
const REMOVE_BUTTON_HALF = 8
/** From a card's or column's own corner to the centre of its button. */
const KANBAN_BUTTON_EDGE = 10
/** Between a column's two header buttons. */
const KANBAN_BUTTON_GAP = 5
/** A field that names a new card or column, wide enough for a real title. */
const NEW_FIELD_WIDTH = 200
const NEW_FIELD_HEIGHT = 22
const NEW_FIELD_LIFT = 8
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
      if (spelled && spelled !== target.text && shown.endsWith(squeeze(spelled).text.toLowerCase())) {
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

function kanbanSpans(source: string, label: string): MapperResult {
  const spans: Span[] = []
  let quoted = false
  for (const line of parseKanban(source).lines) {
    if (line.kind !== 'column' && line.kind !== 'card') continue
    if (line.label !== label) continue
    if (source[line.labelStart] === '"' && source[line.labelEnd - 1] === '"') quoted = true
    spans.push({ start: line.labelStart, end: line.labelEnd })
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
 * label itself is the text inside them (`parseKanban` unquotes): a rename
 * replaces the run, so `kanbanInnerLabel` can quote a title that needs it and
 * unquote one that no longer does, without knowing which of the two it is
 * looking at. Recognised before the shape search, or a bare `"Fix (bug)"` finds
 * its own `(` and gets mapped to `bug`.
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
  return text.length > 1 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
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
const KANBAN_QUOTE_CHARS = /[[\](){}@>]/

/**
 * The text to write *inside* a `[…]`'s delimiters. Mermaid's kanban grammar
 * takes a quoted label and draws it without the quotes, so `["Fix (bug)"]` is
 * the text `Fix (bug)` on the board and in the label editor — the quotes are a
 * source-level spelling detail, never part of what the user typed. One function
 * for all three writers (a new card, a new column, a rename) so a label cannot
 * be writable one way and not the other.
 */
function kanbanInnerLabel(text: string): string {
  return KANBAN_QUOTE_CHARS.test(text) ? `"${text}"` : text
}

/** A label whose source already carries quotes keeps them across a rename. */
function kanbanQuotedLabel(text: string): string {
  return `"${text}"`
}

/**
 * What no quoting can carry. A `"` would close the label the quote opened, and a
 * line break is not text at all. Everything else mermaid refuses in a bare label
 * is quoted above, so the refusal is about the *representable*, not the
 * convenient — and a card is refused before it reaches the source, because
 * committing one that cannot render strands the board on its last good diagram
 * with the card the user just typed visible nowhere.
 */
const UNUSABLE_KANBAN_LABEL = /["\n]/

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
  return 'A kanban label can’t contain a double quote — there is no way to write one into a diagram.'
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
 * Insert a new column at position `at` among the board's columns, or `null` when
 * the label is unusable (see `usableKanbanLabel`) or the rebuild would not change
 * the source. `at` is 0 for before the first column and the column count for
 * after the last one, so a column can be added in the middle of a board.
 *
 * Only the new header line is added: the new column's own id is chosen fresh
 * (`freshKanbanId`) and nothing in the grammar ties a card to its column by
 * position, so every other line — including the ids the user gave their own
 * columns — is left exactly as it was. A renumbered board would be tidier and
 * would rewrite source the insert was never asked to touch.
 */
export function addKanbanColumn(source: string, at: number, label: string): string | null {
  const doc = parseKanban(source)
  if (!usableKanbanLabel(label) || doc.columns.length === 0) return null
  const text = label.trim()
  const position = Math.max(0, Math.min(at, doc.columns.length))
  const id = freshKanbanId(doc.lines)
  // The same indent as the column next to it, so a tab-indented or six-space
  // board does not gain a level.
  const indent = doc.lines[doc.columns[Math.min(position, doc.columns.length - 1)]!]?.indent ?? '  '
  const inner = kanbanInnerLabel(text)
  const header: KanbanLine = {
    text: `${id}[${inner}]`,
    indent,
    offset: 0,
    kind: 'column',
    label: text,
    labelStart: id.length + 1,
    labelEnd: id.length + 1 + inner.length,
  }

  const lines = doc.lines.slice()
  // Straight after the column it follows, cards and all, so it lands in the gap
  // the user was looking at rather than after that column's trailing comments.
  // Ahead of the first column means *before the first column*, never before the
  // `kanban` header, which is what makes the rest of the source a kanban at all.
  const insertAt = position === 0 ? doc.columns[0] : lastColumnLine(doc, position - 1) + 1
  lines.splice(insertAt, 0, header)
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
  if (header === undefined || doc.columns.length < 2) return null
  const doomed = new Set([header, ...doc.cards.filter((card) => card.column === column).map((card) => card.line)])
  const lines = doc.lines.filter((_, index) => !doomed.has(index))
  const next = rebuildKanban(lines)
  return next === source ? null : next
}

/** How many cards a column delete would take with it, for the prompt to say. */
export function kanbanColumnCardCount(source: string, column: number): number {
  return parseKanban(source).cards.filter((card) => card.column === column).length
}

// ── rendering ──────────────────────────────────────────────────────────────

export interface MermaidDiagramOptions {
  /** The `.mermaid` block that owns the preview, the zoom toolbar and the overlays. */
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
  /** Extra buttons for the hover toolbar, e.g. the edit-mode toggle. */
  actions?: readonly HTMLButtonElement[]
}

/**
 * Render `code` into `container` and, in edit mode, wire up visual editing.
 * Success replaces the container's contents wholesale (the editing layer is
 * re-attached); failure leaves the last good diagram in place behind a
 * transient notice, unless there is no diagram yet — then an error block stands
 * in for it.
 */
export async function renderDiagram(
  container: HTMLElement,
  code: string,
  options: MermaidDiagramOptions,
): Promise<void> {
  const { host, commit, actions = [] } = options
  const hadDiagram = container.querySelector('svg') !== null
  if (!hadDiagram) container.textContent = code
  try {
    const mermaid = await loadMermaid()
    const { svg } = await mermaid.render(`mermaid-diagram-${renderSeed++}`, code)
    container.innerHTML = svg
    const svgEl = container.querySelector<SVGSVGElement>('svg')
    if (!svgEl) return
    const natural = responsifySvg(svgEl)
    adaptDiagramColors(svgEl)
    pinSvgTextColors(svgEl)
    host.querySelector('.mermaid-toolbar')?.remove()
    attachMermaidToolbar(host, svgEl, natural, actions)
    // A baked diagram is a bitmap under an invisible vector, which would put
    // every native label out of reach while editing, so edit mode keeps the
    // live SVG on top instead.
    if (!commit) void bakeDiagram(host, svgEl, natural)
    if (commit) attachMermaidEditing(container, svgEl, code, commit)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (hadDiagram) {
      showNotice(host, NOTICE_TEXT, message)
    } else {
      container.innerHTML = ''
      container.appendChild(errorBlock(message))
    }
  }
}

function showNotice(host: HTMLElement, text: string, detail: string): void {
  host.querySelector(`.${NOTICE_CLASS}`)?.remove()
  const notice = document.createElement('div')
  notice.className = NOTICE_CLASS
  notice.textContent = text
  notice.title = detail
  host.appendChild(notice)
  setTimeout(() => notice.remove(), NOTICE_MS)
}

// ── inline label editing ───────────────────────────────────────────────────

/**
 * The editing layer of every rendered diagram, keyed by its host block. The
 * stored resolver finishes an open label editor (`accept`) and takes the layer
 * down; a block outlives individual renders, so a new render replaces it.
 */
const editingLayers = new WeakMap<HTMLElement, (accept: boolean) => void>()

/**
 * Take a diagram's editing layer down, optionally accepting the label edit in
 * progress. Leaving edit mode has to do this: the label input is a child of the
 * block, not of the container a render replaces, so a re-render alone leaves it
 * floating over a diagram that is no longer editable, still swallowing its own
 * events — and a value typed into it would patch a source snapshot that has
 * since moved on. `accept` is true when the user asked to *finish* (the Done
 * button, a double click, the menu item), so a half-typed label is committed
 * exactly as a click elsewhere would commit it; a plain re-render, whose source
 * may already have changed underneath the editor, cancels instead.
 */
export function finishMermaidLabelEditing(host: Node | null | undefined, accept = true): void {
  if (!(host instanceof HTMLElement)) return
  editingLayers.get(host)?.(accept)
  editingLayers.delete(host)
}

/**
 * Make a rendered diagram editable: click a label to retype it, and — for
 * kanban — drag cards between columns. Must be re-applied after every render,
 * since a render replaces the SVG wholesale.
 */
export function attachMermaidEditing(
  container: HTMLElement,
  svg: SVGSVGElement,
  source: string,
  commit: (source: string) => void,
): void {
  const host = container.closest<HTMLElement>('.mermaid') ?? container.parentElement ?? container
  // Disposes the previous layer; a block outlives individual renders. Cancels
  // any open editor: this render was not asked for by the one holding it.
  editingLayers.get(host)?.(false)
  const dispose: Array<() => void> = []
  const on = (target: EventTarget, type: string, handler: EventListener): void => {
    target.addEventListener(type, handler)
    dispose.push(() => target.removeEventListener(type, handler))
  }

  const family = diagramFamily(detectDiagramType(source))
  const targets = labelTargets(svg, family, source)
  for (const target of targets) target.el.classList.add(EDITABLE_CLASS)

  // One inline editor at a time. Opening another — a different label, a card
  // being dragged, a new card being named — drops the value being typed, the
  // same as Esc; the layer's own resolver hands the open one back when the
  // diagram stops being editable, so a new card's title commits or cancels with
  // every other edit.
  let closeEditor: ((accept: boolean) => void) | null = null
  const openEditor = (finish: (accept: boolean) => void): void => {
    closeEditor?.(false)
    closeEditor = finish
  }

  // Diagram glyphs are never natively draggable, and a press on a label must
  // not start a ProseMirror node selection underneath the click. `mousedown`
  // rather than `pointerdown`: canceling the pointer event would also suppress
  // the `click` the editor opens from.
  on(container, 'dragstart', (event) => event.preventDefault())
  on(container, 'mousedown', ((event: MouseEvent) => {
    if (event.button !== 0) return
    if (!labelTargetAt(event, targets) && !kanbanCardAt(event, svg, family)) return
    event.preventDefault()
    event.stopPropagation()
  }) as EventListener)

  on(container, 'click', ((event: MouseEvent) => {
    if (event.button !== 0) return
    const target = labelTargetAt(event, targets)
    if (!target) return
    openEditor(openLabelEditor(host, target, source, family, commit))
  }) as EventListener)

  if (family === 'kanban') {
    dispose.push(attachKanbanDrag(container, svg, source, commit, () => closeEditor?.(false)))
    dispose.push(attachKanbanButtons(container, svg, source, commit, () => closeEditor?.(false)))
  }

  editingLayers.set(host, (accept) => {
    closeEditor?.(accept)
    closeEditor = null
    for (const off of dispose.splice(0)) off()
    for (const target of targets) target.el.classList.remove(EDITABLE_CLASS)
  })
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

interface InlineInputSpec {
  /** The `.mermaid` block the field is appended to and positioned against. */
  host: HTMLElement
  /** Where to put it, in viewport coordinates (`getBoundingClientRect`). */
  rect: DOMRect
  value: string
  placeholder?: string
  /**
   * A short heading above the field — `New card in In Progress` for a card being
   * named, `Card in Todo` for one being renamed. The column name belongs in it
   * rather than in the placeholder because a placeholder is drawn *inside* the
   * field and disappears at the first keystroke, and because a title like that is
   * longer than the title it is asking for: in the field it has the whole width
   * and truncates in the middle of nothing, whereas in a 120px input it was cut
   * to `New card in In…` before the user had typed anything.
   */
  caption?: string
  /**
   * `new` reads as adding something rather than replacing what is there, and is
   * drawn as such: a dashed accent edge and an accent caption, so a field that is
   * about to *create* a card cannot be mistaken for one that is about to
   * overwrite one.
   */
  tone?: 'label' | 'new'
  /**
   * The field's own width when the box it is anchored to is narrower than a
   * legible title — a new card is typed from nothing, so it is given room.
   */
  minWidth?: number
  /**
   * Enter, or a blur. Return `true` when the caller is done with the input
   * either way, `false` to refuse the value quietly, and a string to refuse it
   * *and* say why in a notice — the way an unusable card title is refused. A
   * refused value is one the editor knows it cannot write down, so the reason
   * travels with it: the alternative is a card that silently fails to appear
   * and a notice about a diagram that refused to parse, neither of which tells
   * the user which of their own keystrokes to take back.
   */
  onAccept: (value: string) => boolean | string
  /** Esc, or a resolve from outside with `accept: false`. */
  onCancel: () => void
}

/**
 * The one-line input the editor edits a label with — and, for a new kanban card
 * or column, the one it is created with, so all three share the Enter/Esc/blur
 * conventions and the focus handling rather than growing three of each.
 *
 * An existing value is selected, so typing replaces it; an empty one is not,
 * since selecting nothing leaves the field looking selected-but-blank. The
 * returned function resolves the input from outside with `accept` deciding
 * whether the typed value is kept; the host calls it when the diagram stops
 * being editable.
 */
function openInlineInput(spec: InlineInputSpec): (accept: boolean) => void {
  const { host, rect, value, placeholder, caption, tone = 'label', onAccept, onCancel } = spec
  const origin = host.getBoundingClientRect()
  // A wrapper owns the geometry, so a caption and the input stay one box that can
  // be placed over a column and clipped to nothing: an absolutely positioned
  // child of a horizontal scroller is placed from the scrolled content, not from
  // the visible box, so the preview's own scroll has to be added back (`host` is
  // the block for a label, which never scrolls).
  const field = document.createElement('div')
  field.className = tone === 'new' ? `${FIELD_CLASS} ${FIELD_NEW_CLASS}` : FIELD_CLASS

  if (caption !== undefined) {
    const label = document.createElement('div')
    label.className = CAPTION_CLASS
    label.textContent = caption
    // The full text stays reachable on hover, so a column too long to show is
    // truncated rather than lost.
    label.title = caption
    field.appendChild(label)
  }

  const input = document.createElement('input')
  input.type = 'text'
  input.className = INPUT_CLASS
  input.value = value
  if (placeholder) input.placeholder = placeholder
  input.style.height = `${rect.height || 20}px`

  const width = Math.max(rect.width, spec.minWidth ?? 0, 40)
  field.style.left = `${rect.left - origin.left + host.scrollLeft}px`
  field.style.top = `${rect.top - origin.top}px`
  field.style.width = `${width}px`

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    // Not `.remove()`: a blur handler can fire while the field is being
    // detached, and `remove()` throws when the node no longer has a parent.
    field.parentNode?.removeChild(field)
  }
  const finish = (accept: boolean): void => {
    if (closed) return
    if (!accept) {
      onCancel()
      close()
      return
    }
    // A refused value flashes red and takes itself off: leaving the input open
    // would strand one the only way out of is Esc. A refusal that came with a
    // reason also says it, since the red flash alone leaves the user staring at
    // a card that did not appear.
    const refusal = onAccept(input.value.trim())
    if (refusal !== true) {
      input.classList.add(INVALID_CLASS)
      const why = typeof refusal === 'string' ? refusal : ''
      if (why) {
        const block = host.closest<HTMLElement>('.mermaid')
        if (block) showNotice(block, why, 'The diagram cannot be given that label.')
      }
      setTimeout(close, INVALID_FLASH_MS)
      return
    }
    close()
  }

  input.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key
    if (key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (key === 'Escape') {
      event.preventDefault()
      finish(false)
    }
    event.stopPropagation()
  })
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
  input.addEventListener('mousedown', (event) => event.preventDefault())
  input.addEventListener('blur', () => finish(true))
  // The field is a box over the diagram, so a click inside it must not be read as
  // a click on whatever label happens to lie underneath — which is how opening a
  // field over a card would otherwise close itself and open the card's rename.
  for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
    field.addEventListener(type, (event) => event.stopPropagation())
  }

  field.appendChild(input)
  host.appendChild(field)
  input.focus()
  if (value) input.select()
  return finish
}

/**
 * The label editor: `openInlineInput` seeded with the label being replaced. A
 * commit that cannot be mapped back to the source flashes the input red instead
 * of silently doing nothing.
 */
function openLabelEditor(
  host: HTMLElement,
  target: LabelTarget,
  source: string,
  family: DiagramFamily,
  commit: (source: string) => void,
): (accept: boolean) => void {
  // The input holds the source's spelling of the span being replaced, and an
  // unchanged value is a cancel. The mapper, though, resolves from the label
  // the user clicked: a requirement row is located by the row mermaid drew
  // (`Verification: Test`) and only its value is rewritten, so passing the
  // edited text instead would leave it nothing to find.
  const current = target.sourceText ?? target.text
  return openInlineInput({
    host,
    rect: target.el.getBoundingClientRect(),
    value: current,
    // A card's own box is sized for the card, so a short label would otherwise
    // be retyped in a field too narrow to see it in.
    minWidth: RENAME_FIELD_WIDTH,
    onAccept: (value) => {
      if (value === current) return true
      // A kanban label that cannot be written at all is refused here rather
      // than committed: the patch would land, mermaid would refuse the source,
      // and the board would sit on its last good render with the label the user
      // just typed on no screen anywhere.
      if (family === 'kanban' && !usableKanbanLabel(value)) {
        return kanbanLabelRefusal(value)
      }
      const outcome = patchLabel(source, family, target.text, value, target)
      if (outcome.status === 'ok') {
        commit(outcome.text)
        return true
      }
      return outcome.status === 'ambiguous'
    },
    onCancel: () => undefined,
  })
}

// ── kanban drag ────────────────────────────────────────────────────────────

/**
 * Drag a card into another column, or to another spot in its own. Cards are
 * laid out in source order, so a card's index in the DOM is its index in
 * `parseKanban`'s card list — no reliance on mermaid's sanitised element ids.
 *
 * The gesture arms on press and starts on the first movement past
 * `DRAG_THRESHOLD`, so a press-and-release on a card title still reaches the
 * label editor, and nothing is canceled on the press itself (canceling the
 * pointer press would take the `click` with it).
 */
function attachKanbanDrag(
  container: HTMLElement,
  svg: SVGSVGElement,
  source: string,
  commit: (source: string) => void,
  closeEditor: () => void,
): () => void {
  const onPointerDown = (event: Event): void => {
    const down = event as PointerEvent
    if (down.button !== 0) return
    const cards = cardElements(svg)
    const sections = sectionElements(svg)
    const card = cardAt(down, cards)
    if (!card) return
    const doc = parseKanban(source)
    // A model that does not line up with the DOM would mis-attribute the move.
    if (doc.cards.length !== cards.length || doc.columns.length !== sections.length) return
    closeEditor()
    armDrag({ container, svg, source, doc, cards, sections, from: cards.indexOf(card), down, commit })
  }
  // Cancelling dragstart keeps the browser's own SVG drag (which swallows the
  // pointer stream) from ever starting; preventing pointerdown instead would
  // also kill the click that opens a card's label editor.
  const onDragStart = (event: Event): void => event.preventDefault()
  container.addEventListener('pointerdown', onPointerDown as EventListener)
  container.addEventListener('dragstart', onDragStart)
  return () => {
    container.removeEventListener('pointerdown', onPointerDown as EventListener)
    container.removeEventListener('dragstart', onDragStart)
  }
}

interface ArmedDrag {
  container: HTMLElement
  svg: SVGSVGElement
  source: string
  doc: KanbanDoc
  cards: SVGElement[]
  sections: SVGElement[]
  from: number
  down: PointerEvent
  commit: (source: string) => void
}

function cardAt(event: MouseEvent, cards: SVGElement[]): SVGElement | null {
  const el = event.target
  if (el instanceof Element) {
    const direct = el.closest<SVGElement>('.items > .node')
    if (direct && cards.includes(direct)) return direct
  }
  return hitTest(event, cards, (card) => card.getBoundingClientRect())
}

/** The kanban card under the pointer, if this diagram has cards to drag. */
function kanbanCardAt(event: MouseEvent, svg: SVGSVGElement, family: DiagramFamily): SVGElement | null {
  return family === 'kanban' ? cardAt(event, cardElements(svg)) : null
}

function armDrag(drag: ArmedDrag): void {
  const { container, svg, source, doc, cards, sections, from, down, commit } = drag
  const card = cards[from]
  // The drag only ever *appends* to the transform mermaid gave the card, so
  // putting it back is restoring a string rather than recomputing a position.
  const baseTransform = card.getAttribute('transform')
  const map = svgMapping(svg)
  const sectionAt = (event: MouseEvent): SVGElement | null => hitTest(event, sections, sectionRect)

  let lifted = false
  let line: SVGLineElement | null = null
  let over: SVGElement | null = null
  // Where the card sat in `.items`, so the paint order can be undone too: SVG
  // paints in document order, and every card is one long list of siblings, so
  // the dragged card has to become the last of them to be *on top* of the board
  // it is passing over. The model→element mapping is the captured `cards` array,
  // which re-appending does not disturb — but a fresh `cardElements()` walk
  // would, so the original order is restored on the way out.
  const parent = card.parentNode
  const follower = card.nextSibling

  const stop = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    if (lifted) {
      if (baseTransform === null) card.removeAttribute('transform')
      else card.setAttribute('transform', baseTransform)
      card.classList.remove(DRAG_CARD_CLASS)
      container.classList.remove(DRAG_CONTAINER_CLASS)
      if (parent) parent.insertBefore(card, follower)
    }
    line?.remove()
    line = null
    over?.classList.remove(DROP_TARGET_CLASS)
    over = null
  }

  const onMove = (event: Event): void => {
    const pointer = event as PointerEvent
    if (!lifted) {
      if (Math.hypot(pointer.clientX - down.clientX, pointer.clientY - down.clientY) < DRAG_THRESHOLD) return
      lifted = true
      card.classList.add(DRAG_CARD_CLASS)
      container.classList.add(DRAG_CONTAINER_CLASS)
      parent?.appendChild(card)
      line = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('class', DROP_LINE_CLASS)
      // Into the svg, ahead of the cards: the indicator is a hint about the slot
      // the card will drop into, and the card being dragged is the subject, so
      // every card paints over the line. An overlay in the preview cannot do
      // this — a positioned child of the preview paints above the whole svg.
      svg.insertBefore(line, svg.querySelector('.items'))
    }
    // The drag is ours now, so no text selection or native drag should follow.
    pointer.preventDefault()
    // The card *is* the thing under the pointer: no clone, no second copy of
    // it on screen, and the gap it leaves behind is the only record of where
    // it came from. The offset is divided back into the viewBox's own units, so
    // it tracks the pointer by a pixel whatever the board is scaled to.
    const dx = (pointer.clientX - down.clientX) / map.scaleX
    const dy = (pointer.clientY - down.clientY) / map.scaleY
    card.setAttribute(
      'transform',
      `${baseTransform ?? ''} translate(${dx}, ${dy}) scale(${DRAG_LIFT_SCALE})`.trim(),
    )
    const next = sectionAt(pointer)
    if (next !== over) {
      over?.classList.remove(DROP_TARGET_CLASS)
      over = next
      over?.classList.add(DROP_TARGET_CLASS)
    }
    placeDropLine(pointer, next)
  }

  const onUp = (event: Event): void => {
    const pointer = event as PointerEvent
    const dragged = lifted
    const target = dragged ? sectionAt(pointer) : null
    const column = target ? sections.indexOf(target) : -1
    const index = dragged && column >= 0 ? dropIndex(pointer, doc, cards, from, column) : -1
    stop()
    if (column < 0) return
    const next = moveKanbanCard(source, from, column, index)
    if (next !== null) commit(next)
  }

  const onCancel = (): void => stop()

  /**
   * Put the line where a release would drop the card. It is placed on every
   * move rather than only on the target changing, because the *index* changes
   * within one column all the time, and that index is the thing the user cannot
   * see: a card over a three-card column is going to the first, second or third
   * slot, and nothing about the column outline says which.
   */
  const placeDropLine = (pointer: PointerEvent, target: SVGElement | null): void => {
    if (!line) return
    if (!target) {
      // Off every column there is nowhere to land, so nothing is promised: the
      // line going away is the answer, and a release here does nothing.
      line.style.display = 'none'
      return
    }
    const column = sections.indexOf(target)
    const siblings = doc.cards.flatMap((card, position) =>
      card.column === column && position !== from ? [cards[position].getBoundingClientRect()] : [],
    )
    const at = dropLineAt(siblings, dropIndex(pointer, doc, cards, from, column), sectionRect(target))
    // The line is an svg child, so it is placed in the drawing's own units —
    // which also means a scrolled or zoomed preview needs no correction here.
    const start = user(at.x, at.y)
    const end = user(at.x + at.width, at.y)
    line.style.display = ''
    line.setAttribute('x1', `${start.x}`)
    line.setAttribute('y1', `${start.y}`)
    line.setAttribute('x2', `${end.x}`)
    line.setAttribute('y2', `${end.y}`)
  }

  /** A point of the board in viewport px, in the drawing's own user units. */
  const user = (x: number, y: number): { x: number; y: number } => ({
    x: map.x + (x - map.rect.left) / map.scaleX,
    y: map.y + (y - map.rect.top) / map.scaleY,
  })

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
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
 * on. `siblings` are the target column's *other* cards, in board order, which is
 * what makes the dragged card's own slot count as a gap rather than a neighbour.
 */
function dropLineAt(siblings: DOMRect[], index: number, section: DOMRect): DropLine {
  const x = section.left - DROP_LINE_OVERHANG
  const width = section.width + DROP_LINE_OVERHANG * 2
  if (siblings.length === 0) {
    // Nothing to slot between, and an empty column's band is sized to its
    // header alone, so the middle of the band is where the card will appear.
    return { x, y: section.top + section.height / 2, width }
  }
  const first = siblings[0]
  const last = siblings[siblings.length - 1]
  const y =
    index <= 0
      ? first.top - DROP_LINE_GAP
      : index >= siblings.length
        ? last.bottom + DROP_LINE_GAP
        : (siblings[index - 1].bottom + siblings[index].top) / 2
  return { x, y, width }
}

/**
 * Where a card lands inside a column: the number of that column's other cards
 * whose middle sits above the pointer, i.e. the insertion index as if the
 * dragged card were already lifted out of the list.
 */
function dropIndex(event: PointerEvent, doc: KanbanDoc, cards: SVGElement[], from: number, column: number): number {
  let index = 0
  doc.cards.forEach((card, position) => {
    if (position === from || card.column !== column) return
    const rect = cards[position].getBoundingClientRect()
    if (rect.top + rect.height / 2 < event.clientY) index += 1
  })
  return index
}

// ── kanban board buttons ───────────────────────────────────────────────────

/**
 * The board's own controls in edit mode: a ＋ that names a new card at the bottom
 * of every column, and — in the top-right corner of every card and every column —
 * a ✕ to delete it and a ＋ to add a column after it. The card ＋ is at the
 * bottom because that is where a new card will appear, and the corner buttons
 * are in the corner because a card's own box has no room for a row of them.
 *
 * They are HTML in the preview rather than `foreignObject`s inside mermaid's own
 * layout: a view-mode diagram is a baked bitmap, which cannot host them, and an
 * overlay is rebuilt from the rendered sections on every render anyway. Their
 * geometry is the card or section rect minus the preview's — the same arithmetic
 * the drag's drop line used to need — recomputed after each render and on every
 * `ResizeObserver` tick, which is what covers the zoom toolbar (it sets
 * `svg.style.width`), a window resize and a theme change in one hook. A
 * `foreignObject` inside the section is the fallback if the overlay ever proves
 * stubborn, but it could only be used in edit mode for the same reason.
 */
function attachKanbanButtons(
  container: HTMLElement,
  svg: SVGSVGElement,
  source: string,
  commit: (source: string) => void,
  openEditor: (finish: (accept: boolean) => void) => void,
): () => void {
  const sections = sectionElements(svg)
  const cards = cardElements(svg)
  const doc = parseKanban(source)
  // A model that does not line up with the DOM would put a card in a column the
  // user did not press, or delete a neighbour of the one they pressed, and there
  // is no rendering to compare against.
  if (doc.columns.length === 0 || doc.columns.length !== sections.length || doc.cards.length !== cards.length) {
    return () => undefined
  }

  const columnName = (column: number): string => doc.lines[doc.columns[column]]?.label ?? 'this column'
  const cardsIn = (column: number): number => doc.cards.filter((card) => card.column === column).length
  const placed: Array<{ button: HTMLButtonElement; point: () => { x: number; y: number } }> = []

  /**
   * One board button, with the event guards every one of them needs: a press
   * must not reach ProseMirror (it would start a node selection), the drag (it
   * hit-tests cards by coordinate and would arm over a card a button sits on) or
   * the click that opens a label's editor.
   */
  const button = (
    kind: string,
    glyph: string,
    label: string,
    point: () => { x: number; y: number },
    onClick: () => void,
  ): void => {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = `${KANBAN_BUTTON_CLASS} ${kind}`
    element.textContent = glyph
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
    container.appendChild(element)
    placed.push({ button: element, point })
  }

  // A delete is confirmed before it is applied, so the source is patched only
  // once the answer comes back — and the answer is what a dialog is for, since a
  // card is one keystroke from a rename and the board is the user's document.
  const confirmDelete = (next: string | null, subject: string, consequence: string): void => {
    void promptForKanbanDelete(subject, consequence).then((confirmed) => {
      if (confirmed && next !== null) commit(next)
    })
  }

  sections.forEach((section, column) => {
    const name = columnName(column)
    // Card identity here is positional: a new card goes on the end of its
    // column, and every later edit re-derives the model from the source.
    // Registered with the layer, so Done (or a re-render) resolves it exactly as
    // it resolves a label being retyped.
    button(ADD_BUTTON_CLASS, '＋', `Add a card to ${name}`, () => addButtonPoint(section), () =>
      openEditor(
        openInlineInput({
          host: container,
          rect: cardTitleRect(section),
          value: '',
          caption: `New card in ${name}`,
          placeholder: 'Card title',
          tone: 'new',
          onAccept: (value) => {
            const next = addKanbanCard(source, column, cardsIn(column), value)
            if (next === null) return kanbanLabelRefusal(value)
            commit(next)
            return true
          },
          onCancel: () => undefined,
        }),
      ),
    )
    button(
      COLUMN_ADD_BUTTON_CLASS,
      '＋',
      `Add a column after ${name}`,
      () => cornerPoint(sectionRect(section), KANBAN_BUTTON_HALF * 2),
      () =>
        openEditor(
          openInlineInput({
            host: container,
            rect: columnTitleRect(section),
            value: '',
            caption: `New column after ${name}`,
            placeholder: 'Column name',
            tone: 'new',
            onAccept: (value) => {
              const next = addKanbanColumn(source, column + 1, value)
              if (next === null) return kanbanLabelRefusal(value)
              commit(next)
              return true
            },
            onCancel: () => undefined,
          }),
        ),
    )
    // A board keeps at least one column, so a board of one is not offered the
    // delete that would leave nothing behind: what cannot be done is not on the
    // board. `removeKanbanColumn` refuses it as well.
    if (doc.columns.length > 1) {
      const taken = cardsIn(column)
      button(
        COLUMN_REMOVE_BUTTON_CLASS,
        '✕',
        `Delete the ${name} column`,
        () => cornerPoint(sectionRect(section), KANBAN_BUTTON_HALF * 2, KANBAN_BUTTON_HALF * 2 + KANBAN_BUTTON_GAP),
        () =>
          confirmDelete(
            removeKanbanColumn(source, column),
            `the ${name} column`,
            taken === 0 ? 'The column is removed from the board.' : `Its ${taken} card${taken === 1 ? '' : 's'} go with it.`,
          ),
      )
    }
  })

  cards.forEach((_, index) => {
    const entry = doc.cards[index]
    if (entry.column < 0) return
    const name = entry.label ?? 'this card'
    const column = columnName(entry.column)
    button(
      CARD_REMOVE_BUTTON_CLASS,
      '✕',
      `Delete the card ${name}`,
      () => cornerPoint(cards[index].getBoundingClientRect(), REMOVE_BUTTON_HALF * 2),
      () =>
        confirmDelete(
          removeKanbanCard(source, index),
          `“${name}”`,
          `It is removed from the ${column} column.`,
        ),
    )
  })

  const place = (): void => {
    const base = container.getBoundingClientRect()
    for (const { button: element, point } of placed) {
      const at = point()
      // `scrollLeft` because the preview is a horizontal scroller: an absolute
      // child is placed from the scrolled content, not from the visible box.
      element.style.left = `${at.x - base.left + container.scrollLeft}px`
      element.style.top = `${at.y - base.top}px`
    }
  }
  place()
  const observer = new ResizeObserver(place)
  observer.observe(svg)

  return () => {
    observer.disconnect()
    for (const { button: element } of placed) element.remove()
  }
}

/** The ＋'s centre: the bottom of the column band, horizontally centred. */
function addButtonPoint(section: SVGElement): { x: number; y: number } {
  const rect = sectionRect(section)
  return { x: rect.left + rect.width / 2, y: rect.bottom - KANBAN_BUTTON_HALF }
}

/**
 * The centre of a `size`-wide button in the top-right corner of `rect`, or that
 * same corner `shift` px further along — which is how a column's two header
 * buttons sit side by side instead of on top of each other.
 */
function cornerPoint(rect: DOMRect, size: number, shift = 0): { x: number; y: number } {
  const inset = size / 2
  return { x: rect.right - KANBAN_BUTTON_EDGE - inset - shift, y: rect.top + KANBAN_BUTTON_EDGE + inset }
}

/** Where a new card's title is typed: over its column, just above the ＋. */
function cardTitleRect(section: SVGElement): DOMRect {
  const point = addButtonPoint(section)
  const top = point.y - KANBAN_BUTTON_HALF - NEW_FIELD_LIFT - NEW_FIELD_HEIGHT
  return new DOMRect(point.x - NEW_FIELD_WIDTH / 2, top, NEW_FIELD_WIDTH, NEW_FIELD_HEIGHT)
}

/** Where a new column's name is typed: over the middle of the band it joins. */
function columnTitleRect(section: SVGElement): DOMRect {
  const rect = sectionRect(section)
  return new DOMRect(
    rect.left + rect.width / 2 - NEW_FIELD_WIDTH / 2,
    rect.top + rect.height / 2 - NEW_FIELD_HEIGHT / 2,
    NEW_FIELD_WIDTH,
    NEW_FIELD_HEIGHT,
  )
}
