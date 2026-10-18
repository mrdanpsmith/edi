import { describe, expect, it, beforeEach, vi } from 'vitest'
import { Tabs, type TabContent, type TabCallbacks } from './tabs'
import { createBlockEditor } from './editor'
import { redo, undo } from 'prosemirror-history'
import { activateSession, getState } from './state'

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

    tabs.addSession()
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

    tabs.addSession()
    const originalId = tabs.activeId
    markdownReturn = '# My Document\n\nParagraph text'

    tabs.addSession()

    expect(tabs.getMarkdownSnapshot(originalId)).toContain('My Document')
  })

  it('closing the last tab leaves zero sessions', () => {
    const content: TabContent = {
      getMarkdown: () => '',
      setMarkdown: vi.fn(),
    }
    const tabs = new Tabs(createTabbar(), content, makeCallbacks())

    // The state module is shared across tests, so assert relative to its
    // current length rather than an absolute count.
    const start = getState().sessions.length
    tabs.addSession()
    tabs.addSession()
    expect(getState().sessions.length).toBe(start + 2)

    tabs.close(tabs.activeId)
    tabs.close(tabs.activeId)

    expect(getState().sessions.length).toBe(start)
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
    tabs.addSession()
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
    tabs.addSession()

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
    // Mirrors main.ts init(): the first real tab is created explicitly and
    // the welcome document is seated into it before snapshotting.
    tabs.addSession('welcome')
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

describe('Tabs tab strip arrows', () => {
  function stubScrollSizes(scroll: HTMLElement) {
    const state = { scrollLeft: 0 }
    Object.defineProperty(scroll, 'scrollWidth', { configurable: true, value: 1000 })
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 200 })
    Object.defineProperty(scroll, 'scrollLeft', {
      configurable: true,
      get: () => state.scrollLeft,
      set: (v: number) => {
        state.scrollLeft = v
      },
    })
    return state
  }

  function makeStrip() {
    const tabbar = createTabbar()
    const tabs = new Tabs(
      tabbar,
      { getMarkdown: () => '', setMarkdown: vi.fn() },
      makeCallbacks(),
    )
    tabs.addSession()
    const scroll = tabbar.querySelector<HTMLElement>('.tabbar-scroll')!
    const left = tabbar.querySelector<HTMLButtonElement>('.tab-arrow-left')!
    const right = tabbar.querySelector<HTMLButtonElement>('.tab-arrow-right')!
    return { tabs, scroll, left, right }
  }

  it('hides the arrows while the tabs fit and shows them once they overflow', () => {
    const { scroll, left, right } = makeStrip()
    expect(left.hidden).toBe(true)
    expect(right.hidden).toBe(true)

    stubScrollSizes(scroll)
    scroll.dispatchEvent(new Event('scroll'))
    expect(left.hidden).toBe(false)
    expect(right.hidden).toBe(false)
  })

  it('disables an arrow when its edge is reached', () => {
    const { scroll, left, right } = makeStrip()
    const state = stubScrollSizes(scroll)

    scroll.dispatchEvent(new Event('scroll'))
    expect(left.disabled).toBe(true)
    expect(right.disabled).toBe(false)

    state.scrollLeft = 800
    scroll.dispatchEvent(new Event('scroll'))
    expect(left.disabled).toBe(false)
    expect(right.disabled).toBe(true)
  })
})

/**
 * The one caller-side rule behind every status-bar symptom.
 *
 * A tab swap is queued, and `enqueue` returns **before the swap has run** as
 * soon as something on the outgoing document has to be written first — an open
 * encrypted block's `flush` is `crypto.subtle`'s asynchronous work
 * (`flushOpenReveals` in `src/node/encryptedblock.ts`). A caller that reads
 * the session or the view on the line after asking for a switch therefore
 * reads the tab being *left*, which is how one tab's path, word count and dirty
 * flag end up describing another.
 *
 * So `Tabs` notifies from its own settle and no caller refreshes the chrome
 * itself. These tests pin that, and the content hash is the document actually
 * in the shared view — so a notification that arrives early fails here rather
 * than in a screenshot.
 */
describe('Tabs notify after the swap, not when it was asked for', () => {
  /**
   * A content object whose `flush` resolves on a later turn, which is what
   * makes every queued operation asynchronous: the ordinary case for a reader
   * who has typed into an open reveal in the last 600 ms, and the reason this
   * whole class of bug is intermittent.
   */
  function makeSlowContent() {
    const view: { text: string } = { text: '' }
    const content: TabContent = {
      getMarkdown: () => view.text,
      setMarkdown: (value: string) => {
        view.text = value
      },
      flush: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    }
    return { content, view }
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

  it('reports the tab that has arrived, with its own document in the view', async () => {
    const { content, view } = makeSlowContent()
    const seen: { id: string; text: string }[] = []
    const tabs = new Tabs(createTabbar(), content, {
      ...makeCallbacks(),
      onActivate: (id) => seen.push({ id, text: view.text }),
    })

    tabs.addSession('FIRST')
    await settle()
    const first = tabs.activeId
    tabs.addSession('SECOND')
    await settle()

    seen.length = 0
    tabs.activate(first)
    // The call has returned by now — the queued work has not. Nothing has been
    // reported yet, and the view still holds the tab being left.
    expect(seen).toEqual([])
    expect(view.text).toBe('SECOND')

    await settle()
    expect(seen).toEqual([{ id: first, text: 'FIRST' }])
  })

  it('reports a tab opened into a new session once its content has landed', async () => {
    const { content, view } = makeSlowContent()
    const seen: { id: string; text: string }[] = []
    const tabs = new Tabs(createTabbar(), content, {
      ...makeCallbacks(),
      onActivate: (id) => seen.push({ id, text: view.text }),
    })

    tabs.addSession('FIRST')
    await settle()
    seen.length = 0

    tabs.addSession('SECOND')
    expect(view.text).toBe('FIRST')

    await settle()
    expect(seen).toEqual([{ id: tabs.activeId, text: 'SECOND' }])
  })

  it('reports a document forced into the current tab, with it in the view', async () => {
    const { content, view } = makeSlowContent()
    const seen: { id: string; text: string }[] = []
    const tabs = new Tabs(createTabbar(), content, {
      ...makeCallbacks(),
      onActivate: (id) => seen.push({ id, text: view.text }),
    })

    tabs.addSession('FIRST')
    await settle()
    const id = tabs.activeId
    seen.length = 0

    // **Synchronous, unlike a tab switch.** The document is being replaced
    // rather than left, so there is nothing to write back and `discardPending`
    // stands in for `flush` — which is why this path never had to queue and
    // why the report is the same shape rather than a special case.
    tabs.setActiveContent('REPLACED')
    expect(view.text).toBe('REPLACED')
    expect(seen).toEqual([{ id, text: 'REPLACED' }])
  })

  it('says nothing when the tab asked for is already in view', async () => {
    const { content } = makeSlowContent()
    const onActivate = vi.fn()
    const tabs = new Tabs(createTabbar(), content, { ...makeCallbacks(), onActivate })

    tabs.addSession('FIRST')
    await settle()
    onActivate.mockClear()

    tabs.activate(tabs.activeId)
    await settle()

    expect(onActivate).not.toHaveBeenCalled()
  })
})

describe('Tabs reports a desynced view instead of skipping quietly', () => {
  it('says so rather than storing another tab\'s document under this one', () => {
    const view = { text: '' }
    const content: TabContent = {
      getMarkdown: () => view.text,
      setMarkdown: (value: string) => {
        view.text = value
      },
    }
    const tabs = new Tabs(createTabbar(), content, makeCallbacks())
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    tabs.addSession('ONE')
    const first = tabs.activeId
    tabs.addSession('TWO')
    tabs.snapshotActive()
    // Sessions are module state shared by every test in this file, so the first
    // `addSession` above legitimately reported a desync against the session a
    // previous test left active. Only the deliberate one below is of interest.
    error.mockClear()

    // Something outside `Tabs` moved the active session — a feature reaching
    // for `activateSession` directly, which is the only way `appliedSession`
    // can disagree with `active.id` (nothing else writes either). `Tabs` is not
    // the only thing that knows which tab is in view, so this is the hazard the
    // guard is the backstop for, and there is no production caller of it today.
    activateSession(first)

    tabs.snapshotActive()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('is active but the view holds'))
    error.mockRestore()
  })
})
