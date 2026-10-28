import type { DiagramSession, RenderScope } from './mermaid-session'
import {
  isKanbanCardSlot,
  moveKanbanCard,
  moveKanbanColumn,
  removeKanbanCard,
} from './kanban-model'
import type { KanbanDoc, KanbanSlots } from './kanban-model'
import { promptForKanbanDelete } from './urlDialog'
import {
  DRAG_CARD_CLASS,
  DRAG_COLUMN_CLASS,
  DRAG_CONTAINER_CLASS,
  DRAG_LAYER_CLASS,
  DRAG_LIFT_SCALE,
  DRAG_THRESHOLD,
  DROP_LINE_CLASS,
  DROP_LINE_GAP,
  DROP_LINE_OVERHANG,
  DROP_TARGET_CLASS,
  KANBAN_BIN_MARK_CLASS,
  KANBAN_BIN_SLOT_CLASS,
  contains,
  hitTest,
} from './mermaid-edit'
import {
  CARD_SELECTOR,
  bandLabelIn,
  headerAt,
  headerIn,
  itemLayer,
  sectionFrame,
  sectionGroupOf,
  sectionLayer,
} from './mermaid-dom'

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
export function attachKanbanDrag(session: DiagramSession, scope: RenderScope): () => void {
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
  return drawnElementAt(event, CARD_SELECTOR, cards)
}

/**
 * The drawn element a press or click landed in, and one rule for both: the
 * element the pointer is *on* first, then the coordinates. A card or a slot is
 * part of the diagram rather than a control on top of it, so the pointer can be
 * over its label, its box or its background, and an element's own box alone
 * answers only for the part of it that is the card.
 */
export function drawnElementAt(event: MouseEvent, selector: string, candidates: SVGElement[]): SVGElement | null {
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
    if (headerAt(el) !== null) return -1
    const direct = sectionGroupOf(el)
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
  const label = headerIn(hit)
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
    dressable(band === null ? null : sectionFrame(band), bandLabelIn(band), 'Delete card'),
    // The card says less than the band does, and it is not a whim: mermaid sized
    // each label box to the words it drew, and a `foreignObject` clips. The band's
    // box was sized for `+ Add a column` and holds the mark and both words with
    // room to spare; the card's was sized for `+ Add a card`, and the mark and both
    // words are wider than that by more than the mark. Both strings are fixed, so
    // both boxes are the same size on every board -- which means the words that
    // fit are the same on every board, and a bin never says half of itself.
    dressable(card === null ? null : sectionFrame(card), bandLabelIn(card), 'Delete'),
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
export function confirmThen(
  session: DiagramSession,
  subject: string,
  consequence: string,
  run: (source: string) => string | null,
): Promise<void> {
  return promptForKanbanDelete(subject, consequence).then((confirmed) => {
    if (confirmed) session.patch(run)
  })
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
    { before: itemLayer(svg) },
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
    { before: sectionLayer(svg), scale: 1, layer: kanbanDragLayer(svg) },
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
export function sectionRect(section: SVGElement): DOMRect {
  const rect = sectionFrame(section)
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

