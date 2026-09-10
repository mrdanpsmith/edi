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
  setMarkdown(value: string): void
  // Optional per-tab editor-state API. When all three are present Tabs stores
  // each session's whole editor state (own doc, own undo/redo history, own
  // selection) and swaps states instead of text, so tabs are fully isolated.
  createState?(markdown: string): unknown
  getState?(): unknown
  setState?(state: unknown): void
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

  constructor(
    private readonly tabbar: HTMLElement,
    private readonly content: TabContent,
    private readonly callbacks: TabCallbacks,
  ) {
    subscribe(() => this.render())
    this.addSession()
  }

  get activeId(): string {
    return getActive()?.id ?? ''
  }

  snapshotActive(): void {
    const active = getActive()
    if (!active) return
    if (this.appliedSession !== active.id) {
      // The view is not known to hold this session's document (e.g. a stray
      // transaction desynced it). Do not overwrite the session's last known
      // snapshot with foreign content.
      return
    }
    if (this.supportsStates()) {
      this.states.set(active.id, this.content.getState!())
    } else {
      this.snapshots.set(active.id, this.content.getMarkdown())
    }
    this.scrolls.set(active.id, this.content.getScroll?.() ?? 0)
  }

  setActiveContent(markdown: string, scrollTop = 0): void {
    const active = getActive()
    if (!active) return
    if (this.supportsStates()) {
      const state = this.content.createState!(markdown)
      this.states.set(active.id, state)
      this.content.setState!(state)
    } else {
      this.content.setMarkdown(markdown)
      this.snapshots.set(active.id, markdown)
    }
    this.content.setScroll?.(scrollTop)
    this.appliedSession = active.id
  }

  addSession(content = '', path: string | null = null): void {
    this.snapshotActive()
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
    if (this.supportsStates()) {
      this.content.setState!(this.states.get(id))
    } else {
      this.content.setMarkdown(content)
    }
    this.content.setScroll?.(0)
    this.appliedSession = id
    this.render()
    this.notifyActive()
  }

  activate(id: string): void {
    if (id === this.activeId) return
    this.snapshotActive()
    if (!activateSession(id)) return
    this.restoreActive()
    this.notifyActive()
  }

  close(id: string): void {
    this.snapshotActive()
    const nextActive = closeSession(id)
    this.snapshots.delete(id)
    this.states.delete(id)
    if (nextActive === null) {
      this.addSession()
      return
    }
    this.restoreActive()
    this.render()
    this.notifyActive()
  }

  getMarkdownSnapshot(id: string): string | undefined {
    return this.snapshots.get(id)
  }

  private restoreActive(): void {
    const active = getActive()
    if (!active) return
    if (this.supportsStates()) {
      this.content.setState!(this.states.get(active.id))
    } else {
      const markdown = this.snapshots.get(active.id) ?? ''
      this.content.setMarkdown(markdown)
    }
    this.content.setScroll?.(this.scrolls.get(active.id) ?? 0)
    this.appliedSession = active.id
  }

  private supportsStates(): boolean {
    return Boolean(
      this.content.createState && this.content.getState && this.content.setState,
    )
  }

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

    this.tabbar.replaceChildren(...nodes, add)
  }
}
