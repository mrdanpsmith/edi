import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeMenuPosition, ContextMenu, type ContextMenuEntry } from './contextmenu'

describe('computeMenuPosition', () => {
  it('opens at the pointer when there is room', () => {
    const pos = computeMenuPosition(180, 120, 300, 200, 1024, 768)
    expect(pos).toEqual({ left: 300, top: 200 })
  })

  it('shifts left when the menu would overflow the right edge', () => {
    const pos = computeMenuPosition(180, 120, 990, 100, 1024, 768)
    expect(pos.left).toBe(1024 - 180 - 4)
  })

  it('shifts up when the menu would overflow the bottom edge', () => {
    const pos = computeMenuPosition(180, 120, 100, 750, 1024, 768)
    expect(pos.top).toBe(768 - 120 - 4)
  })

  it('never goes negative even when the menu is larger than the viewport', () => {
    const pos = computeMenuPosition(2000, 1500, 10, 10, 1024, 768)
    expect(pos.left).toBeGreaterThanOrEqual(4)
    expect(pos.top).toBeGreaterThanOrEqual(4)
  })
})

interface Fixture {
  menu: ContextMenu
  container: HTMLElement
  onUndo: ReturnType<typeof vi.fn>
  onClick: ReturnType<typeof vi.fn>
  entries: ContextMenuEntry[]
}

function setup(): Fixture {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const onUndo = vi.fn()
  const onClick = vi.fn()
  const menu = new ContextMenu(container)
  const entries: ContextMenuEntry[] = [
    { type: 'item', label: 'Undo', onSelect: onUndo },
    { type: 'separator' },
    { type: 'item', label: 'Click me', onSelect: onClick },
  ]
  return { menu, container, onUndo, onClick, entries }
}

function teardown({ menu, container }: Fixture): void {
  menu.hide()
  container.remove()
}

function menuEl(fixture: Fixture): HTMLElement {
  return fixture.container.querySelector<HTMLElement>('.edi-context-menu')!
}

function buttons(fixture: Fixture): HTMLButtonElement[] {
  return Array.from(fixture.container.querySelectorAll<HTMLButtonElement>('.edi-menu-item'))
}

function key(fixture: Fixture, keyName: string): void {
  menuEl(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: keyName }))
}

describe('ContextMenu', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  it('renders items and separators in order', () => {
    const fixture = setup()
    fixture.menu.show(fixture.entries, 40, 40)
    expect(buttons(fixture).map((button) => button.textContent)).toEqual(['Undo', 'Click me'])
    expect(fixture.container.querySelectorAll('.edi-menu-separator')).toHaveLength(1)
    expect(fixture.menu.isOpen).toBe(true)
    teardown(fixture)
  })

  it('marks disabled items and skips them when navigating', () => {
    const fixture = setup()
    fixture.menu.show([
      { type: 'item', label: 'One', disabled: true, onSelect: vi.fn() },
      { type: 'item', label: 'Two', onSelect: vi.fn() },
    ], 0, 0)
    expect(buttons(fixture)[0]!.disabled).toBe(true)
    key(fixture, 'ArrowDown')
    expect(buttons(fixture)[1]!.classList.contains('active')).toBe(true)
    teardown(fixture)
  })

  it('selects the active item with Enter and hides the menu', () => {
    const fixture = setup()
    fixture.menu.show(fixture.entries, 0, 0)
    key(fixture, 'ArrowDown')
    key(fixture, 'Enter')
    expect(fixture.onUndo).toHaveBeenCalledTimes(1)
    expect(fixture.menu.isOpen).toBe(false)
    teardown(fixture)
  })

  it('closes on Escape and restores focus to the previously focused element', () => {
    const fixture = setup()
    const focusTarget = document.createElement('button')
    document.body.appendChild(focusTarget)
    focusTarget.focus()
    fixture.menu.show(fixture.entries, 0, 0)
    expect(document.activeElement).not.toBe(focusTarget)
    key(fixture, 'Escape')
    expect(fixture.menu.isOpen).toBe(false)
    expect(document.activeElement).toBe(focusTarget)
    focusTarget.remove()
    teardown(fixture)
  })

  it('closes when the user presses outside the menu', () => {
    const fixture = setup()
    fixture.menu.show(fixture.entries, 0, 0)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(fixture.menu.isOpen).toBe(false)
    teardown(fixture)
  })

  it('does not close when the pointer press is inside the menu', () => {
    const fixture = setup()
    fixture.menu.show(fixture.entries, 0, 0)
    menuEl(fixture).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(fixture.menu.isOpen).toBe(true)
    teardown(fixture)
  })

  it('fires the item action on click', () => {
    const fixture = setup()
    fixture.menu.show(fixture.entries, 0, 0)
    buttons(fixture)[1]!.click()
    expect(fixture.onClick).toHaveBeenCalledTimes(1)
    expect(fixture.menu.isOpen).toBe(false)
    teardown(fixture)
  })

  it('re-renders from scratch on every show call', () => {
    const fixture = setup()
    fixture.menu.show(fixture.entries, 500, 500)
    const firstMenu = menuEl(fixture)
    fixture.menu.show([{ type: 'item', label: 'Solo', onSelect: vi.fn() }], 10, 10)
    expect(menuEl(fixture)).not.toBe(firstMenu)
    expect(buttons(fixture).map((button) => button.textContent)).toEqual(['Solo'])
    teardown(fixture)
  })

  it('keeps the caret out of the menu item label on mousedown', () => {
    const fixture = setup()
    fixture.menu.show(fixture.entries, 0, 0)
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    buttons(fixture)[0]!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    teardown(fixture)
  })
})