import {
  activateSession,
  closeSession,
  createSession,
  getActive,
  getState,
  setActivePath,
  subscribe,
} from './state'

export interface TabCallbacks {
  onNewTab(): void
  onCloseTab(id: string): void
  onActivate(id: string): void
}

export interface TabContent {
  getMarkdown(): string
  setMarkdown(value: string): void | Promise<void>
  // Optional per-tab editor-state API. When all three are present Tabs stores
  // each session's whole editor state (own doc, own undo/redo history, own
  // selection) and swaps states instead of text, so tabs are fully isolated.
  createState?(markdown: string): unknown
  getState?(): unknown
  setState?(state: unknown): void | Promise<void>
  /**
   * Commit anything that is not in the document yet but would be lost by leaving it —
   * today, an open encrypted block's half-second of un-persisted typing.
   *
   * Awaited **at the snapshot boundary** rather than only at the swap, and that is the
   * part worth stating: a snapshot is taken by reading the live state, so a flush that
   * ran later would store the pre-flush document and the tab would come back to text
   * the reader had already watched vanish once. Whatever else is pending has to be
   * written before the copy is taken, not merely before the view moves on.
   */
  flush?(): void | Promise<void>
  /**
   * Forget pending commits instead of writing them, because the document they belong
   * to is being replaced rather than left. See `discardOpenReveals`.
   */
  discardPending?(): void
  getScroll?(): number
  setScroll?(value: number): void
}

export class Tabs {
  private readonly snapshots = new Map<string, string>()
  private readonly states = new Map<string, unknown>()
  private readonly scrolls = new Map<string, number>()
  // The session whose document is currently rendered in the shared editor
  // view. Snapshotting must never write the view's contents under a session
  // that does not own them — a desynced view would poison that tab's snapshot
  // with another tab's content.
  private appliedSession = ''
  // Every operation that reads or replaces the shared editor's contents runs here,
  // one at a time. Two reasons, and the second is the one that arrived with it:
  //
  //  - **Re-entrancy.** Each of these is a read followed by a write (snapshot the
  //    outgoing tab, then swap the incoming one in). Making any step awaitable opens
  //    a window in which a second tab switch can interleave between the two halves.
  //  - **The editor can now take a moment to answer.** `setState` has to flush an open
  //    encrypted block before it replaces the state, and encrypting is asynchronous.
  //
  // So the queue is not a nicety bolted onto a sync design — it is what makes the two
  // halves of "leave this document, arrive at that one" a single indivisible step
  // again. `appliedSession` was the same instinct in miniature: the view must not be
  // snapshotted under the wrong tab, and a promise is just another way to get it wrong.
  private queue: Promise<unknown> = Promise.resolve()
  /** Non-null exactly while a swap that had to wait is still going. */
  private running: Promise<void> | null = null
  private readonly scroll: HTMLDivElement
  private readonly leftButton: HTMLButtonElement
  private readonly rightButton: HTMLButtonElement
  private readonly resizeObserver?: ResizeObserver
  private readonly unsubscribe: () => void

  constructor(
    private readonly tabbar: HTMLElement,
    private readonly content: TabContent,
    private readonly callbacks: TabCallbacks,
  ) {
    // The tab strip is a persistent shell (left/right arrow buttons flanking
    // a scroll viewport); only the tabs inside the viewport are re-rendered,
    // so the scroll position survives tab add/close/activate.
    this.scroll = document.createElement('div')
    this.scroll.className = 'tabbar-scroll'
    this.scroll.setAttribute('role', 'tablist')
    this.scroll.setAttribute('aria-label', 'Documents')
    this.scroll.addEventListener('scroll', () => this.updateArrows())

    this.leftButton = document.createElement('button')
    this.leftButton.type = 'button'
    this.leftButton.className = 'tab-arrow tab-arrow-left'
    this.leftButton.ariaLabel = 'Scroll tabs left'
    this.leftButton.title = 'Scroll tabs left'
    this.leftButton.textContent = '‹'
    this.leftButton.addEventListener('click', () => this.scrollTabs(-1))

    this.rightButton = document.createElement('button')
    this.rightButton.type = 'button'
    this.rightButton.className = 'tab-arrow tab-arrow-right'
    this.rightButton.ariaLabel = 'Scroll tabs right'
    this.rightButton.title = 'Scroll tabs right'
    this.rightButton.textContent = '›'
    this.rightButton.addEventListener('click', () => this.scrollTabs(1))

    this.tabbar.replaceChildren(this.leftButton, this.scroll, this.rightButton)

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateArrows())
      this.resizeObserver.observe(this.scroll)
    }

    this.unsubscribe = subscribe(() => this.render())
  }

  /** Stop listening to state changes and to tab-strip resizes. */
  destroy(): void {
    this.unsubscribe()
    this.resizeObserver?.disconnect()
  }

  get activeId(): string {
    return getActive()?.id ?? ''
  }

  /**
   * Run one editor-touching operation, after every one already queued.
   *
   * **Runs it now when nothing is queued, and only chains when something is.** That is
   * not an optimisation, it is what keeps the timing every caller already has: an
   * editor swap only takes a microtask when something has to be encrypted first (see
   * `TabContent.flush`), and in every other case — which is every case for every
   * reader who has not typed into an open encrypted block in the last 600 ms — the
   * operation is finished before `enqueue` returns, exactly as it was before the
   * editor could be made to wait for anything. Code that swaps a document and reads it
   * back on the next line is the ordinary shape here, and a queue that always deferred
   * would silently break all of it.
   *
   * So the operations below are written as `void | Promise<void>` all the way down and
   * **never as `async`**. An `async` function is asynchronous *even when everything
   * inside it is synchronous*, and that alone was enough to make every tab operation
   * take a microtask — which is how this first attempt broke twenty unit tests that
   * assert on the session list on the line after a switch. `TabContent`'s three
   * operations return `void` precisely so this distinction can be made at all.
   */
  private enqueue(work: () => void | Promise<void>): Promise<void> {
    if (this.running === null) {
      let result: void | Promise<void>
      try {
        result = work()
      } catch (error) {
        // A failed swap must not wedge every tab switch after it, and there is nothing
        // useful a caller could do with it: these are state replacements.
        console.error('tab swap failed', error)
        return Promise.resolve()
      }
      if (result === undefined) return Promise.resolve()
      this.running = result.then(() => { this.running = null }, () => { this.running = null })
      return this.running
    }
    const run = this.queue.then(work)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Finish now if `step` had nothing to wait for, and after it if it did.
   *
   * The whole of "sometimes asynchronous", in one line, and the reason each operation
   * below reads as one expression rather than as two halves of a branch.
   */
  private static after(step: void | Promise<void>, finish: () => void): void | Promise<void> {
    if (step === undefined) {
      finish()
      return undefined
    }
    return step.then(finish)
  }

  snapshotActive(): void {
    void this.enqueue(() => this.snapshotActiveNow())
  }

  private snapshotActiveNow(): void | Promise<void> {
    const active = getActive()
    if (!active) return undefined
    if (this.appliedSession !== active.id) {
      // The view is not known to hold this session's document (e.g. a stray
      // transaction desynced it). Do not overwrite the session's last known
      // snapshot with foreign content.
      //
      // **This is reported rather than skipped quietly**, because the cost of
      // skipping quietly is paid much later and by someone else: the session
      // keeps its *previous* snapshot, the reader keeps typing into a view that
      // is already desynced, and switching away and back resurrects text they
      // have already watched disappear — the "this tab came back with another
      // tab's content" report, arriving with nothing in the log to connect it
      // to the moment it happened. A desync is a bug; say so at the moment it
      // is observable rather than after it has been laundered into a snapshot.
      console.error(
        `tab ${active.id} is active but the view holds ${this.appliedSession || '(nothing)'}; ` +
          'skipping the snapshot rather than storing another tab\'s document under it',
      )
      return undefined
    }
    // Before the read, not after: see `TabContent.flush`.
    return Tabs.after(this.content.flush?.(), () => {
      if (this.supportsStates()) {
        this.states.set(active.id, this.content.getState!())
      } else {
        this.snapshots.set(active.id, this.content.getMarkdown())
      }
      this.scrolls.set(active.id, this.content.getScroll?.() ?? 0)
    })
  }

  setActiveContent(markdown: string, scrollTop = 0): void {
    void this.enqueue(() => {
      const active = getActive()
      if (!active) return undefined
      // The document is being replaced, not left, so there is nothing to commit into.
      this.content.discardPending?.()
      const settle = (): void => {
        this.content.setScroll?.(scrollTop)
        this.appliedSession = active.id
        // Same contract as every other operation that changes what the view
        // holds: the caller is told once the new content is on screen. See
        // `notifyActive`.
        this.notifyActive()
      }
      if (this.supportsStates()) {
        const state = this.content.createState!(markdown)
        this.states.set(active.id, state)
        return Tabs.after(this.content.setState!(state), settle)
      }
      return Tabs.after(this.content.setMarkdown(markdown), () => {
        this.snapshots.set(active.id, markdown)
        settle()
      })
    })
  }

  addSession(content = '', path: string | null = null): void {
    void this.enqueue(() => {
      const snapshotted = this.snapshotActiveNow()
      const open = (): void | Promise<void> => {
        const id = createSession()
        // A brand-new tab starts scrolled to the top.
        this.scrolls.set(id, 0)
        if (this.supportsStates()) {
          this.states.set(id, this.content.createState!(content))
        } else {
          this.snapshots.set(id, content)
        }
        // Associate the new session with its path BEFORE rendering its content so
        // any relative image references resolve against the document's directory.
        if (path !== null) {
          setActivePath(path)
        }
        const settle = (): void => {
          this.content.setScroll?.(0)
          this.appliedSession = id
          this.render()
          this.notifyActive()
        }
        if (this.supportsStates()) {
          return Tabs.after(this.content.setState!(this.states.get(id)), settle)
        }
        return Tabs.after(this.content.setMarkdown(content), settle)
      }
      return Tabs.after(snapshotted, open)
    })
  }

  activate(id: string): void {
    void this.enqueue(() => {
      // Re-checked inside the queue, not before it: the tab the reader clicked may no
      // longer be the one this switch was for, because another switch is ahead of us.
      if (id === this.activeId) return undefined
      const snapshotted = this.snapshotActiveNow()
      return Tabs.after(snapshotted, () => {
        if (!activateSession(id)) return undefined
        return Tabs.after(this.restoreActive(), () => this.notifyActive())
      })
    })
  }

  close(id: string): void {
    void this.enqueue(() => {
      const snapshotted = this.snapshotActiveNow()
      return Tabs.after(snapshotted, () => {
        const nextActive = closeSession(id)
        this.snapshots.delete(id)
        this.states.delete(id)
        if (nextActive === null) {
          // No sessions left: stay on the home screen (data-view switches to
          // "home"), do not invent an empty tab.
          this.render()
          return undefined
        }
        return Tabs.after(this.restoreActive(), () => {
          this.render()
          this.notifyActive()
        })
      })
    })
  }

  getMarkdownSnapshot(id: string): string | undefined {
    return this.snapshots.get(id)
  }

  private restoreActive(): void | Promise<void> {
    const active = getActive()
    if (!active) return undefined
    // The scroll is part of `settle` rather than a line of its own, so it belongs to
    // the document that has **arrived** — with an `await` above it, it would be applied
    // to the document still on its way out, which is the bug the queue was added for.
    const settle = (): void => {
      this.content.setScroll?.(this.scrolls.get(active.id) ?? 0)
      this.appliedSession = active.id
    }
    if (this.supportsStates()) {
      return Tabs.after(this.content.setState!(this.states.get(active.id)), settle)
    }
    return Tabs.after(this.content.setMarkdown(this.snapshots.get(active.id) ?? ''), settle)
  }

  private supportsStates(): boolean {
    return Boolean(
      this.content.createState && this.content.getState && this.content.setState,
    )
  }

  /**
   * Tell the page which tab is now in view. **The one and only place it is
   * told**, and the reason is the shape of `enqueue`.
   *
   * Every operation that changes what the shared view holds is queued, and a
   * queued operation may return *before it has run*: `enqueue` executes the
   * work synchronously when nothing is ahead of it, but an open encrypted
   * block's `flush` is `crypto.subtle`'s asynchronous work, and from that
   * moment the swap finishes on a later turn. So a caller cannot read the state
   * it just asked to change on the line after asking — `getActive()` is still
   * the tab being left, and the view is still that tab's document. A caller that
   * wrote its own refresh there was refreshing the tab the reader was *leaving*,
   * which is how a status bar comes to show one tab's path and word count while
   * another is in view.
   *
   * Every operation therefore notifies from its own settle, after the content
   * has been applied, and no caller refreshes the chrome itself. `addSession`,
   * `activate` and `setActiveContent` all fire it; `close` fires it when
   * another tab takes over, and has nothing to say when none is left, because
   * then there is no tab in view to describe.
   *
   * `activate` on the tab that is *already* active is the one deliberate
   * exception, and it is not a swap at all — nothing is queued and nothing
   * moves, so it reports nothing. A caller that wants the chrome refreshed in
   * that case is asking about a tab that did not change, and has to say so.
   */
  private notifyActive(): void {
    this.callbacks.onActivate(this.activeId)
  }

  private render(): void {
    const { sessions, activeId } = getState()
    const nodes: HTMLElement[] = sessions.map((session) => {
      const tab = document.createElement('div')
      tab.className = session.id === activeId ? 'tab active' : 'tab'
      tab.setAttribute('role', 'tab')
      tab.tabIndex = 0
      tab.title = session.path ?? ''
      tab.setAttribute('aria-selected', String(session.id === activeId))

      const name = session.path ? session.path.split('/').pop()! : 'Untitled'
      const title = document.createElement('span')
      title.className = 'tab-title'
      title.textContent = session.dirty ? `* ${name}` : name

      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'tab-close'
      close.ariaLabel = `Close ${name}`
      close.textContent = '×'
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        this.callbacks.onCloseTab(session.id)
      })

      tab.addEventListener('click', () => this.activate(session.id))
      tab.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.activate(session.id)
        }
      })

      tab.append(title, close)
      return tab
    })

    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'tab-new'
    add.ariaLabel = 'New document'
    add.title = 'New document (Ctrl+N)'
    add.textContent = '+'
    add.addEventListener('click', () => this.callbacks.onNewTab())

    this.scroll.replaceChildren(...nodes, add)
    this.scrollActiveIntoView()
    this.updateArrows()
  }

  private scrollTabs(direction: number): void {
    const step = Math.max(160, Math.round(this.scroll.clientWidth * 0.8))
    this.scroll.scrollBy({ left: direction * step, behavior: 'smooth' })
  }

  private scrollActiveIntoView(): void {
    const active = this.scroll.querySelector<HTMLElement>('.tab.active')
    if (!active) return
    const left = active.offsetLeft
    const right = left + active.offsetWidth
    if (left < this.scroll.scrollLeft) {
      this.scroll.scrollLeft = left
    } else if (right > this.scroll.scrollLeft + this.scroll.clientWidth) {
      this.scroll.scrollLeft = right - this.scroll.clientWidth
    } else {
      return
    }
    this.updateArrows()
  }

  private updateArrows(): void {
    const { scrollLeft, scrollWidth, clientWidth } = this.scroll
    const overflows = scrollWidth > clientWidth + 1
    this.leftButton.hidden = !overflows
    this.rightButton.hidden = !overflows
    if (!overflows) return
    this.leftButton.disabled = scrollLeft <= 1
    this.rightButton.disabled = scrollLeft + clientWidth >= scrollWidth - 1
  }
}
