import { beforeEach, describe, expect, it } from 'vitest'

import { closeSession, getActive, getState, setActiveDirty } from './state'
import { Tabs, type TabContent } from './tabs'

function makeContent(): TabContent & { value: string } {
  let value = ''
  return {
    get value() { return value },
    getMarkdown() { return value },
    setMarkdown(v: string) { value = v },
  }
}

function setup(): {
  tabs: Tabs
  tabbar: HTMLElement
  content: ReturnType<typeof makeContent>
  activeIds: string[]
} {
  const tabbar = document.createElement('div')
  document.body.append(tabbar)
  const activeIds: string[] = []
  const content = makeContent()
  const tabs = new Tabs(tabbar, content, {
    onNewTab: () => tabs.addSession(),
    onCloseTab: (id) => tabs.close(id),
    onActivate: (id) => activeIds.push(id),
  })
  return { tabs, tabbar, content, activeIds }
}

beforeEach(() => {
  const { sessions } = getState()
  for (const session of sessions) {
    closeSession(session.id)
  }
})

describe('Tabs', () => {
  it('creates an initial Untitled tab', () => {
    const { tabbar } = setup()
    expect(getState().sessions).toHaveLength(1)
    expect(getActive()?.path).toBeNull()
    expect(tabbar.querySelectorAll('.tab')).toHaveLength(1)
    expect(tabbar.querySelector('.tab-title')?.textContent).toBe('Untitled')
  })

  it('adds a session and shows its content', () => {
    const { tabs, content } = setup()
    const first = getActive()!.id
    tabs.addSession('hello')
    expect(getState().sessions).toHaveLength(2)
    expect(getActive()?.id).not.toBe(first)
    expect(content.getMarkdown()).toBe('hello')
  })

  it('restores per-tab content when activating', () => {
    const { tabs, content } = setup()
    const first = getActive()!.id
    tabs.addSession('second doc')
    tabs.addSession('third doc')
    tabs.activate(first)
    expect(getActive()?.id).toBe(first)
    expect(content.getMarkdown()).toBe('')
    tabs.activate(getState().sessions[2]!.id)
    expect(content.getMarkdown()).toBe('third doc')
  })

  it('renders exactly one active tab', () => {
    const { tabs, tabbar } = setup()
    const first = getActive()!.id
    tabs.addSession('x')
    tabs.activate(first)
    const tabEls = Array.from(tabbar.querySelectorAll('.tab'))
    expect(tabEls.filter((tab) => tab.classList.contains('active'))).toHaveLength(1)
    expect(tabEls[0]!.classList.contains('active')).toBe(true)
  })

  it('marks dirty tabs in the title', () => {
    const { tabbar } = setup()
    setActiveDirty(true)
    expect(tabbar.querySelector('.tab-title')?.textContent).toBe('* Untitled')
    setActiveDirty(false)
    expect(tabbar.querySelector('.tab-title')?.textContent).toBe('Untitled')
  })

  it('closes a tab and activates its neighbor', () => {
    const { tabs } = setup()
    const first = getActive()!.id
    tabs.addSession('second')
    const second = getActive()!.id
    tabs.close(second)
    expect(getState().sessions).toHaveLength(1)
    expect(getActive()?.id).toBe(first)
  })

  it('switches tabs when a tab is clicked', () => {
    const { tabs, tabbar, content } = setup()
    const first = getActive()!.id
    tabs.addSession('second doc')
    const second = getActive()!.id
    const tabEls = tabbar.querySelectorAll<HTMLElement>('.tab')
    tabEls[0]!.click()
    expect(getActive()?.id).toBe(first)
    expect(content.getMarkdown()).toBe('')
    tabEls[1]!.click()
    expect(getActive()?.id).toBe(second)
    expect(content.getMarkdown()).toBe('second doc')
  })

  it('creates a fresh tab when the last one closes', () => {
    const { tabs, content } = setup()
    tabs.close(getActive()!.id)
    expect(getState().sessions).toHaveLength(1)
    expect(content.getMarkdown()).toBe('')
  })

  it('notifies activation through the callback', () => {
    const { tabs, activeIds } = setup()
    const first = activeIds[0]
    tabs.addSession('x')
    expect(activeIds.at(-1)).toBe(getActive()?.id)
    tabs.activate(first!)
    expect(activeIds.at(-1)).toBe(first)
  })

  it('ignores activating the already-active tab', () => {
    const { tabs, activeIds } = setup()
    const id = getActive()!.id
    const before = activeIds.length
    tabs.activate(id)
    expect(activeIds.length).toBe(before)
    expect(getActive()?.id).toBe(id)
  })

  it('ignores activating a tab that does not exist', () => {
    const { tabs, content } = setup()
    tabs.addSession('second doc')
    tabs.activate('does-not-exist')
    expect(getActive()?.id).not.toBe('does-not-exist')
    expect(content.getMarkdown()).toBe('second doc')
  })

  it('activates a tab with Enter or Space', () => {
    const { tabs, tabbar } = setup()
    const first = getActive()!.id
    tabs.addSession('second doc')
    const second = getActive()!.id

    const tabEls = tabbar.querySelectorAll<HTMLElement>('.tab')
    tabEls[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(getActive()?.id).toBe(first)
    tabEls[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(getActive()?.id).toBe(second)
  })

  it('closes a tab from its close button', () => {
    const { tabs, tabbar } = setup()
    const first = getActive()!.id
    tabs.addSession('second doc')
    const second = getActive()!.id

    const closeButtons = tabbar.querySelectorAll<HTMLButtonElement>('.tab-close')
    closeButtons[0]!.click()
    expect(getState().sessions).toHaveLength(1)
    expect(getState().sessions[0]!.id).toBe(second)
    expect(getActive()?.id).toBe(second)
    expect(first).not.toBe(second)
  })

  it('returns markdown snapshot for a tab', () => {
    const { tabs, content } = setup()
    const first = getActive()!.id
    content.setMarkdown('first tab content')
    tabs.snapshotActive()
    tabs.addSession('second tab')
    expect(tabs.getMarkdownSnapshot(first)).toBe('first tab content')
  })
})
