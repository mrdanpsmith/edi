export interface HomeActions {
  onNew(): void
  onOpen(): void
  onOpenPath(): void
  onOpenWelcome(): void
  onOpenHelpGuide(): void
  onOpenFunctionReference(): void
  onExit(): void
  onOpenRecent(path: string): void
}

function element(root: HTMLElement, selector: string): HTMLElement {
  const node = root.querySelector(selector)
  if (!node) {
    throw new Error(`Missing home screen element ${selector}`)
  }
  return node as HTMLElement
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : ''
}

/**
 * The launcher: shown on its own when no tab is open, and inside a launcher tab
 * (`#app[data-view='launcher']`). One element serves both, so the recent list
 * is filled once and is current in either.
 */
export class HomeScreen {
  private readonly actions: HomeActions
  private readonly recent: HTMLElement
  private readonly list: HTMLUListElement
  private readonly newButton: HTMLButtonElement

  constructor(root: HTMLElement, actions: HomeActions) {
    this.actions = actions
    this.newButton = element(root, '#home-new') as HTMLButtonElement
    this.newButton.addEventListener('click', () => actions.onNew())
    element(root, '#home-open').addEventListener('click', () => actions.onOpen())
    element(root, '#home-open-path').addEventListener('click', () => actions.onOpenPath())
    element(root, '#home-welcome').addEventListener('click', () => actions.onOpenWelcome())
    element(root, '#home-help').addEventListener('click', () => actions.onOpenHelpGuide())
    element(root, '#home-functions').addEventListener('click', () =>
      actions.onOpenFunctionReference(),
    )
    element(root, '#home-exit').addEventListener('click', () => actions.onExit())
    this.recent = element(root, '#home-recent')
    this.list = element(root, '#home-recent-list') as HTMLUListElement
    this.list.addEventListener('keydown', (event) => this.onListKey(event))
  }

  setRecents(paths: string[]): void {
    this.list.replaceChildren()
    for (const path of paths) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'home-recent-item'
      button.dataset.path = path
      button.title = path
      const name = document.createElement('span')
      name.className = 'home-recent-name'
      name.textContent = path.split('/').pop() ?? path
      const folder = document.createElement('span')
      folder.className = 'home-recent-folder'
      folder.textContent = folderOf(path)
      button.append(name, folder)
      button.addEventListener('click', () => this.actions.onOpenRecent(path))
      item.appendChild(button)
      this.list.appendChild(item)
    }
    this.recent.hidden = paths.length === 0
  }

  /**
   * Put the keyboard on the launcher as it comes into view: on the most
   * recent document when there is one, so Enter reopens it, else on New.
   */
  focus(): void {
    const first = this.items()[0] ?? this.newButton
    first.focus({ preventScroll: true })
  }

  private items(): HTMLButtonElement[] {
    return [...this.list.querySelectorAll<HTMLButtonElement>('.home-recent-item')]
  }

  /** Up/Down (and Home/End) walk the recent list; Enter is the button's own. */
  private onListKey(event: KeyboardEvent): void {
    const items = this.items()
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    let next: number
    if (event.key === 'ArrowDown') next = Math.min(items.length - 1, index + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else return
    event.preventDefault()
    items[next]!.focus()
  }
}
