/**
 * Pure kanban model — string-in/string-out functions with no DOM dependency.
 * Extracted from `src/mermaid-edit.ts`.
 */

export interface Span {
  start: number
  end: number
}

// ── Diagram-type detection ───────────────────────────────────────────────────
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
export const KANBAN_QUOTE_CHARS = /[[\](){}@>"&]/

/**
 * The text to write *inside* a `[…]`'s delimiters. Mermaid's kanban grammar
 * takes a quoted label and draws it without the quotes, so `["Fix (bug)"]` is
 * the text `Fix (bug)` on the board and in the label editor — the quotes are a
 * source-level spelling detail, never part of what the user typed. One function
 * for all three writers (a new card, a new column, a rename) so a label cannot
 * be writable one way and not the other.
 */
export function kanbanInnerLabel(text: string): string {
  return KANBAN_QUOTE_CHARS.test(text) ? kanbanQuotedLabel(text) : text
}

/** A label whose source already carries quotes keeps them across a rename. */
export function kanbanQuotedLabel(text: string): string {
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
// and only the drawn slot carries an id nothing else on a board would. It is
// spelled so no one would write it: a card of the user's own with a slot id
// is read as a slot, and dropped or rewritten on the next edit (`slotc3`, the
// old spelling, is an id a person could easily give a card).
const SLOT_ID = /^__edi_slot_[cn]\d*$/
export const isSlotId = (id: string): boolean => SLOT_ID.test(id)

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
  const cardSlot = (id: number): string => `${cardIndent}__edi_slot_c${id}[${KANBAN_CARD_SLOT}]`
  const columnSlot = (): string => `${columnIndent}__edi_slot_n[${KANBAN_COLUMN_SLOT}]`

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
export function isKanbanCardSlot(card: KanbanCard, doc: KanbanDoc): boolean {
  return card.label === KANBAN_CARD_SLOT && isSlotId(kanbanNodeId(doc.lines[card.line].text))
}

/** Whether a column in the drawn model is the board's own slot column. */
export function isKanbanColumnSlot(column: number, doc: KanbanDoc): boolean {
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


/**
 * A node's own id, or `''` for a bare label (which *is* the id). The id is what
 * ties a card to the column above it, and it is the one thing a new column has
 * to bring: nothing in mermaid's kanban depends on the ids being consecutive or
 * ordered, so a fresh one is enough to insert a column anywhere on the board.
 */
export function kanbanNodeId(text: string): string {
  return /^(\S*?)\s*(?:[[({>]|")/.exec(text)?.[1] ?? ''
}

/** An id nothing else on the board already uses, so a new column is its own. */
export function freshKanbanId(lines: readonly KanbanLine[]): string {
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
 * What a card or column *is*, independent of where it is drawn: its source line,
 * and which copy of that line it is when the board repeats one.
 *
 * A press is read off the board on screen, but its edit is applied to the source
 * as it is when the edit lands — after a confirmation, an undo under the prompt,
 * or a previous drag whose re-render has not arrived. An index from the drawing
 * would by then name a different card. A key is looked up again in that source,
 * and finds nothing (so the edit is dropped) when the item is gone.
 */
export interface KanbanItemKey {
  kind: 'card' | 'column'
  text: string
  copy: number
}

function itemLines(doc: KanbanDoc, kind: KanbanItemKey['kind']): number[] {
  return kind === 'card' ? doc.cards.map((card) => card.line) : doc.columns
}

/** The key of the `index`-th card or column of `doc`, or null if there is none. */
export function kanbanItemKey(doc: KanbanDoc, kind: KanbanItemKey['kind'], index: number): KanbanItemKey | null {
  const lines = itemLines(doc, kind)
  const line = lines[index]
  if (line === undefined) return null
  const text = doc.lines[line]!.text.trim()
  const copy = lines.slice(0, index).filter((other) => doc.lines[other]!.text.trim() === text).length
  return { kind, text, copy }
}

/** Where the item `key` names is in `source` now, or -1 when it is gone. */
export function findKanbanItem(source: string, key: KanbanItemKey | null): number {
  if (key === null) return -1
  const doc = parseKanban(source)
  let seen = 0
  const lines = itemLines(doc, key.kind)
  for (let index = 0; index < lines.length; index++) {
    if (doc.lines[lines[index]!]!.text.trim() !== key.text) continue
    if (seen === key.copy) return index
    seen++
  }
  return -1
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

