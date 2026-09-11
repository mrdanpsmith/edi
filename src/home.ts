export interface HomeActions {
  onNew(): void
  onOpen(): void
  onOpenWelcome(): void
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

export class HomeScreen {
  private readonly actions: HomeActions
  private readonly list: HTMLUListElement
  private readonly toggle: HTMLButtonElement

  constructor(root: HTMLElement, actions: HomeActions) {
    this.actions = actions
    element(root, '#home-new').addEventListener('click', () => actions.onNew())
    element(root, '#home-open').addEventListener('click', () => actions.onOpen())
    element(root, '#home-welcome').addEventListener('click', () => actions.onOpenWelcome())
    element(root, '#home-exit').addEventListener('click', () => actions.onExit())
    this.toggle = element(root, '#home-recent-toggle') as HTMLButtonElement
    this.list = element(root, '#home-recent-list') as HTMLUListElement
    this.toggle.addEventListener('click', () => {
      this.list.hidden = !this.list.hidden
    })
  }

  setRecents(paths: string[]): void {
    this.list.replaceChildren()
    this.list.hidden = true
    for (const path of paths) {
      const item = document.createElement('li')
      item.dataset.path = path
      item.textContent = path.split('/').pop() ?? path
      item.addEventListener('click', () => this.actions.onOpenRecent(path))
      this.list.appendChild(item)
    }
    this.toggle.hidden = paths.length === 0
  }
}