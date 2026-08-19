import {
  activateSession,
  closeSession,
  createSession,
  getActive,
  getState,
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
}

export class Tabs {
  private readonly snapshots = new Map<string, string>()

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
    this.snapshots.set(active.id, this.content.getMarkdown())
  }

  addSession(content = ''): void {
    this.snapshotActive()
    const id = createSession()
    this.snapshots.set(id, content)
    this.content.setMarkdown(content)
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
    const markdown = this.snapshots.get(active.id) ?? ''
    this.content.setMarkdown(markdown)
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
