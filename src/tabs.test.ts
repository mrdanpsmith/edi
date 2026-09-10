import { describe, expect, it, beforeEach, vi } from 'vitest'
import { Tabs, type TabContent, type TabCallbacks } from './tabs'
import { createBlockEditor } from './editor'
import { redo, undo } from 'prosemirror-history'

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

describe('Tabs content isolation', () => {
  function makeRealTabs() {
    const editor = createBlockEditor(document.body, '')
    const tabs = new Tabs(
      createTabbar(),
      {
        getMarkdown: () => {
          editor.commitSource()
          return editor.getMarkdown()
        },
        setMarkdown: (value: string) => editor.setMarkdown(value),
        createState: (markdown: string) => editor.createState(markdown),
        getState: () => {
          editor.commitSource()
          return editor.getState()
        },
        setState: (state: unknown) =>
          editor.applyState(state as import('prosemirror-state').EditorState),
        getScroll: () => 0,
        setScroll: () => {},
      },
      makeCallbacks(),
    )
    // Mirrors main.ts init(): the constructor seeded the first tab as empty;
    // re-seat the initial document into it and snapshot.
    tabs.setActiveContent('welcome')
    tabs.snapshotActive()
    return { editor, tabs }
  }

  it('an undo after switching tabs cannot resurrect a previous document', () => {
    const { editor, tabs } = makeRealTabs()
    const view = editor.getView()

    tabs.addSession('# Alpha\n\ncontent a')
    const alphaId = tabs.activeId
    tabs.addSession('# Beta\n\ncontent b')
    const betaId = tabs.activeId

    tabs.activate(betaId)
    // A stray undo (Ctrl+Z) must not roll the shared editor back across the
    // tab-swap boundary into a different document.
    undo(view.state, view.dispatch, view)

    tabs.activate(alphaId)
    tabs.activate(betaId)
    expect(editor.getMarkdown()).toContain('Beta')
    expect(editor.getMarkdown()).not.toContain('Alpha')
    editor.destroy()
  })

  it('setActiveContent seats content into the active session so snapshots work', () => {
    const { editor, tabs } = makeRealTabs()
    const firstId = tabs.activeId

    tabs.setActiveContent('# Fresh\n\ncontent')
    tabs.snapshotActive()
    tabs.addSession('# Other\n\ncontent')
    tabs.activate(firstId)

    expect(editor.getMarkdown()).toContain('Fresh')
    editor.destroy()
  })

  it('each tab keeps its own undo/redo history', () => {
    const { editor, tabs } = makeRealTabs()
    const view = editor.getView()
    const firstId = tabs.activeId

    // Edit tab 1, then create and edit tab 2.
    tabs.setActiveContent('first doc')
    view.dispatch(view.state.tr.insertText('A'))
    const editedA = editor.getMarkdown()

    tabs.addSession('second doc')
    const secondId = tabs.activeId
    view.dispatch(view.state.tr.insertText('B'))

    // Tab 2's undo removes only its own edit; tab 1 is untouched.
    undo(view.state, view.dispatch, view)
    expect(editor.getMarkdown()).not.toContain('B')

    // Tab 1 still owns its own history — redo/undo operate per tab.
    tabs.activate(firstId)
    expect(editor.getMarkdown()).toBe(editedA)
    undo(view.state, view.dispatch, view)
    expect(editor.getMarkdown()).not.toContain('A')
    redo(view.state, view.dispatch, view)
    expect(editor.getMarkdown()).toBe(editedA)

    // Switching back to tab 2 never leaks tab 1's document in.
    tabs.activate(secondId)
    expect(editor.getMarkdown()).not.toContain('first doc')
    expect(editor.getMarkdown()).not.toContain('A')
    editor.destroy()
  })
})
