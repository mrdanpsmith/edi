import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeScreen, type HomeActions } from './home'

const HOME_TEMPLATE = `
  <h1>Edi</h1>
  <p class="home-subtitle">Markdown editor with Mermaid, spreadsheets, and more</p>
  <div class="home-action-row">
    <button type="button" class="home-btn home-primary" id="home-new">New</button>
    <button type="button" class="home-btn home-primary" id="home-open">Open…</button>
    <button type="button" class="home-btn home-primary" id="home-open-path">Open Path…</button>
  </div>
  <div class="home-recent" id="home-recent" hidden>
    <h2 class="home-section-title">Recent</h2>
    <ul id="home-recent-list"></ul>
  </div>
  <div class="home-action-row">
    <button type="button" class="home-btn" id="home-welcome">Welcome</button>
    <button type="button" class="home-btn" id="home-help">Help Guide</button>
    <button type="button" class="home-btn" id="home-functions">Function Reference</button>
    <button type="button" class="home-btn" id="home-exit">Exit</button>
  </div>
  <p class="home-hint">Ctrl+N new · Ctrl+T new tab · Ctrl+O open</p>
`

function makeActions(): HomeActions {
  return {
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onOpenPath: vi.fn(),
    onOpenWelcome: vi.fn(),
    onOpenHelpGuide: vi.fn(),
    onOpenFunctionReference: vi.fn(),
    onExit: vi.fn(),
    onOpenRecent: vi.fn(),
  }
}

let root: HTMLElement
let actions: HomeActions

beforeEach(() => {
  document.body.innerHTML = `<section id="home-screen">${HOME_TEMPLATE}</section>`
  root = document.querySelector<HTMLElement>('#home-screen')!
  actions = makeActions()
})

function build(): HomeScreen {
  return new HomeScreen(root, actions)
}

function button(id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(id)!
}

describe('HomeScreen buttons', () => {
  it('routes clicks to the expected callbacks', () => {
    build()
    button('#home-new').click()
    button('#home-open').click()
    button('#home-open-path').click()
    button('#home-welcome').click()
    button('#home-help').click()
    button('#home-functions').click()
    button('#home-exit').click()
    expect(actions.onNew).toHaveBeenCalledTimes(1)
    expect(actions.onOpen).toHaveBeenCalledTimes(1)
    expect(actions.onOpenPath).toHaveBeenCalledTimes(1)
    expect(actions.onOpenWelcome).toHaveBeenCalledTimes(1)
    expect(actions.onOpenHelpGuide).toHaveBeenCalledTimes(1)
    expect(actions.onOpenFunctionReference).toHaveBeenCalledTimes(1)
    expect(actions.onExit).toHaveBeenCalledTimes(1)
  })
})

function recentItems(): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('.home-recent-item')]
}

describe('HomeScreen.setRecents', () => {
  it('lists each path by name with its folder underneath', () => {
    build().setRecents(['/x/a.md', '/y/z/b.md'])
    const items = recentItems()
    expect(items).toHaveLength(2)
    expect(items[0]?.querySelector('.home-recent-name')?.textContent).toBe('a.md')
    expect(items[0]?.querySelector('.home-recent-folder')?.textContent).toBe('/x')
    expect(items[1]?.querySelector('.home-recent-folder')?.textContent).toBe('/y/z')
    expect(items[1]?.title).toBe('/y/z/b.md')
    expect(button('#home-recent').hidden).toBe(false)
  })

  it('fires onOpenRecent when an entry is clicked', () => {
    build().setRecents(['/a.md', '/b.md'])
    recentItems()[1]!.click()
    expect(actions.onOpenRecent).toHaveBeenCalledWith('/b.md')
  })

  it('replaces the list on a second call without duplicates', () => {
    const screen = build()
    screen.setRecents(['/a.md', '/b.md'])
    screen.setRecents(['/a.md'])
    expect(recentItems().map((item) => item.dataset.path)).toEqual(['/a.md'])
  })

  it('hides the section when there are no recents', () => {
    const screen = build()
    screen.setRecents(['/a.md'])
    screen.setRecents([])
    expect(button('#home-recent').hidden).toBe(true)
  })
})

describe('HomeScreen keyboard', () => {
  it('focuses the most recent document, or New when there is none', () => {
    const screen = build()
    screen.focus()
    expect(document.activeElement).toBe(button('#home-new'))
    screen.setRecents(['/a.md', '/b.md'])
    screen.focus()
    expect(document.activeElement).toBe(recentItems()[0])
  })

  it('walks the recent list with the arrow keys, Home and End', () => {
    const screen = build()
    screen.setRecents(['/a.md', '/b.md', '/c.md'])
    screen.focus()
    const press = (key: string): void => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    }
    const focused = (): string | undefined => (document.activeElement as HTMLElement).dataset.path
    press('ArrowDown')
    expect(focused()).toBe('/b.md')
    press('End')
    expect(focused()).toBe('/c.md')
    press('ArrowDown')
    expect(focused()).toBe('/c.md')
    press('ArrowUp')
    expect(focused()).toBe('/b.md')
    press('Home')
    expect(focused()).toBe('/a.md')
  })
})