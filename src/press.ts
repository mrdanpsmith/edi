/**
 * **One question, one answer: what does this press mean, and what happens?**
 *
 * This module exists because a single press was being answered by six mechanisms that each
 * answered a *different* question, and every rule about presses in this app was stated against
 * whichever one the author happened to be reading:
 *
 * | mechanism | the question it actually answered |
 * |---|---|
 * | `blockPosForElement` (`posAtDOM`) | which block does the *target* sit in? |
 * | class markers on the strip | margin or content? |
 * | `litBlockPositions` (plugin state) | is anything working? |
 * | a node view's `stopEvent` | does this view own the event? (asks ProseMirror to stay out) |
 * | `posAtCoords` (**coordinate geometry**) | what *position* is at these coordinates? |
 * | CSS `pointer-events` | which element is the event's *target*? |
 *
 * **The two that disagree are `posAtDOM` and `posAtCoords`**, and they disagree exactly when
 * `pointer-events` is in play. That is not a subtlety: `pointer-events: none` changes which
 * element a press's target is, and changes **nothing** about how coordinates map to a position —
 * `posAtCoords` → `posFromElement` → `findOffsetInNode` walks an element's children by geometry
 * and has no notion of `pointer-events` at all. So a dimmed block (`pointer-events: none`) is
 * unaddressable by DOM containment and **fully addressable by coordinates**, which is why the
 * claim "a dimmed block is inert" was false: ProseMirror's own mousedown handler was free to map
 * the press onto that block, and nothing in the app stopped it.
 *
 * **So this module asks the press's geometry rather than ProseMirror's.** A press lands in the
 * block *nearest* it — which is the same answer, needs no hit test, and is decidable in any
 * environment: the rule can be unit-tested because it does not depend on a browser's caret.
 *
 * ## What a press is
 *
 * - **`control`** — a button belonging to the block (its cluster, its own chrome). The press is
 *   the control's own and nothing else answers it.
 * - **`content`** — inside the block's content: a Visual table's cells, a CodeMirror editor, a
 *   diagram's drawing. **The default** for anything inside a block, because most blocks have no
 *   margin to declare (a diagram is drawn to its content; there is nothing beside it).
 * - **`margin`** — the space *around* the block, which a block declares with
 *   `BLOCK_MARGIN_CLASS`: a Visual table's scroller is as wide as the block while its grid is
 *   not, so most of that block is white space. A press here is a request for a caret **beside**
 *   the block, and the block's node view claims it so no block selection is born of it.
 * - **`space`** — the editor's own white space, with the nearest block and **which side of it**
 *   the press was on.
 * - **`dimmed`** — the press's *coordinates* resolve into a block that is dimmed (§3.2). It names
 *   no block by DOM containment, and that is the point: it must not become a caret.
 * - **`none`** — not this editor, or names nothing and resolves nowhere.
 *
 * **The order the questions are asked in is the design.** A press is `dimmed` before it is
 * anything else, because "would this press put a caret in a block the reader is demonstrably
 * not in" outranks "which region did it land in": a press in the white space beside a dimmed
 * paragraph resolves *into* that paragraph, so a classifier that asked the region first would
 * call it `space` and hand the reader a caret in a dimmed block.
 *
 * ## What happens
 *
 * **What happens: one answer, and it never changes the document.** A press in a block's
 * **margin** gets the answer a press anywhere else in the white space gets — the caret at the
 * nearest text, on the side that was pressed — because the margin is the white space beside the
 * block and sits *inside* the block's DOM, where ProseMirror's own mapping cannot reach it. That
 * is this module's whole remaining job.
 *
 * **A press never inserts anything.** It used to: a document of nothing but tables and code
 * blocks has nowhere to type, so a click in the white space made a paragraph — marking the file
 * dirty, which is a lot to ask of a stray click. *"Clicking around a document shouldn't create
 * blocks."* So in a document with nowhere to type, a press does nothing, and the way to write in
 * such a document is to open a table as a **sheet**: a surface that takes a caret, one click away
 * in the block's own cluster.
 *
 * **Everything else is a refusal, and refusals are stated, not implied:** a `content` press is
 * the block's business (§3.1), a `control` press is the button's, a `dimmed` press is inert, and
 * any of `Shift`/`Ctrl`/`Alt`/`Meta` is a selection being extended or the block-mode toggle.
 */
import { Plugin, Selection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'


/**
 * The top-level block `target` sits in, as a document position, or -1 when it is
 * not in this editor at all.
 *
 * This is the **one** DOM→position authority (§6.4). It replaced two: a
 * `data-block-pos` snapshot written into every handle when it was built, and a
 * walk that re-derived the position by scanning the document for a wrapper. The
 * snapshot is a number read at build time — stale the moment the document moves
 * under it — so every control now closes over the node view's `getPos()` and
 * asks at press time; this is the same question asked in the other direction,
 * for the two entry points that start from a DOM event (the context menu and the
 * Alt+click gesture) and have no node view to ask.
 *
 * `posAtDOM` is the primitive that answers it, and it needs no layout — which
 * matters, because the alternative (`posAtCoords`) needs a hit test and the real
 * engine is the only place a hit test exists. The containment check is not
 * redundant: an unlocked encrypted block is a *second* editor inside this one,
 * and a position in its document means nothing here.
 */
export function blockPosForElement(view: EditorView, target: EventTarget | null): number {
  if (!(target instanceof Element) || !view.dom.contains(target)) return -1
  // **The editor's own box names no block, and `posAtDOM` cannot say so.** `contains`
  // accepts it (a node contains itself), so it used to fall through to
  // `posAtDOM(view.dom, 0)`, and ProseMirror answers that with `posAtStart` — **0**,
  // which the walk below then reads as *the first block of the document*. So any
  // press that landed on the editor's own box named an unrelated block, and the
  // position depended on nothing but where the document starts.
  //
  // **Which presses those are: every press over a dimmed block.** Inertness is
  // `pointer-events: none` on the block (`styles.css`), so the hit test walks past
  // it to whatever is behind, and behind a dimmed paragraph is the editor's own
  // box. Measured: a press over the paragraph *below* a live sheet reported
  // `elementFromPoint` → `.ProseMirror`, and the gesture then opened the paragraph
  // *above* the sheet in Source — taking the one record off the working state, so
  // a live sheet closed and the document stopped being dimmed by a press on a
  // block that is supposed to receive nothing at all. The context menu read the
  // same 0 and offered `Source` / `Encrypt block…` for it.
  //
  // §3.2's own reasoning assumed the hit test lands on the *scroll container*
  // instead, which is true for the scroller's margin below a short block and
  // false for every block's own pixels — and the gate that reads it only ever
  // pressed the margin. So this guard is what makes "a press naming no block"
  // true of the dimmed region as well, and it is one line here rather than a
  // `pointer-events` exception at each of the two callers. It is also what makes
  // the answer to the dimmed-region question *be* nothing: `blockModeGesture` acts
  // on the block a press names and on nothing else, so `-1` here ends the question
  // for both of its callers rather than sending either of them looking.
  if (target === view.dom) return -1
  let inside: number
  try {
    inside = view.posAtDOM(target, 0)
  } catch {
    return -1
  }
  if (inside < 0) return -1
  const doc = view.state.doc
  const blockEndingAt = (at: number): number => {
    let found = -1
    doc.forEach((node, offset) => {
      if (found < 0 && at === offset + node.nodeSize) found = offset
    })
    return found
  }
  let blockPos = -1
  doc.forEach((node, offset) => {
    if (blockPos >= 0) return
    if (inside >= offset && inside < offset + node.nodeSize) blockPos = offset
  })
  // A block's own DOM can report the position at its *end* boundary rather than
  // inside it, and for an atom — a table, a diagram, a rule — that boundary is
  // also where the next block starts. Left alone, a click in a table would name
  // whatever follows it, which is the same class of bug the old
  // `data-block-pos` snapshot had and this replaced.
  if (blockPos < 0) blockPos = blockEndingAt(inside)
  return blockPos
}

/**
 * The space **around** a block's content, declared by the block that has one.
 *
 * **Most blocks have none and declare nothing:** a diagram is drawn to its content, a rule is
 * its content, an image is its content — there is nothing beside any of them to press. A Visual
 * table is the exception, because its horizontal scroller is as wide as the block while its grid
 * is as wide as its columns: measured, a block of 48→1256 around a grid of 48→253, which is a
 * thousand pixels of white space on a wide window. **That space is not the table**, and the two
 * things that follow from saying so are a press in it being a request for a caret beside the
 * block (`src/press.ts`), and the block's node view claiming it so no block selection is born of
 * it (`stopEvent`).
 *
 * **It is a declaration because "this part of me is not my content" is a fact only the block
 * knows**, and it is a *margin* rather than a "gutter" because the word named the symptom once
 * and hid the question.
 */
export const BLOCK_MARGIN_CLASS = 'block-margin'

/**
 * The content of a block that has a margin — **and the half that makes the margin mean
 * something**, because the margin element *contains* the content it surrounds.
 *
 * Without it, "inside the margin" is true of every cell of a table, and a press in a cell — which
 * is the *browser's* text selection (§3.1) — would be answered as a request for a caret. So a
 * block with a margin says which part is which, and `pressTarget` asks **content first**.
 */
export const BLOCK_CONTENT_CLASS = 'block-content'

/**
 * The control cluster — **and the third press-facing marker**, so all three live in
 * `src/press.ts`: `content`, `margin` and `controls` are the parts of a block a press is
 * classified by, and a module that cannot name them cannot ask the question.
 */
export const BLOCK_CONTROLS_CLASS = 'block-controls'


/** What a press is, and where it points. */
export type PressTarget =
  | { kind: 'control'; pos: number }
  | { kind: 'content'; pos: number }
  | { kind: 'margin'; pos: number; before: boolean }
  | { kind: 'space'; pos: number; before: boolean }
  | { kind: 'dimmed'; pos: number }
  | { kind: 'none' }

/** A top-level block, and whether a press was on its leading or trailing side. */
export interface GapTarget {
  pos: number
  before: boolean
}

/**
 * The top-level block a press in the white space belongs to: the nearest one, and **which side
 * of it**, because that is where the reader's caret should appear.
 *
 * Nearest by distance to the block's own box, so a press above or below a block belongs to it as
 * much as one beside it — the same gesture on a document laid out differently.
 */
export function gapTargetAt(view: EditorView, x: number, y: number): GapTarget | null {
  // Collected and reduced rather than compared against a variable the callback closes over:
  // "the nearest" is a fold over every block, and writing it as one keeps the question — which
  // block, and which side? — in a single place.
  const candidates: { target: GapTarget; distance: number }[] = []
  view.state.doc.forEach((_node, offset) => {
    const dom = view.nodeDOM(offset)
    if (!(dom instanceof HTMLElement)) return
    const box = dom.getBoundingClientRect()
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0
    // **The side the reader pressed.** Beside the block the side follows x — the case a wide
    // document makes, and the one a reader aims at; otherwise it follows y.
    const beside = x < box.left ? true : x > box.right ? false : null
    candidates.push({
      target: { pos: offset, before: beside !== null ? beside : y < box.top },
      distance: Math.hypot(dx, dy),
    })
  })
  if (candidates.length === 0) return null
  return candidates.reduce((nearest, other) =>
    other.distance < nearest.distance ? other : nearest).target
}

/**
 * Is this press target in a block's own margin — the space *around* its content?
 *
 * **Both markers, because a margin element *contains* the content it surrounds**: a Visual
 * table's scroller is the margin and the grid is inside it, so "inside the margin" alone is true
 * of every cell — and a press in a cell is the browser's text selection (§3.1), not a request for
 * a caret. Excluding the content here rather than in each caller is what makes the predicate safe
 * for *any* reader, and there are two: `pressTarget` and the node view's `stopEvent`.
 */
export function onBlockMargin(target: EventTarget | null): boolean {
  return target instanceof Element &&
    target.closest(`.${BLOCK_MARGIN_CLASS}`) !== null &&
    target.closest(`.${BLOCK_CONTENT_CLASS}`) === null
}

/**
 * Classify a press.
 *
 * **Both DOM→position paths, because they disagree**: the region's answer comes from the
 * event's *target* (`posAtDOM`), and `dimmed` comes from the press's *coordinates*
 * (`posAtCoords`). Asking only one is how "dimmed is inert" came to be believed.
 */
export function pressTarget(
  view: EditorView,
  event: MouseEvent,
  /** The blocks that stay lit while a working state is live — `litBlockPositions(state)`. */
  lit: ReadonlySet<number> = EMPTY_LIT,
): PressTarget {
  const { dom } = view
  const target = event.target
  // **Is this press in this editor at all?** The editor's own box, or the scroll container's own
  // box: a toolbar button and a dialog are as far from the document as a press can get, and a
  // press on either is not a request for a caret. Stated here rather than left to the listener's
  // scope, so the answer does not depend on having noticed where that listener is bound.
  const scroller = dom.parentElement
  if (scroller === null || !(target instanceof Node)) return { kind: 'none' }
  if (target !== scroller && !dom.contains(target)) return { kind: 'none' }

  // **The nearest block, folded once**, because both remaining questions need it and folding it
  // twice would be two geometry rules that could disagree.
  const nearest = gapTargetAt(view, event.clientX, event.clientY)

  // --- **1. Dimmed.** The first question, because it is the only one whose answer is a
  // refusal: a press that lands in a block the reader is demonstrably not in must not become a
  // caret there. An empty `lit` says no working state is live, and then there is no dimming and
  // no such thing as a dimmed block.
  //
  // **Asked by geometry, not by `posAtCoords`, and that is the whole reason it can be a rule.**
  // The tempting answer is ProseMirror's own `posAtCoords`, which is what used to put the caret
  // in a dimmed block: it maps the press's *coordinates* to a position and has no notion of
  // `pointer-events`, so a dimmed block — which the press cannot even target — was still the
  // block the press landed in. That is not a bug in either mechanism, it is the disagreement this
  // module was made for, and the press's own geometry already answers it: **the block a press
  // lands in is the nearest one**, which needs no hit test, no layout of the *browser's* caret,
  // and no platform to be measured on.
  if (lit.size > 0 && nearest !== null && !lit.has(nearest.pos)) {
    return { kind: 'dimmed', pos: nearest.pos }
  }

  // --- **2. The block the press's target names**, by DOM containment — the other path, and the
  // one that is right about *which element* this is.
  const named = blockPosForElement(view, target)
  if (named === -1) {
    // --- **3. White space**: the nearest block and the side, which is what a caret beside it
    // needs. No block to name and no block near means no caret to place: `none` is the honest
    // answer for a press in an empty editor.
    if (nearest === null) return { kind: 'none' }
    return { kind: 'space', pos: nearest.pos, before: nearest.before }
  }

  if (target instanceof Element) {
    if (target.closest(`.${BLOCK_CONTROLS_CLASS}`) !== null) {
      return { kind: 'control', pos: named }
    }
  }
  // **And the margin** — `onBlockMargin` excluding the content itself, because a margin element
  // *contains* the content it surrounds: "inside the margin" alone is true of every cell, and a
  // press in a cell is the browser's text selection rather than a request for a caret.
  if (onBlockMargin(target)) {
    // **The side, from the same fold as the white-space case** so there is one geometry rule: a
    // press in a block's own margin is closest to that block by definition, and a press whose
    // nearest block is some *other* one (a tall block's margin beside its neighbour) follows the
    // fold rather than the block it happens to be inside.
    return {
      kind: 'margin',
      pos: named,
      before: nearest !== null && nearest.pos === named
        ? nearest.before
        : !(target instanceof Element) ||
          target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2 <
            (view.nodeDOM(named) as HTMLElement).getBoundingClientRect().left,
    }
  }
  // **Everything else inside a block is its content**, which is the default because most blocks
  // have no margin to declare: a diagram is drawn to its content, a rule *is* its content, and
  // there is nothing beside either of them to press.
  return { kind: 'content', pos: named }
}

/** Is this press a plain one, with no gesture riding on it? */
function plainPress(event: MouseEvent): boolean {
  return event.button === 0 &&
    !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
}

/**
 * Answer a press, if this module has an answer for it. Returns whether it did, which is also how
 * the press is taken away from ProseMirror's own handler.
 *
 * **The refusals are the point as much as the answers**, and each one is a rule that used to be
 * a mechanism somewhere else: a press in a block's *content* is the block's business, a press on
 * a *control* is the button's, a press that *names no block and resolves into a dimmed one* is
 * inert, and a press with a modifier is extending a selection or is the block-mode toggle.
 */
export function answerPress(
  view: EditorView,
  event: MouseEvent,
  target: PressTarget,
  lit: ReadonlySet<number> = EMPTY_LIT,
): boolean {
  switch (target.kind) {
    case 'none':
    case 'content':
    case 'control':
    case 'dimmed':
      return false
    case 'margin':
    case 'space':
      break
  }
  if (!plainPress(event)) return false
  // While a working state is live the rest of the document is inert (§3.2), and that includes
  // the white space beside it.
  if (lit.size > 0) return false
  // **A press in the editor's own white space is ProseMirror's**, and it answers it better than
  // this module could: it maps the press's *coordinates* onto the text, so a click inside a long
  // paragraph lands between the words the reader aimed at. So the one answer below is for the
  // press ProseMirror cannot answer — a **margin**, which is the white space *inside* the block's
  // DOM where its own mapping cannot go.
  if (target.kind !== 'margin') return false

  const node = view.state.doc.nodeAt(target.pos)
  if (node === null) return false
  const $at = view.state.doc.resolve(target.before ? target.pos : target.pos + node.nodeSize)
  // **The nearest *text*, asked with `textOnly`.** `Selection.near` does not pass it, so it
  // answers with a `NodeSelection` on the nearest atom — which in a document of tables is the
  // very thing the press was avoiding.
  const near = Selection.findFrom($at, target.before ? -1 : 1, true) ??
    Selection.findFrom($at, target.before ? 1 : -1, true)
  // **No textblock anywhere in the document** — nothing but tables and code blocks — and then
  // there is no caret to place. The press does nothing, which is the honest answer, and it is
  // why a click never creates a block.
  if (near === null) return false
  view.dispatch(view.state.tr.setSelection(near))
  // A press this handled focused nothing by itself, and a caret in an unfocused editor is one
  // keystroke away from going nowhere.
  event.preventDefault()
  view.focus()
  return true
}

/**
 * **The one listener every press goes through.**
 *
 * **It is a plugin prop, so it runs before ProseMirror's own `mousedown`** — which is what makes
 * "inert" true rather than merely intended. `prosemirror-view`'s `initInput` consults
 * `runCustomHandler` before its own handler, so returning `true` here means ProseMirror never
 * maps the press's coordinates to a position at all. That is the whole mechanism behind the
 * dimmed rule: the caret in a dimmed block was ProseMirror's *own* listener answering, and a
 * refusal after the fact would be too late.
 *
 * **It is also bound to the scroll container, not only to `view.dom`**, because §3.2's own note
 * on the white space of a short document is that it is the *scroller* — a plugin prop is bound to
 * `view.dom` and would miss exactly the region with the most white space on the page. A press
 * inside `view.dom` bubbles to the container, so one listener on the container sees both regions,
 * and it sees them *after* ProseMirror's own handler, which is harmless: a press this answers
 * has already had ProseMirror try, and what it finds is either nothing or something this press
 * then replaces. **A press on the container's own box never reached ProseMirror at all**, so for
 * that region "after" is the only order there is.
 */
export function pressPlugin(
  litPositions: (view: EditorView) => ReadonlySet<number>,
): Plugin {
  return new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const target = pressTarget(view, event as MouseEvent, litPositions(view))
        // **A dimmed press is refused here and nowhere else**, and it is the one refusal that has
        // to happen before ProseMirror's own mapping rather than after it.
        if (target.kind === 'dimmed') {
          event.preventDefault()
          return true
        }
        return answerPress(view, event as MouseEvent, target, litPositions(view))
      },
    },
  },
  view(editorView) {
    const scroller = editorView.dom.parentElement
    if (scroller === null) return {}
    const onMouseDown = (event: MouseEvent): void => {
      const lit = litPositions(editorView)
      answerPress(editorView, event, pressTarget(editorView, event, lit), lit)
    }
    scroller.addEventListener('mousedown', onMouseDown)
    return {
      destroy() {
        scroller.removeEventListener('mousedown', onMouseDown)
      },
    }
  },
  })
}

/** No working state, no dimming, and the default every caller gets for free. */
const EMPTY_LIT: ReadonlySet<number> = new Set()