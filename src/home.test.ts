import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeScreen, type HomeActions } from './home'

const HOME_TEMPLATE = `
  <h1>Edi</h1>
  <p class="home-subtitle">Markdown editor with Mermaid, spreadsheets, and more</p>
  <div class="home-action-row">
    <button type="button" class="home-btn home-primary" id="home-new">New</button>
    <button type="button" class="home-btn home-primary" id="home-open">Open…</button>
  </div>
  <div class="home-recent-box">
    <button type="button" class="home-btn" id="home-recent-toggle">Recent documents</button>
    <ul id="home-recent-list" hidden></ul>
  </div>
  <div class="home-action-row">
    <button type="button" class="home-btn" id="home-welcome">Open Welcome</button>
    <button type="button" class="home-btn" id="home-exit">Exit</button>
  </div>
  <p class="home-hint">Ctrl+N new · Ctrl+O open</p>
`

function makeActions(): HomeActions {
  return {
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onOpenWelcome: vi.fn(),
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
  it('renders buttons and the hint', () => {
    expect(button('#home-new').textContent).toBe('New')
    expect(button('#home-open').textContent).toBe('Open…')
    expect(button('#home-welcome').textContent).toBe('Open Welcome')
    expect(button('#home-exit').textContent).toBe('Exit')
    expect(button('#home-recent-toggle').textContent).toBe('Recent documents')
    expect(root.querySelector('.home-hint')).not.toBeNull()
  })

  it('routes clicks to the expected callbacks', () => {
    build()
    button('#home-new').click()
    button('#home-open').click()
    button('#home-welcome').click()
    button('#home-exit').click()
    expect(actions.onNew).toHaveBeenCalledTimes(1)
    expect(actions.onOpen).toHaveBeenCalledTimes(1)
    expect(actions.onOpenWelcome).toHaveBeenCalledTimes(1)
    expect(actions.onExit).toHaveBeenCalledTimes(1)
  })

  it('toggles the recent list visibility', () => {
    build()
    const list = root.querySelector<HTMLUListElement>('#home-recent-list')!
    expect(list.hidden).toBe(true)
    button('#home-recent-toggle').click()
    expect(list.hidden).toBe(false)
    button('#home-recent-toggle').click()
    expect(list.hidden).toBe(true)
  })
})

describe('HomeScreen.setRecents', () => {
  it('populates the list with one entry per path', () => {
    build()
    build().setRecents(['/a.md', '/b.md'])
    const items = root.querySelectorAll<HTMLElement>('#home-recent-list li')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toBe('a.md')
    expect(items[1]?.textContent).toBe('b.md')
    expect(items[0]?.dataset.path).toBe('/a.md')
  })

  it('fires onOpenRecent when an entry is clicked', () => {
    build().setRecents(['/a.md', '/b.md'])
    const first = root.querySelector<HTMLElement>('#home-recent-list li')!
    first.click()
    expect(actions.onOpenRecent).toHaveBeenCalledWith('/a.md')
  })

  it('replaces the list on a second call without duplicates', () => {
    const screen = build()
    screen.setRecents(['/a.md', '/b.md'])
    screen.setRecents(['/a.md'])
    const items = root.querySelectorAll<HTMLElement>('#home-recent-list li')
    expect(items).toHaveLength(1)
    expect(items[0]?.dataset.path).toBe('/a.md')
  })

  it('hides the toggle when there are no recents', () => {
    build().setRecents([])
    expect(button('#home-recent-toggle').hidden).toBe(true)
  })
})