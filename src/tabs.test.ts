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
