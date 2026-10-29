import {
  parseKanban,
  kanbanInnerLabel,
  kanbanQuotedLabel,
  isKanbanCardSlot,
  isKanbanColumnSlot,
} from './kanban-model'
import type { KanbanDoc, KanbanSlots } from './kanban-model'
import {
  bandHeaderIn,
  cardElements,
  labelElementIn,
  labelElements,
  labelRole,
  labelTextOf,
  sectionElements,
  type DiagramFamily,
  type LabelRole,
} from './mermaid-dom'
export type { DiagramFamily } from './mermaid-dom'
export { cardElements, labelElementIn, sectionElements }

interface Span {
  start: number
  end: number
  /**
   * For a label drawn inside emphasis markers (`[**Bold**]`): the span above is
   * the text the user edits, `marks` the markers kept around it, and `outer` the
   * whole label they are written back over — quoted as one, so a title that
   * needs quotes becomes `["**Fix (bug)**"]`, not `[**"Fix (bug)"**]`.
   */
  marks?: string
  outer?: { start: number; end: number }
}

export function diagramFamily(type: string): DiagramFamily {
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

/** Everything a mapper needs about a rendered label, minus the DOM. */
export interface LabelRef {
  text: string
  role: LabelRole
  /** Which copy of a repeated label this is, in DOM order. */
  occurrence: number
  /** How many labels in this diagram share the same text. */
  count: number
}

export interface LabelTarget extends LabelRef {
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
 * Every label of a rendered diagram that can be mapped back to source text.
 * Mermaid emits HTML labels inside `foreignObject` (the default) and native
 * `<text>` (sequence, gantt, pie, …); both are elements whose rect the overlay
 * is positioned from, so both are collected.
 *
 * A label is only collected when the same mapper that patches it can find a
 * source range for it right now: a diagram must never show a label as editable
 * and then fail the edit.
 */
export function labelTargets(svg: SVGSVGElement, family: DiagramFamily, source: string): LabelTarget[] {
  const targets: LabelTarget[] = []
  if (family === 'kanban') {
    // Kanban renders three label slots per card (title, spacer, assignee) and
    // only the first is the card's own text; a section's label is its header.
    //
    // The targets are put in **source line order**, not drawing order (all
    // headers, then all cards): `pickCopy` pairs the k-th drawn copy of a text
    // with the k-th in the source, so a column and a card sharing a label
    // would otherwise each rename the other.
    const doc = parseKanban(source)
    const ordered: Array<{ line: number; target: LabelTarget }> = []
    sectionElements(svg).forEach((section, index) => {
      const label = labelElementIn(bandHeaderIn(section) ?? section)
      const text = label && labelTextOf(label)
      if (label && text) {
        ordered.push({ line: doc.columns[index] ?? Infinity, target: { el: label, text, role: 'text', occurrence: 0, count: 1 } })
      }
    })
    cardElements(svg).forEach((card, index) => {
      const label = labelElementIn(card)
      const text = label && labelTextOf(label)
      if (label && text) {
        ordered.push({ line: doc.cards[index]?.line ?? Infinity, target: { el: label, text, role: 'text', occurrence: 0, count: 1 } })
      }
    })
    ordered.sort((a, b) => a.line - b.line)
    targets.push(...ordered.map((entry) => entry.target))
    return editable(indexTargets(targets), family, source)
  }

  for (const el of labelElements(svg, family)) {
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

export function kanbanSlotElements(
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

// ── mapping a label back onto the source text ──────────────────────────────

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceSpans(source: string, spans: Span[], next: (span: Span) => string): string {
  let out = ''
  let cursor = 0
  for (const span of spans) {
    const range = span.outer ?? span
    out += source.slice(cursor, range.start) + next(span)
    cursor = range.end
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
  render?: (newLabel: string, span: Span) => string
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

/** Characters that end or reshape a bare flowchart label (`A[x]`, `-->|x|`). */
const GRAPH_LABEL_SYNTAX = /[[\](){}<>|"#;]/

/**
 * A flowchart label as source. A label already written in quotes keeps them;
 * a bare one is quoted only when it holds shape or edge syntax, so `Fix (bug)`
 * becomes `"Fix (bug)"` rather than closing its own node. Inside quotes a `"`
 * is mermaid's `#quot;` entity.
 */
function graphLabel(label: string, quoted: boolean): string {
  const escaped = label.replace(/"/g, '#quot;')
  if (quoted) return escaped
  return GRAPH_LABEL_SYNTAX.test(label) || label !== label.trim() ? `"${escaped}"` : label
}

/** A rename the flowchart grammar cannot write: an empty label (`A[]`). */
export function graphLabelRefusal(value: string): string | null {
  return value.trim() === '' ? 'A label cannot be empty' : null
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
      spans.push({
        start: line.labelStart + innerOffset,
        end: line.labelEnd - innerOffset,
        marks: marks[1],
        outer: { start: line.labelStart, end: line.labelEnd },
      })
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
      return {
        ...mergeSpans(graphNodeSpans(source, ref.text), graphEdgeSpans(source, ref.text)),
        render: (label, span) => graphLabel(label, source[span.start - 1] === '"' && source[span.end] === '"'),
      }
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
  const next = (span: Span): string => {
    const label = span.marks ? `${span.marks}${newLabel}${span.marks}` : newLabel
    return resolved.render?.(label, span) ?? label
  }
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

