import { describe, expect, it, beforeEach, vi } from 'vitest'
import { Tabs, type TabContent, type TabCallbacks } from './tabs'

let markdownReturn = ''

function makeCallbacks(): TabCallbacks {
  return {
    onNewTab: vi.fn(),
    onCloseTab: vi.fn(),
    onActivate: vi.fn(),
  }
}

function createTabbar(): HTMLElement {
  const tabbar = document.createElement('div')
  document.body.appendChild(tabbar)
  return tabbar
}

beforeEach(() => {
  document.body.innerHTML = ''
  markdownReturn = ''
})

describe('Tabs.addSession', () => {
  it('new tab sets editor to empty, not previous content', () => {
    const setMarkdown = vi.fn()
    const content: TabContent = {
      getMarkdown: () => markdownReturn,
      setMarkdown,
    }
    const tabs = new Tabs(createTabbar(), content, makeCallbacks())

    markdownReturn = '# Welcome\n\nHello world'

    tabs.addSession()

    const lastCall = setMarkdown.mock.calls.at(-1)
    expect(lastCall).toEqual([''])
  })

  it('new tab snapshot is empty', () => {
    const content: TabContent = {
      getMarkdown: () => markdownReturn,
      setMarkdown: vi.fn(),
    }
    const tabs = new Tabs(createTabbar(), content, makeCallbacks())

    markdownReturn = 'Some user content'
    tabs.addSession()

    expect(tabs.getMarkdownSnapshot(tabs.activeId)).toBe('')
  })

  it('switching back restores original content', () => {
    const setMarkdown = vi.fn()
    const content: TabContent = {
      getMarkdown: () => markdownReturn,
      setMarkdown,
    }
    const tabs = new Tabs(createTabbar(), content, makeCallbacks())

    const originalId = tabs.activeId
    markdownReturn = '# Welcome\n\nHello world'

    tabs.addSession()
    tabs.activate(originalId)

    const lastCall = setMarkdown.mock.calls.at(-1)
    expect(lastCall![0]).toContain('Welcome')
  })

  it('snapshot of previous tab preserves its content', () => {
    const content: TabContent = {
      getMarkdown: () => markdownReturn,
      setMarkdown: vi.fn(),
    }
    const tabs = new Tabs(createTabbar(), content, makeCallbacks())

    const originalId = tabs.activeId
    markdownReturn = '# My Document\n\nParagraph text'

    tabs.addSession()

    expect(tabs.getMarkdownSnapshot(originalId)).toContain('My Document')
  })
})

describe('Tabs scroll position', () => {
  function makeContent(scrollTop = 0) {
    const state = { markdown: '', scroll: scrollTop }
    const content: TabContent = {
      getMarkdown: () => state.markdown,
      setMarkdown: (value: string) => {
        state.markdown = value
      },
      getScroll: () => state.scroll,
      setScroll: (value: number) => {
        state.scroll = value
      },
    }
    return { content, state }
  }

  it('restores a tab to its own saved scroll position', () => {
    const { content, state } = makeContent()
    const tabs = new Tabs(createTabbar(), content, makeCallbacks())
    const firstId = tabs.activeId

    // User scrolls tab 1 down and creates tab 2, which scrolls to top.
    state.scroll = 120
    tabs.addSession()
    const secondId = tabs.activeId
    state.scroll = 0

    // Switch back to tab 1: should restore its saved 120.
    tabs.activate(firstId)
    expect(state.scroll).toBe(120)

    // Switch to tab 2: should restore its saved 0.
    tabs.activate(secondId)
    expect(state.scroll).toBe(0)
  })

  it('a brand-new tab starts scrolled to the top', () => {
    const { content, state } = makeContent(300)
    const tabs = new Tabs(createTabbar(), content, makeCallbacks())

    // Current tab is scrolled down; adding a new tab resets to top.
    state.scroll = 300
    tabs.addSession()

    expect(state.scroll).toBe(0)
  })
})
