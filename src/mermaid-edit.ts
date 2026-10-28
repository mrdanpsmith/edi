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
 * editing layer of one render and the drag. (`session.openField` is the field a
 * label is edited in; it lives in the session because an open field survives a
 * render, which is the one piece of editing state that is not render-scoped.)
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
import type { DiagramSession, RenderScope } from './mermaid-session'
import { FIELD_CLASS, sessionFor, stopEditing } from './mermaid-session'
export { endSession as discardMermaidSession } from './mermaid-session'
import { attachKanbanChrome } from './mermaid-chrome'
import {
  labelsOf,
  labelTargetAt,
  sectionOf,
  editColumnName,
  editCardTitle,
  editLabel,
  EDITABLE_CLASS,
} from './mermaid-composer'
export * from './mermaid-composer'
import {
  diagramFamily,
  labelTargets,
  sectionElements,
  cardElements,
  kanbanSlotElements,
  type DiagramFamily,
} from './mermaid-patch'
export * from './mermaid-patch'
import { CARD_SELECTOR, cardGroupOf, nodeGroupOf } from './mermaid-dom'
import { attachKanbanDrag, drawnElementAt } from './mermaid-drag'
export { drawnElementAt, confirmThen, sectionRect } from './mermaid-drag'
import {
  detectDiagramType,
  parseKanban,
} from './kanban-model'
export * from './kanban-model'
/** The box a field is placed in, so the node view can keep its events out of ProseMirror. */
export { FIELD_CLASS }

// ── classes and timings ────────────────────────────────────────────────────

const NOTICE_TEXT =
  "Couldn't parse diagram — keeping the previous version. Edit the source to fix it."
/** The card being dragged: the real one, lifted out of the board to follow the pointer. */
export const DRAG_CARD_CLASS = 'kanban-dragging-card'
/** On the preview while a card is in flight, so the board stops clipping it. */
export const DRAG_CONTAINER_CLASS = 'kanban-dragging'

/** On a whole lifted list: the frame, so the list reads as one thing leaving. */
export const DRAG_COLUMN_CLASS = 'kanban-dragging-column'
/**
 * On the group a lifted list is held in — the one thing on the board that is
 * neither a frame nor a card, and exists only while a column is in the air.
 */
export const DRAG_LAYER_CLASS = 'kanban-drag-layer'
/** The line drawn in the gap the card will drop into. */
export const DROP_LINE_CLASS = 'kanban-drop-line'
export const DROP_TARGET_CLASS = 'kanban-drop-target'
/** How far a line sits outside the cards bracketing a gap, in px. */
export const DROP_LINE_GAP = 5
/** How far the line reaches past its column, so it still shows either side of
 *  the card that covers it — mermaid draws a card ~15px narrower than its column. */
export const DROP_LINE_OVERHANG = 4
/** How much the lifted card grows while it is held, about its own corner. */
export const DRAG_LIFT_SCALE = 1.04

/**
 * The board's own controls in edit mode, all of them this class plus one naming
 * the thing they do. The node view keys its own event handling off the base
 * class, so a button added here is excluded from ProseMirror and from the
 * double-click that ends an edit session without touching any of them.
 */
export const KANBAN_BUTTON_CLASS = 'mermaid-kanban-btn'
/** The quiet `⋯` in a column's corner, and the menu it opens. */
export const MENU_BUTTON_CLASS = 'mermaid-kanban-menu'
export const MENU_LIST_CLASS = 'mermaid-kanban-menu-list'
export const MENU_ITEM_CLASS = 'mermaid-kanban-menu-item'
/** Drawn on the board for the card a column is offered next, and its composer. */
export const ADD_SLOT_CLASS = 'mermaid-kanban-slot'
/** Drawn on the board for the column the board is offered next. */
/**
 * The layer every board control is built into, exported because the node view
 * keys its own event handling off it: it holds the buttons *and* the menu list,
 * which is not a button but is just as much the editor's own surface — a double
 * click inside an open menu is a click on a menu, not a request to end the edit.
 */
export const KANBAN_CHROME_CLASS = 'mermaid-kanban-chrome'
/** The bin's mark, drawn in the band's own name — see `trashIcon`. */
export const KANBAN_BIN_MARK_CLASS = 'mermaid-kanban-bin-mark'
/**
 * The card slot in the drawn column, which is the bin for the length of a card's
 * drag and nothing at all the rest of the time. It is drawn rather than added on
 * demand because mermaid laid the board out with it and a drag may not re-render
 * the drawing out from under the card it is holding, so the class is how it is
 * *blank* instead — see where it is put on.
 */
export const KANBAN_BIN_SLOT_CLASS = 'mermaid-kanban-bin-slot'
export const MENU_ITEM_KIND_CLASS = 'mermaid-kanban-menu-item-'
export const MENU_ITEM_DANGER_CLASS = 'is-danger'
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
/** Half a board button's side, in px. */
export const KANBAN_BUTTON_HALF = 9
/** From a column's own corner to the edge of its control. */
export const KANBAN_BUTTON_EDGE = 8
/** The menu's own width, in px — it is the width of its longest item. */
export const MENU_WIDTH = 190
/** A field retyping an existing label, in px. */


/** Marks a `.mermaid` block that is in edit mode rather than previewing. */
export const EDITING_CLASS = 'mermaid-editing'
/** Pointer travel, in px, before a card press turns into a drag rather than a click. */
export const DRAG_THRESHOLD = 4

/* patchers moved to ./mermaid-patch */

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
    const { svg } = await mermaid.render(`mermaid-diagram-${renderSeed.value++}`, code)
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
const renderSeed = { value: 0 }

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
      const node = nodeGroupOf(target.el)
      return node === null || !slots.cards.has(node)
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
    if (!labelTargetAt(event, targets) && drawnElementAt(event, CARD_SELECTOR, scope.cards) === null) return
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
    const card = cardGroupOf(target.el)
    const cardIndex = card === null ? -1 : scope.cards.indexOf(card)
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


// ── kanban board chrome ─────────────────────────────────────────────────────

/**
 * A placed control's box, in viewport coordinates. The width and height are
 * optional because a control is sized by its own content in one case only — the
 * menu, whose height is however many items it has — and every other caller says
 * both, so this is what a full `DOMRect` is accepted as.
 */
export interface ChromeBox {
  left: number
  top: number
  width?: number
  height?: number
}
