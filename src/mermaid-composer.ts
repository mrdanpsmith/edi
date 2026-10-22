import type { DiagramSession, RenderScope, EditSubject } from './mermaid-session'
import {
  usableKanbanLabel,
  kanbanLabelRefusal,
  addKanbanCard,
  parseKanban,
  kanbanNodeId,
  isSlotId,
  detectDiagramType,
} from './kanban-model'
import type { KanbanDoc } from './kanban-model'
import { patchLabel, diagramFamily, type LabelTarget, type LabelRef, type DiagramFamily, labelElementIn } from './mermaid-patch'

export const EDITABLE_CLASS = 'mermaid-editables'
export const COLUMN_SLOT_CLASS = 'mermaid-kanban-column-slot'
const COMPOSER_HEIGHT = 30
const RENAME_FIELD_WIDTH = 140
export function labelsOf(scope: RenderScope | null): LabelTarget[] {
  return (scope?.labels ?? []) as LabelTarget[]
}

/** The label at `index` of the render on screen, as the mapper's own record. */
export function labelAt(session: DiagramSession, index: number): LabelTarget | undefined {
  return labelsOf(session.scope)[index]
}

/** Where the label at `index` sits among the render's labels. */
export function indexOfLabel(scope: RenderScope, label: Element | null): number {
  return label === null ? -1 : scope.targets.indexOf(label)
}function boxFor(el: Element): DOMRect {
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
export function labelTargetAt(event: MouseEvent, targets: LabelTarget[]): LabelTarget | null {
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
export function hitTest<T>(
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

export function contains(rect: DOMRect, x: number, y: number): boolean {
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
export function editLabel(
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
export function editColumnName(session: DiagramSession, index: number, band: Element): void {
  editLabel(session, {
    index,
    box: bandBox(band),
    minWidth: 0,
    placeholder: band.classList.contains(COLUMN_SLOT_CLASS) ? 'Column name' : undefined,
  })
}

/** The band a label is drawn in, on a board, or `null` off one. */
export function sectionOf(label: Element): Element | null {
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
export function editCardTitle(session: DiagramSession, card: number, fresh: boolean): void {
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
