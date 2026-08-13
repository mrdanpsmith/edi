import { beforeEach, describe, expect, it } from 'vitest'

import { EditorView } from '@codemirror/view'

import { createEditorState } from './editor'
import { closeSession, getActive, getState, setActiveDirty } from './state'
import { Tabs } from './tabs'

function setup(): {
  tabs: Tabs
  tabbar: HTMLElement
  view: EditorView
  activeIds: string[]
} {
  const tabbar = document.createElement('div')
  document.body.append(tabbar)
  const activeIds: string[] = []
  const view = new EditorView({
    state: createEditorState(''),
    parent: document.createElement('div'),
  })
  const tabs = new Tabs(tabbar, view, {
    onNewTab: () => tabs.addSession(),
    onCloseTab: (id) => tabs.close(id),
    onActivate: (id) => activeIds.push(id),
  })
  return { tabs, tabbar, view, activeIds }
}

function docText(view: EditorView): string {
  return view.state.doc.toString()
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
    const { tabs, view } = setup()
    const first = getActive()!.id
    tabs.addSession('hello')
    expect(getState().sessions).toHaveLength(2)
    expect(getActive()?.id).not.toBe(first)
    expect(docText(view)).toBe('hello')
  })

  it('restores per-tab content when activating', () => {
    const { tabs, view } = setup()
    const first = getActive()!.id
    tabs.addSession('second doc')
    tabs.addSession('third doc')
    tabs.activate(first)
    expect(getActive()?.id).toBe(first)
    expect(docText(view)).toBe('')
    tabs.activate(getState().sessions[2]!.id)
    expect(docText(view)).toBe('third doc')
  })

  it('preserves scroll position per tab', () => {
    const { tabs, view } = setup()
    view.scrollDOM.scrollTop = 120
    const first = getActive()!.id
    tabs.addSession('other')
    tabs.activate(first)
    expect(view.scrollDOM.scrollTop).toBe(120)
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
    const { tabs, tabbar, view } = setup()
    const first = getActive()!.id
    tabs.addSession('second doc')
    const second = getActive()!.id
    const tabEls = tabbar.querySelectorAll<HTMLElement>('.tab')
    tabEls[0]!.click()
    expect(getActive()?.id).toBe(first)
    expect(docText(view)).toBe('')
    tabEls[1]!.click()
    expect(getActive()?.id).toBe(second)
    expect(docText(view)).toBe('second doc')
  })

  it('creates a fresh tab when the last one closes', () => {
    const { tabs, view } = setup()
    tabs.close(getActive()!.id)
    expect(getState().sessions).toHaveLength(1)
    expect(docText(view)).toBe('')
  })

  it('notifies activation through the callback', () => {
    const { tabs, activeIds } = setup()
    const first = activeIds[0]
    tabs.addSession('x')
    expect(activeIds.at(-1)).toBe(getActive()?.id)
    tabs.activate(first!)
    expect(activeIds.at(-1)).toBe(first)
  })
})
