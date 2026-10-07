/**
 * The editing session of one rendered diagram.
 *
 * A `.mermaid` block has exactly one of these, and it is what makes the block
 * behave the same way in every phase of its use. Everything that used to be a
 * set of cooperating module-level variables and per-render closures — which
 * label is being retyped, whether a drag is armed, what a patch must be
 * computed against — is here instead, in one object with one owner and one
 * teardown.
 *
 * The problems it exists to solve, in the order they bite:
 *
 * **One source.** `source` is the drawn source of the render on screen, updated
 * by every patch the moment it is made. A patch is a function of it, taken at
 * the moment the patch is made, so nothing can be computed against a snapshot a
 * dialog, an undo or a theme change has since moved on from. That was the class
 * of bug where a delete confirmed twenty seconds after its prompt wrote back a
 * board that had stopped existing.
 *
 * **One interaction at a time.** `PREEMPTS` says which phase finishes which, so
 * "something else started while that was open" has an answer for every pair
 * rather than for the pairs somebody remembered. A field, a drag and a menu are
 * the three things that can own the pointer; two of them at once is what reads
 * as flakiness.
 *
 * **One render, and it is the newest one.** `beginRender` hands out a ticket and
 * `isCurrent` throws the losers away. Rendering is awaited in two places and
 * requested from three, so two renders of one block really are in flight at
 * once; without a ticket the older one could land last and leave the block
 * showing a board the document has already moved past — with an editing layer
 * built from *that* source behind it.
 *
 * **The interaction outlives the render.** A render replaces the block's
 * contents, so anything anchored to a DOM node dies with it. A field instead
 * anchors through a `Subject`, which is asked to find itself again after every
 * render: if its subject is still there the field carries on with what was
 * being typed, and if it is not the field is resolved rather than abandoned. A
 * theme change, a zoom, an undo — none of them silently eats half a title.
 *
 * **One placement.** Overlays — the board's `⋯`, an open menu, a field — are
 * registered here and placed by one function against one coordinate space (the
 * preview, which is the scroller). `schedule` re-places on everything that can
 * have moved an overlay, and keeps asking while a placement moves something.
 */

// ── the field's own classes and sizes ─────────────────────────────────────

/** The box an inline field is placed and sized by, and the only child it has. */
export const FIELD_CLASS = 'mermaid-edit-field'
/** On the field above an input that is *adding* something, not replacing it. */
const FIELD_NEW_CLASS = 'mermaid-edit-field-new'
const INPUT_CLASS = 'mermaid-edit-input'
const INPUT_WRAP_CLASS = 'mermaid-edit-input-wrap'
const INVALID_CLASS = 'mermaid-edit-invalid'
/** A transient message over the block: a refusal, or a diagram mermaid refused. */
const NOTICE_CLASS = 'mermaid-edit-notice'
/**
 * How much room the block keeps under a field that hangs below its diagram.
 */
const FIELD_MARGIN = 8
/**
 * A composer grows with the title being written, because a card's own box does
 * not: four lines is past anything that fits on a board, and past that the
 * field scrolls rather than climbing over the columns behind it.
 */
const COMPOSER_MAX_HEIGHT = 96

// ── phases ────────────────────────────────────────────────────────────────

/**
 * What a block is doing right now. `view` is a diagram being read, `idle` is a
 * diagram being edited with the pointer to itself, and the last three are the
 * three things that can own it.
 */
type DiagramPhase = 'view' | 'idle' | 'text' | 'drag' | 'menu'

/**
 * Which phase finishes which when one starts, which is the whole of "what
 * happens to the thing that was already open".
 *
 * A field and a drag both take the pointer and neither can say what a release
 * means with the other running, so either one finishes the other. A menu is a
 * popover and not a mode: it is the one thing that can be open while a field is
 * being retyped, which is why pressing a column's `⋯` mid-rename does not throw
 * the rename away. It does still answer to another menu, since there can only
 * be one.
 */
const PREEMPTS: Record<Exclude<DiagramPhase, 'idle' | 'view'>, readonly DiagramPhase[]> = {
  text: ['text', 'drag', 'menu'],
  drag: ['text', 'drag', 'menu'],
  menu: ['menu'],
}

/** An open interaction, and the one way to end it. */
interface Interaction {
  phase: DiagramPhase
  /**
   * Resolve it. `accept` is true when the *user* finished it — Enter, a click
   * away, the Done button, a double click — and false when it is being taken
   * away: by another interaction, by a render whose subject has gone, or by the
   * block leaving edit mode for a reason of its own.
   */
  finish(accept: boolean): void
}

// ── one render of a diagram ───────────────────────────────────────────────

/**
 * The drawn slots of a board, as the elements the DOM walk found them in. A
 * slot is a card or a column the board is *drawn* with rather than one the
 * document has, which is what every walk has to be able to say.
 */
interface RenderSlots {
  /** Every drawn card slot. */
  cards: Set<SVGElement>
  /** The drawn column's index, or `-1` for a board drawn without one. */
  column: number
  /** The card slot *inside* that drawn column: the bin, for the length of a card's drag. */
  columnCard: SVGElement | null
}

/**
 * What one render of a diagram exposes to whatever is anchored in it.
 * Collected once per render rather than per feature: three callers each walking
 * the SVG and each parsing the source is three answers to "what is on this
 * board", and they agree only because they happen to agree.
 *
 * `targets` and `labels` are the same labels in the same order, kept apart so
 * that addressing one needs no knowledge of the family: an index into `targets`
 * says *where* a label is, which is all a field needs to find itself again in
 * the next render, while `labels` is the family's own idea of what that label
 * is — a `LabelTarget` for a diagram, nothing the editor here has to read.
 */
export interface RenderScope {
  /** The vector this render produced. */
  svg: SVGSVGElement
  /** The source it was made from — a board's drawn source, slots and all. */
  source: string
  /** Every label the layer offered, as elements, in document order. */
  targets: Element[]
  /** What the family knows about each of those labels, in the same order. */
  labels: unknown[]
  /** Every drawn card, in the order the source model holds them. */
  cards: SVGElement[]
  /** Every drawn column, in the order the source model holds them. */
  sections: SVGElement[]
  /** The board's drawn places, or `null` for a diagram that is not a board. */
  slots: RenderSlots | null
  /** The source model — a board's line model — or `null` for a family with none. */
  model: unknown
}

// ── overlays ──────────────────────────────────────────────────────────────

/**
 * An overlay's box, in viewport coordinates. Width and height are optional
 * because an overlay is sized by its own content in exactly one case — the
 * menu, whose height is however many items it has — and everything else says
 * both, so a full rect is accepted as-is.
 */
interface OverlayBox {
  left: number
  top: number
  width?: number
  height?: number
}

interface Overlay {
  element: HTMLElement
  /** Read on every placement, so an overlay follows what it stands in. */
  box: () => OverlayBox | null
  /**
   * Run after the boxes are written, for an overlay whose own box is a
   * consequence of the placement — a field that has to make room for itself
   * below the block's last line. Reports whether it changed anything, which is
   * what the settle loop is run by.
   */
  after?: () => boolean
}

// ── the thing a field is editing ──────────────────────────────────────────

/**
 * What a field is anchored to. A field outlives renders, so it cannot hold a
 * DOM node: it holds the *way to find* one, and the session re-asks after every
 * render. That is the difference between a field that carries on and one that
 * silently loses what was typed.
 */
export interface EditSubject {
  /** Where the subject is in `render`, or `null` when it is not there any more. */
  locate(render: RenderScope | null): Element | null
  /** The box the field stands in, in viewport coordinates. */
  box(el: Element): DOMRect
  /** Put the subject on hold: what the field replaces stops being drawn. */
  enter(el: Element): void
  /** Give it back, exactly as it was. */
  leave(el: Element): void
  /**
   * Stretch what the field fills to the title being written — a card is sized
   * for a card and a title is not one. Optional because most subjects are a
   * line of text with no box of its own to grow.
   */
  grow?: (el: Element, input: HTMLTextAreaElement) => void
}

/**
 * What a field is: what it holds, how it is drawn, and what its value commits
 * to. The same for every kind of text edit on a diagram — a node label, a card
 * title, the name of a column that does not exist yet — so that the ways into
 * one on a board are one code path and not four.
 */
interface TextEdit {
  subject: EditSubject
  /** The text in the field when it opens. */
  value: string
  placeholder?: string
  /** `new` is drawn as adding rather than overwriting; `label` is neither. */
  tone?: 'label' | 'new'
  /** A floor for a box too narrow to type a title into. */
  minWidth?: number
  /** A wrapping textarea rather than a one-line input: for a title, not a name. */
  multiline?: boolean
  /**
   * What the value commits to. `true` is done, `false` is refused quietly, and
   * a string is refused *and* said — the way an unusable card title is. A
   * refused value leaves the field open with what was typed in it.
   */
  onAccept: (value: string) => boolean | string
}

// ── the session ───────────────────────────────────────────────────────────

/** How a block reaches its document. Supplied by whoever renders it. */
interface DiagramBinding {
  /** The `.mermaid` block: what outlives a render. */
  block: HTMLElement
  /** The scroller the diagram is drawn in, and where overlays are placed from. */
  preview: HTMLElement
  /** Hand a patched (drawn) source to the document. */
  commit(drawn: string): void
}

/** Where a field's subject is in the render it is currently standing in for. */
interface EditState {
  subject: Element | null
  /**
   * The box the field is *sized* by, taken when it took this subject over — not
   * re-read from a subject that the field itself grows, which is a loop: the
   * field's floor rises, so its content box rises, so the card it is filling
   * grows, so the floor rises again. A field's *position* follows its subject;
   * its size does not.
   */
  size: { width: number; height: number }
}

/** The one open field, held so a render can move it rather than lose it. */
interface OpenField {
  spec: TextEdit
  element: HTMLElement
  input: HTMLInputElement | HTMLTextAreaElement
  state: EditState
  close(): void
}

/**
 * One block's editing session. Obtain it with `sessionFor` and end it with
 * `endSession`; everything else is reached through it.
 */
export class DiagramSession {
  readonly block: HTMLElement
  /** The scroller overlays are placed in. Re-pointed whenever the node view rebuilds it. */
  preview: HTMLElement
  private commitTo: (drawn: string) => void

  /** The drawn source of the render on screen, and of every patch since. */
  private drawn = ''
  /** The render the last `beginRender` was issued for; anything older is stale. */
  private ticket = 0
  private render: RenderScope | null = null
  private interaction: Interaction | null = null
  private overlays: Overlay[] = []
  private frame = 0
  private settle = 0
  private disposers: Array<() => void> = []
  private ended = false
  private editingOn = false
  private field: OpenField | null = null

  constructor(binding: DiagramBinding) {
    this.block = binding.block
    this.preview = binding.preview
    this.commitTo = binding.commit
  }

  // ── source ───────────────────────────────────────────────────────────

  /** The drawn source of the render on screen. The only base a patch may use. */
  get source(): string {
    return this.drawn
  }

  /** The render that anchors in the block resolve against. */
  get scope(): RenderScope | null {
    return this.render
  }

  /**
   * Re-bind the session for the render that is starting. The commit handler and
   * the scroller change with the mode and with a rebuilt preview.
   */
  bind(commit: ((drawn: string) => void) | undefined, preview: HTMLElement): void {
    this.preview = preview
    this.commitTo = commit ?? ((): void => undefined)
  }

  /**
   * Record the source of a render that mermaid refused. The drawing on screen is
   * the last good one, but the *document* has moved on to this, and the next
   * patch has to be made against the document: made against the drawing it would
   * carry on as if the refused edit had never happened and commit a board
   * without it.
   */
  noteSource(code: string): void {
    this.drawn = code
  }

  /**
   * Adopt a render: its source becomes the session's and its handles become
   * what an open field re-anchors to. Called *before* the render reaches the
   * DOM, so a patch made before the new drawing is up is still made against the
   * source that new drawing is of.
   */
  adopt(render: RenderScope): void {
    this.drawn = render.source
    this.render = render
  }

  /**
   * The one way anything changes the document.
   *
   * `run` is handed the source as it is *now* and returns the source to write,
   * or `null` for nothing to do. So the patch is computed against the board as
   * it stands when the patch is made, never against a snapshot taken when some
   * affordance was built — which is what made a confirmed delete write back the
   * board as it was before the prompt was opened.
   */
  patch(run: (drawn: string) => string | null): boolean {
    // Only while the block is still editable. That is what stops an edit from
    // reaching the document after the diagram stopped being editable — and it is
    // deliberately *not* the presence of a commit handler, because accepting the
    // field in progress is itself a commit and happens on the way out.
    if (!this.editing || this.ended) return false
    const next = run(this.drawn)
    if (next === null || next === this.drawn) return false
    // Before the commit, so a patch made while this one is still on its way to
    // the document builds on this one rather than on the render it replaces.
    this.drawn = next
    this.commitTo(next)
    return true
  }

  // ── phases ───────────────────────────────────────────────────────────

  /** What the block is doing. */
  get phase(): DiagramPhase {
    if (this.ended) return 'view'
    if (this.interaction !== null) return this.interaction.phase
    return this.editingOn ? 'idle' : 'view'
  }

  /** Whether the block is being edited rather than previewed. */
  get editing(): boolean {
    return this.editingOn
  }

  /**
   * Take the block over, or give it up. Giving it up finishes whatever was open
   * first — with `accept`, because a field the user was typing into and then
   * finished the diagram is an edit they made, not one to throw away.
   */
  setEditing(on: boolean, accept = true): void {
    if (on) {
      this.editingOn = true
      return
    }
    this.finish(accept)
    this.reset()
    this.editingOn = false
  }

  /**
   * Start an interaction, finishing whichever one `PREEMPTS` says this one
   * replaces. Returns the function that ends *this* interaction, so a caller
   * finishing its own gesture does not have to know what else has been open
   * since — an affordance torn down by a render, say.
   */
  start(phase: Exclude<DiagramPhase, 'idle' | 'view'>, finish: (accept: boolean) => void): () => void {
    const open = this.interaction
    if (open !== null && PREEMPTS[phase].includes(open.phase)) {
      this.interaction = null
      open.finish(false)
    }
    const interaction: Interaction = { phase, finish }
    this.interaction = interaction
    return () => {
      if (this.interaction === interaction) this.interaction = null
    }
  }

  /** Finish whatever is open, if anything. */
  finish(accept: boolean): void {
    const open = this.interaction
    if (open === null) return
    this.interaction = null
    open.finish(accept)
  }

  /** Whether a field is open, which is what a drag asks before it arms. */
  get hasField(): boolean {
    return this.field !== null
  }

  // ── render-scoped resources ──────────────────────────────────────────

  /**
   * Register something that belongs to the current render — a listener on the
   * preview, the board's own controls, the classes on the labels a render
   * offered. All of it is taken down and rebuilt on the next render, because
   * the render replaced every element it was attached to.
   */
  onRender(dispose: () => void): void {
    this.disposers.push(dispose)
  }

  /** `onRender` for the common case of a single listener. */
  listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler)
    this.onRender(() => target.removeEventListener(type, handler))
  }

  /** Take down everything this render built. Not the session itself. */
  reset(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  /**
   * End the session: finish whatever is open, take down this render, take down
   * the placement machinery, forget the field. Idempotent, because "the block
   * stopped being editable" arrives here from the Done button, from a double
   * click, from another diagram taking over, and from the node view being
   * destroyed — and any two of them can land in the same turn.
   */
  end(accept = true): void {
    if (this.ended) return
    // Finished *before* the block is marked as over, so a field accepted on the
    // way out can still commit.
    this.finish(accept)
    this.ended = true
    this.reset()
    if (this.frame) cancelAnimationFrame(this.frame)
    if (this.settle) cancelAnimationFrame(this.settle)
    this.frame = 0
    this.settle = 0
    this.overlays = []
    this.editingOn = false
    this.render = null
    this.field = null
  }

  // ── placement ────────────────────────────────────────────────────────

  /**
   * Register an overlay and place it at once. Returns the function that takes
   * it back off the board — the only way an overlay leaves, so the registry and
   * the DOM cannot drift apart.
   */
  overlay(element: HTMLElement, box: () => OverlayBox | null, after?: () => boolean): () => void {
    const entry: Overlay = { element, box, after }
    this.overlays.push(entry)
    this.place()
    return () => {
      const at = this.overlays.indexOf(entry)
      if (at >= 0) this.overlays.splice(at, 1)
    }
  }

  /** Whether any overlay actually moved — what the settle loop is run by. */
  place(): boolean {
    const base = this.preview.getBoundingClientRect()
    let moved = false
    for (const { element, box } of this.overlays) {
      const at = box()
      if (at === null) continue
      // `scrollLeft` because the preview is a horizontal scroller: an absolute
      // child is placed from the scrolled content, not from the visible box.
      const left = `${at.left - base.left + this.preview.scrollLeft}px`
      const top = `${at.top - base.top}px`
      if (element.style.left !== left) {
        element.style.left = left
        moved = true
      }
      if (element.style.top !== top) {
        element.style.top = top
        moved = true
      }
      if (at.width !== undefined) element.style.width = `${at.width}px`
      if (at.height !== undefined) element.style.height = `${at.height}px`
    }
    for (const { after } of this.overlays) {
      if (after?.() === true) moved = true
    }
    return moved
  }

  /**
   * Place in a frame, and again while a placement keeps moving something. The
   * loop is what catches the movement nothing observes: the board is *centred*
   * in the preview, so the drawing slides inside it when the block around it
   * grows — a composer hanging below a short column makes the block grow, which
   * recentres the board, which moves every control without changing the size of
   * anything measured here.
   */
  schedule = (): void => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.place()) this.schedule()
    })
  }

  /**
   * Watch everything that can move an overlay without changing its size: the
   * drawing, the preview it is scrolled in, and the editor the preview is
   * scrolled in. The preview is watched as well as the drawing because a window
   * resize narrows the preview while the drawing keeps the size mermaid drew it
   * at, so an observer on the drawing alone never fires.
   */
  watch(): void {
    const observer = new ResizeObserver(this.schedule)
    observer.observe(this.preview)
    const svg = this.render?.svg
    if (svg !== undefined) observer.observe(svg)
    const scroller = this.preview.closest('.ProseMirror')?.parentElement ?? null
    for (const node of [this.preview, scroller]) {
      if (node === null) continue
      observer.observe(node)
      node.addEventListener('scroll', this.schedule)
    }
    this.onRender(() => {
      observer.disconnect()
      for (const node of [this.preview, scroller]) node?.removeEventListener('scroll', this.schedule)
    })
  }

  // ── renders ──────────────────────────────────────────────────────────

  /**
   * Claim the right to write to this block. Rendering is awaited in two places
   * and requested from three, so two renders of one block are routinely in
   * flight at once; without this the older one could land last and leave the
   * block showing a board the document has moved past — with an editing layer
   * built from *that* source behind it, so the next edit patched a board that
   * was no longer there.
   */
  beginRender(): number {
    this.ticket += 1
    return this.ticket
  }

  /** Whether a render still holds the block, or has been overtaken. */
  isCurrent(ticket: number): boolean {
    return !this.ended && ticket === this.ticket
  }

  // ── the field ────────────────────────────────────────────────────────

  /**
   * Open the one field a diagram has. Replaces whatever the phase table says a
   * field replaces, so there is never a second one and never a question about
   * which of two the user meant.
   */
  openField(spec: TextEdit): void {
    const found = spec.subject.locate(this.render)
    if (found === null) return

    const element = document.createElement('div')
    element.className = spec.tone === 'new' ? `${FIELD_CLASS} ${FIELD_NEW_CLASS}` : FIELD_CLASS
    const input = document.createElement(spec.multiline ? 'textarea' : 'input')
    if (input instanceof HTMLInputElement) input.type = 'text'
    input.className = spec.multiline ? `${INPUT_CLASS} ${INPUT_WRAP_CLASS}` : INPUT_CLASS
    input.value = spec.value
    if (spec.placeholder) input.placeholder = spec.placeholder

    const block = this.block
    const padAtOpen = block.style.paddingBottom
    /**
     * The subject as the *current* render has it. A field holds this rather than
     * an element, because a render replaces the element and the field does not
     * stop: `reanchor` moves this, and every read of "what am I standing in for"
     * — the box, the growth, what has to be given back — follows it.
     */
    const drawn = spec.subject.box(found)
    const state: EditState = { subject: found, size: { width: drawn.width, height: drawn.height } }
    let closed = false
    let unplace: () => void = () => undefined
    /** Give the phase back when the field is gone, so the block is idle again. */
    let release = (): void => undefined

    /**
     * The block grows to hold a field that hangs below the diagram's last line:
     * a field is absolutely positioned, so it contributes nothing to the block's
     * height, and at the end of a document the part that hangs is not something
     * the editor can scroll to — the dialog is simply clipped.
     */
    const fit = (): boolean => {
      if (closed) return false
      const shown = Number.parseFloat(block.style.paddingBottom) || 0
      const room = block.getBoundingClientRect().bottom - shown - element.getBoundingClientRect().bottom
      const pad = room < FIELD_MARGIN ? Math.ceil(FIELD_MARGIN - room) : 0
      if (pad === shown) return false
      block.style.paddingBottom = pad === 0 ? '' : `${pad}px`
      // Growing the block makes the field reachable, not looked at — and only
      // when it really grew, so this cannot feed the place that caused it.
      if (pad > 0) element.scrollIntoView({ block: 'nearest' })
      return true
    }

    const close = (): void => {
      if (closed) return
      closed = true
      if (state.subject !== null) spec.subject.leave(state.subject)
      // Before the element goes: a field that closed but still held the phase
      // would leave the block reporting `text` forever, and everything that asks
      // the phase before acting on a press — a drag, above all — would go on
      // seeing a field that is not there.
      release()
      unplace()
      // Not `.remove()`: a blur handler can fire while the field is being
      // detached, and `remove()` throws when the node has no parent.
      element.parentNode?.removeChild(element)
      block.style.paddingBottom = padAtOpen
      if (this.field?.element === element) this.field = null
    }

    const finish = (accept: boolean): void => {
      if (closed) return
      if (!accept) {
        close()
        return
      }
      const refusal = spec.onAccept(input.value.trim())
      // A refused value is one the editor knows it cannot write down, so the
      // reason travels with it: the field stays open, flashing red, with what
      // was typed in it — the alternative is a card that silently fails to
      // appear and a notice about a diagram that refused to parse, neither of
      // which tells the user which of their own keystrokes to take back.
      if (refusal === true) {
        close()
        return
      }
      input.classList.add(INVALID_CLASS)
      if (typeof refusal === 'string') this.notice(refusal, 'The diagram cannot be given that label.')
    }

    const box = (): DOMRect => spec.subject.box(state.subject ?? found)

    // The subject stops being drawn for as long as the field stands in for it.
    spec.subject.enter(found)

    // Enter commits and Escape does not. A wrapping field would otherwise commit
    // on its first line and leave the rest of the title behind.
    input.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key === 'Enter') {
        event.preventDefault()
        // Shift+Enter is how a textarea normally starts a new line and a mermaid
        // card title cannot hold one. Committing would drop the break *and* leave
        // the rest of what was typed behind in a field that has gone, so the field
        // stays open with the value the user has.
        if (!(event as KeyboardEvent).shiftKey) finish(true)
      } else if (key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
      event.stopPropagation()
    })
    input.addEventListener('pointerdown', (event) => event.stopPropagation())
    // Clicking away commits, as a click anywhere else in the editor does.
    input.addEventListener('blur', () => finish(true))

    if (spec.multiline) {
      // Sized by what is being typed, not by the slot it replaced: a card title
      // is longer than the card-shaped box it was opened from more often than
      // not, and a fixed box either scrolls the rest of the title out of sight or
      // covers the columns behind it with a field nothing is being typed into.
      input.style.height = 'auto'
      input.addEventListener('input', () => {
        input.style.height = 'auto'
        input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
        // Past the cap the field stops climbing and scrolls: the point is that
        // the whole title is *reachable*, not that it can eat the board.
        input.style.overflowY = input.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
        spec.subject.grow?.(state.subject ?? found, input as HTMLTextAreaElement)
        this.schedule()
      })
    }

    element.appendChild(input)
    this.preview.appendChild(element)
    this.field = { spec, element, input, state, close }
    release = this.start('text', finish)

    unplace = this.overlay(
      element,
      () => {
        const at = box()
        // As wide as the thing it stood in when it opened, with a floor for one
        // too narrow to type a name into. Sized from `state.size` rather than from
        // `at`: `at` is the *live* box, and for a card that is a box this very
        // field is stretching.
        element.style.width = `${Math.max(state.size.width, spec.minWidth ?? 0, 40)}px`
        if (spec.multiline) {
          input.style.minHeight = `${state.size.height || 20}px`
        } else {
          element.style.height = `${state.size.height || 20}px`
        }
        return at
      },
      fit,
    )

    // A click inside the field is a click in the field, not a click on whatever
    // label happens to lie underneath — which is how opening a field over a card
    // would otherwise close itself and open the card's rename.
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      element.addEventListener(type, (event) => event.stopPropagation())
    }

    // The field's box is final once the browser has laid it out, which is the
    // next frame.
    this.settle = requestAnimationFrame(() => {
      this.settle = 0
      fit()
      this.schedule()
    })
    input.focus()
    // The caret at the end of what is there: selecting all would make a press
    // elsewhere read as "replace", and then force it to be deselected with a
    // second click.
    input.setSelectionRange(input.value.length, input.value.length)
  }

  /** The subject the open field is replacing, when there is a field open. */
  get openSubject(): Element | null {
    return this.field?.state.subject ?? null
  }

  /** A transient message over the block, replacing any other one. */
  notice(text: string, detail: string): void {
    this.block.querySelector(`.${NOTICE_CLASS}`)?.remove()
    const notice = document.createElement('div')
    notice.className = NOTICE_CLASS
    notice.textContent = text
    notice.title = detail
    this.block.appendChild(notice)
    setTimeout(() => notice.remove(), 3000)
  }

  /**
   * A render has landed. Put the field back if it went with the drawing, move it
   * to the subject it is editing in the new one, and resolve it if that subject is
   * not there any more.
   *
   * This is where "a field outlives a render" is kept, and it has an answer for
   * both cases rather than for one of them: a board redrawn by a theme change, a
   * zoom, a re-layout, or by a document edit that has nothing to do with this
   * field keeps the field open with what was typed — and the caret with it, since
   * a detached input loses it silently; a field whose subject was deleted or
   * renamed out from under it is finished rather than left committing a patch that
   * cannot resolve.
   */
  reanchor(): void {
    const open = this.field
    if (open === null) return
    // The render replaced the preview's contents, and the field is a child of the
    // preview, so it went with them. It is the session's, not the drawing's: put
    // it back before anything reads its box.
    const strayed = !open.element.isConnected
    if (strayed) this.preview.appendChild(open.element)
    const next = open.spec.subject.locate(this.render)
    if (next === null) {
      this.finish(false)
      return
    }
    if (next !== open.state.subject) {
      if (open.state.subject !== null) open.spec.subject.leave(open.state.subject)
      open.spec.subject.enter(next)
      open.state.subject = next
      // A different subject is a different box to be sized by: a card is drawn at
      // its own height and a re-anchored field has to take that one, not the one
      // it happened to be stretched to over the card it left.
      const at = open.spec.subject.box(next)
      open.state.size = { width: at.width, height: at.height }
    }
    this.place()
    if (strayed) {
      open.input.focus()
      open.input.setSelectionRange(open.input.value.length, open.input.value.length)
    }
    this.schedule()
  }
}

// ── one session per block ─────────────────────────────────────────────────

const sessions = new WeakMap<HTMLElement, DiagramSession>()

/** The session for `block`, creating it the first time it is asked for. */
export function sessionFor(block: HTMLElement, commit: (drawn: string) => void): DiagramSession {
  const existing = sessions.get(block)
  if (existing !== undefined) return existing
  const preview = block.querySelector<HTMLElement>('.mermaid-preview') ?? block
  const session = new DiagramSession({ block, preview, commit })
  sessions.set(block, session)
  return session
}

/**
 * Take a block out of edit mode without forgetting it: the layer and its controls
 * go, a field in progress is accepted, and the session lives on so that renders
 * keep being ordered against each other across the mode change. A render without
 * a commit handler is exactly this, which is why `renderDiagram` reaches for it
 * rather than for `endSession`.
 */
export function stopEditing(block: Node | null | undefined, accept = true): void {
  if (!(block instanceof HTMLElement)) return
  sessions.get(block)?.setEditing(false, accept)
}

/**
 * End a block's session for good and forget it, which is what a block that is
 * going away needs: a rebuilt preview (the scroller the overlays are placed in
 * is being replaced) or a destroyed node view. Leaving edit mode is
 * `stopEditing` instead — the session outlives the mode, because it is what
 * orders the renders either side of the change.
 */
export function endSession(block: Node | null | undefined, accept = true): void {
  if (!(block instanceof HTMLElement)) return
  const session = sessions.get(block)
  if (session === undefined) return
  sessions.delete(block)
  session.end(accept)
}
