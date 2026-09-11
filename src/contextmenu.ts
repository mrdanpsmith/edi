export interface ContextMenuItem {
  type: 'item'
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

export interface ContextMenuSeparator {
  type: 'separator'
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator

export interface MenuPosition {
  left: number
  top: number
}

/** Distance the menu keeps from the viewport edges when clamped. */
const EDGE_MARGIN = 4

/**
 * Position a menu so it opens at the pointer while staying fully inside the
 * viewport. The pointer coordinate is the anchor: when the menu would overflow
 * the bottom/right edge it is shifted up/left, but never above/top-left of the
 * pointer otherwise.
 */
export function computeMenuPosition(
  menuWidth: number,
  menuHeight: number,
  pointerX: number,
  pointerY: number,
  viewportWidth: number,
  viewportHeight: number,
): MenuPosition {
  const maxLeft = Math.max(EDGE_MARGIN, viewportWidth - menuWidth - EDGE_MARGIN)
  const maxTop = Math.max(EDGE_MARGIN, viewportHeight - menuHeight - EDGE_MARGIN)
  return {
    left: Math.max(EDGE_MARGIN, Math.min(pointerX, maxLeft)),
    top: Math.max(EDGE_MARGIN, Math.min(pointerY, maxTop)),
  }
}

interface MenuItemRef {
  entry: ContextMenuItem
  button: HTMLButtonElement
}

/**
 * A small keyboard-navigable context menu. Replaces the native browser menu
 * (which the backend suppresses); the caller builds the entries and supplies
 * the pointer coordinates from a `contextmenu` event.
 */
export class ContextMenu {
  private menuEl: HTMLDivElement | null = null
  private itemRefs: MenuItemRef[] = []
  private activeIndex = -1
  private lastFocused: HTMLElement | null = null

  constructor(private readonly container: HTMLElement = document.body) {}

  get isOpen(): boolean {
    return this.menuEl !== null
  }

  show(entries: ContextMenuEntry[], x: number, y: number): void {
    this.hide()

    const menu = document.createElement('div')
    menu.className = 'edi-context-menu'
    menu.setAttribute('role', 'menu')
    menu.tabIndex = -1
    this.menuEl = menu
    this.itemRefs = []
    this.activeIndex = -1

    for (const entry of entries) {
      if (entry.type === 'separator') {
        const separator = document.createElement('div')
        separator.className = 'edi-menu-separator'
        separator.setAttribute('aria-hidden', 'true')
        menu.appendChild(separator)
        continue
      }
      const button = this.createButton(entry)
      this.itemRefs.push({ entry, button })
      menu.appendChild(button)
    }

    this.container.appendChild(menu)
    const position = computeMenuPosition(
      menu.offsetWidth,
      menu.offsetHeight,
      x,
      y,
      window.innerWidth,
      window.innerHeight,
    )
    menu.style.left = `${position.left}px`
    menu.style.top = `${position.top}px`

    menu.addEventListener('keydown', this.onKeyDown)
    this.lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // preventScroll keeps QtWebEngine from scrolling the editor to the focused
    // menu when it opens next to a right-click near the viewport edges.
    menu.focus({ preventScroll: true })

    // Capture listeners so any interaction outside the menu (a pointer press,
    // scrolling of the editor, window resize/blur) dismisses it immediately.
    document.addEventListener('pointerdown', this.onPointerDown, true)
    document.addEventListener('scroll', this.onDismiss, true)
    window.addEventListener('resize', this.onDismiss)
    window.addEventListener('blur', this.onDismiss)
  }

  hide(): void {
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('scroll', this.onDismiss, true)
    window.removeEventListener('resize', this.onDismiss)
    window.removeEventListener('blur', this.onDismiss)
    this.menuEl?.removeEventListener('keydown', this.onKeyDown)
    this.menuEl?.remove()
    this.menuEl = null
    this.itemRefs = []
    this.activeIndex = -1
    this.lastFocused = null
  }

  private createButton(entry: ContextMenuItem): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'edi-menu-item'
    button.setAttribute('role', 'menuitem')
    button.textContent = entry.label
    button.disabled = entry.disabled === true
    button.classList.toggle('danger', entry.danger === true)
    // Keep the caret (and focus) out of the menu item's label; the click
    // handler below still runs, so the action completes on mouse-up.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => this.select(entry))
    button.addEventListener('mouseenter', () => {
      const index = this.itemRefs.findIndex((ref) => ref.button === button)
      this.setActive(index, false)
    })
    return button
  }

  private select(entry: ContextMenuItem): void {
    this.closeWithFocusRestore()
    entry.onSelect()
  }

  /** Hide without moving focus (picking a command already focuses where needed). */
  private onDismiss = (): void => {
    this.hide()
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.menuEl && !this.menuEl.contains(event.target as Node)) {
      this.hide()
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        this.closeWithFocusRestore()
        break
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        this.move(event.key === 'ArrowDown' ? 1 : -1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (this.activeIndex >= 0) {
          const ref = this.itemRefs[this.activeIndex]
          if (ref) this.select(ref.entry)
        }
        break
    }
  }

  private closeWithFocusRestore(): void {
    const restore = this.lastFocused
    this.hide()
    if (restore?.isConnected) restore.focus({ preventScroll: true })
  }

  private move(delta: number): void {
    const count = this.itemRefs.length
    if (count === 0) return
    let index = this.activeIndex
    if (index === -1) index = delta > 0 ? -1 : 0
    for (let step = 0; step < count; step++) {
      index = (index + delta + count) % count
      if (!this.itemRefs[index]!.entry.disabled) break
    }
    this.setActive(index, true)
  }

  private setActive(index: number, scrollTo: boolean): void {
    let newIndex = -1
    if (index >= 0 && index < this.itemRefs.length && !this.itemRefs[index]!.entry.disabled) {
      newIndex = index
    }
    this.activeIndex = newIndex
    for (let i = 0; i < this.itemRefs.length; i++) {
      this.itemRefs[i]!.button.classList.toggle('active', i === newIndex)
    }
    if (scrollTo && newIndex >= 0) {
      this.itemRefs[newIndex]!.button.scrollIntoView?.({ block: 'nearest' })
    }
  }
}