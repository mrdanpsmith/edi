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

// ── classes and timings ────────────────────────────────────────────────────

const EDITABLE_CLASS = 'mermaid-editables'
const INPUT_CLASS = 'mermaid-edit-input'
const INVALID_CLASS = 'mermaid-edit-invalid'
const NOTICE_CLASS = 'mermaid-edit-notice'
const NOTICE_TEXT = "Couldn't parse diagram — keeping the previous version"
const NOTICE_MS = 3000
const INVALID_FLASH_MS = 700
const DRAG_CLONE_CLASS = 'mermaid-drag-card'
const DRAG_SOURCE_CLASS = 'mermaid-drag-source'
const DROP_TARGET_CLASS = 'kanban-drop-target'

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

/** Diagram families whose labels map onto a known source construct. */
export type DiagramFamily = 'graph' | 'sequence' | 'kanban' | 'generic'

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

interface LabelTarget {
  el: Element
  text: string
}

/**
 * Every label of a rendered diagram that can be mapped back to source text.
 * Mermaid emits HTML labels inside `foreignObject` (the default) and native
 * `<text>` (sequence, gantt, pie, …); both are elements whose rect the overlay
 * is positioned from, so both are collected.
 */
function labelTargets(svg: SVGSVGElement, family: DiagramFamily): LabelTarget[] {
  const targets: LabelTarget[] = []
  if (family === 'kanban') {
    // Kanban renders three label slots per card (title, spacer, assignee) and
    // only the first is the card's own text; a section's label is its header.
    for (const section of sectionElements(svg)) {
      const label = labelElementIn(section.querySelector('.cluster-label') ?? section)
      const text = label && labelTextOf(label)
      if (label && text) targets.push({ el: label, text })
    }
    for (const card of cardElements(svg)) {
      const label = labelElementIn(card)
      const text = label && labelTextOf(label)
      if (label && text) targets.push({ el: label, text })
    }
    return targets
  }

  for (const el of Array.from(svg.querySelectorAll(LABEL_SELECTOR))) {
    if (el.closest(GENERATED_LABEL_SELECTOR)) continue
    const text = labelTextOf(el)
    if (text) targets.push({ el, text })
  }
  return outermost(targets)
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
}

const NO_SPANS: MapperResult = { spans: [] }

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

/** Whole-word occurrences of `word` in the first `limit` characters of a line. */
function wholeWordSpans(line: SourceLine, word: string, limit: number): Span[] {
  const spans: Span[] = []
  // A participant id is delimited by punctuation, so an id followed by an arrow
  // (`Alice->>S`) matches while a hyphenated one (`my-actor`) never matches
  // half of itself.
  const re = new RegExp(`(?<![-\\w])${escapeRe(word)}(?!\\w)(?![-]\\w)`, 'g')
  for (let match = re.exec(line.text); match && match.index < limit; match = re.exec(line.text)) {
    spans.push({ start: line.offset + match.index, end: line.offset + match.index + word.length })
  }
  return spans
}

function kanbanSpans(source: string, label: string): MapperResult {
  const spans: Span[] = []
  for (const line of parseKanban(source).lines) {
    if (line.kind !== 'column' && line.kind !== 'card') continue
    if (line.label !== label) continue
    spans.push({ start: line.labelStart, end: line.labelEnd })
  }
  return { spans }
}

/** Every standalone occurrence of the label anywhere in the source. */
function substringSpans(source: string, label: string): Span[] {
  const spans: Span[] = []
  for (let at = source.indexOf(label); at >= 0; at = source.indexOf(label, at + label.length)) {
    spans.push({ start: at, end: at + label.length })
  }
  return spans
}

export type PatchOutcome =
  | { status: 'ok'; text: string }
  /** The label occurs more than once and no mapper can tell the copies apart. */
  | { status: 'ambiguous' }
  | { status: 'unmapped' }

/**
 * Resolve a label edit to a new mermaid source, or explain why it cannot be
 * applied. A type-aware mapper that recognises the construct produces the exact
 * source range; otherwise the rendered text is replaced where it occurs exactly
 * once, which is what makes pie/er/class/state/gantt labels editable without a
 * mapper each. A label that occurs more than once is never guessed at.
 */
export function patchLabel(
  source: string,
  family: DiagramFamily,
  oldLabel: string,
  newLabel: string,
): PatchOutcome {
  if (!oldLabel) return { status: 'unmapped' }
  const mapped =
    family === 'graph'
      ? mergeSpans(graphNodeSpans(source, oldLabel), graphEdgeSpans(source, oldLabel))
      : family === 'sequence'
        ? sequenceSpans(source, oldLabel)
        : family === 'kanban'
          ? kanbanSpans(source, oldLabel)
          : NO_SPANS

  if (mapped.all || mapped.spans.length === 1) {
    return { status: 'ok', text: replaceSpans(source, mapped.spans, newLabel) }
  }
  if (mapped.spans.length > 1) return { status: 'ambiguous' }

  const spans = substringSpans(source, oldLabel)
  if (spans.length === 1) return { status: 'ok', text: replaceSpans(source, spans, newLabel) }
  if (spans.length > 1) return { status: 'ambiguous' }
  return { status: 'unmapped' }
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
 */
function kanbanLabelSpan(body: string): Span | null {
  const metadata = KANBAN_METADATA.exec(body)
  const head = metadata ? body.slice(0, metadata.index) : body
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
  return end < start ? null : { start, end }
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
    const line: KanbanLine = {
      text: raw.text,
      indent: raw.indent,
      offset: raw.offset,
      kind: 'card',
      label: span ? body.slice(span.start, span.end) : null,
      labelStart: span ? start : raw.labelStart,
      labelEnd: span ? start + body.slice(span.start, span.end).length : raw.labelEnd,
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

/** Disposes the previous editing layer; a container outlives individual renders. */
const editingLayers = new WeakMap<HTMLElement, () => void>()

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
  editingLayers.get(container)?.()
  const dispose: Array<() => void> = []
  const on = (target: EventTarget, type: string, handler: EventListener): void => {
    target.addEventListener(type, handler)
    dispose.push(() => target.removeEventListener(type, handler))
  }

  const family = diagramFamily(detectDiagramType(source))
  const targets = labelTargets(svg, family)
  for (const target of targets) target.el.classList.add(EDITABLE_CLASS)

  const host = container.closest<HTMLElement>('.mermaid') ?? container.parentElement ?? container
  let closeEditor: (() => void) | null = null

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
    closeEditor?.()
    closeEditor = openLabelEditor(host, target, source, family, commit)
  }) as EventListener)

  if (family === 'kanban') {
    dispose.push(attachKanbanDrag(container, svg, source, commit, () => closeEditor?.()))
  }

  editingLayers.set(container, () => {
    closeEditor?.()
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

/**
 * The in-place editor: one input over the clicked label. `Enter` commits, `Esc`
 * cancels, blur commits — the same conventions as the URL dialogs elsewhere in
 * the app. A commit that cannot be mapped back to the source flashes the input
 * red instead of silently doing nothing.
 */
function openLabelEditor(
  host: HTMLElement,
  target: LabelTarget,
  source: string,
  family: DiagramFamily,
  commit: (source: string) => void,
): () => void {
  const rect = target.el.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  const input = document.createElement('input')
  input.type = 'text'
  input.className = INPUT_CLASS
  input.value = target.text
  input.style.left = `${rect.left - hostRect.left}px`
  input.style.top = `${rect.top - hostRect.top}px`
  input.style.width = `${Math.max(rect.width, 40)}px`
  input.style.height = `${rect.height || 20}px`

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    // Not `input.remove()`: a blur handler can fire while the input is being
    // detached, and `remove()` throws when the node no longer has a parent.
    input.parentNode?.removeChild(input)
  }
  const finish = (accept: boolean): void => {
    if (closed) return
    const value = input.value.trim()
    if (!accept || value === target.text) {
      close()
      return
    }
    const outcome = patchLabel(source, family, target.text, value)
    if (outcome.status === 'ok') {
      close()
      commit(outcome.text)
      return
    }
    if (outcome.status === 'ambiguous') {
      input.classList.add(INVALID_CLASS)
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

  host.appendChild(input)
  input.focus()
  input.select()
  return close
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
    armDrag({ container, source, doc, cards, sections, from: cards.indexOf(card), down, commit })
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
  const { container, source, doc, cards, sections, from, down, commit } = drag
  const card = cards[from]
  const host = container.closest<HTMLElement>('.mermaid') ?? container.parentElement ?? container
  const cardRect = card.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  const sectionAt = (event: MouseEvent): SVGElement | null => hitTest(event, sections, sectionRect)

  let clone: HTMLElement | null = null
  let over: SVGElement | null = null

  const stop = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    clone?.remove()
    clone = null
    over?.classList.remove(DROP_TARGET_CLASS)
    over = null
    card.classList.remove(DRAG_SOURCE_CLASS)
    container.classList.remove(DRAG_SOURCE_CLASS)
  }

  const onMove = (event: Event): void => {
    const pointer = event as PointerEvent
    if (!clone) {
      if (Math.hypot(pointer.clientX - down.clientX, pointer.clientY - down.clientY) < DRAG_THRESHOLD) return
      clone = document.createElement('div')
      clone.className = DRAG_CLONE_CLASS
      clone.style.width = `${cardRect.width}px`
      clone.style.height = `${cardRect.height}px`
      clone.textContent = doc.cards[from]?.label ?? ''
      host.appendChild(clone)
      card.classList.add(DRAG_SOURCE_CLASS)
      container.classList.add(DRAG_SOURCE_CLASS)
    }
    // The drag is ours now, so no text selection or native drag should follow.
    pointer.preventDefault()
    clone.style.left = `${cardRect.left - hostRect.left + (pointer.clientX - down.clientX)}px`
    clone.style.top = `${cardRect.top - hostRect.top + (pointer.clientY - down.clientY)}px`
    const next = sectionAt(pointer)
    if (next === over) return
    over?.classList.remove(DROP_TARGET_CLASS)
    over = next
    over?.classList.add(DROP_TARGET_CLASS)
  }

  const onUp = (event: Event): void => {
    const pointer = event as PointerEvent
    const dragged = clone !== null
    const target = dragged ? sectionAt(pointer) : null
    const column = target ? sections.indexOf(target) : -1
    const index = dragged && column >= 0 ? dropIndex(pointer, doc, cards, from, column) : -1
    stop()
    if (column < 0) return
    const next = moveKanbanCard(source, from, column, index)
    if (next !== null) commit(next)
  }

  const onCancel = (): void => stop()

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
