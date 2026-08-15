import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FormatToolbar } from './formatToolbar'

function makeFixture() {
  const host = document.createElement('div')
  const bar = document.createElement('div')
  bar.id = 'formatbar'
  host.append(bar)
  const view = new EditorView({
    state: EditorState.create({ doc: 'hello world' }),
    parent: host,
  })
  return { bar, view }
}

describe('FormatToolbar', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('builds one button per format command', () => {
    const { bar, view } = makeFixture()
    const toolbar = new FormatToolbar(bar, view)
    expect(toolbar.isVisible()).toBe(true)
    expect(bar.querySelectorAll('.fmt-btn')).toHaveLength(16)
  })

  it('is hidden by default only when the user hid it before', () => {
    localStorage.setItem('edi.formattingVisible', 'false')
    const { bar, view } = makeFixture()
    new FormatToolbar(bar, view)
    expect(bar.hidden).toBe(true)
  })

  it('hides and shows the toolbar on setVisible', () => {
    const { bar, view } = makeFixture()
    const toolbar = new FormatToolbar(bar, view)
    toolbar.setVisible(false)
    expect(bar.hidden).toBe(true)
    expect(toolbar.isVisible()).toBe(false)
    expect(localStorage.getItem('edi.formattingVisible')).toBe('false')
    toolbar.setVisible(true)
    expect(bar.hidden).toBe(false)
  })

  it('toggles visibility', () => {
    const { bar, view } = makeFixture()
    const toolbar = new FormatToolbar(bar, view)
    toolbar.toggle()
    expect(bar.hidden).toBe(true)
    toolbar.toggle()
    expect(bar.hidden).toBe(false)
  })

  it('applies a format from a button click', () => {
    const { bar, view } = makeFixture()
    const toolbar = new FormatToolbar(bar, view)
    view.dispatch({ selection: { anchor: 6, head: 11 } })
    const bold = bar.querySelector<HTMLButtonElement>('button[title="Bold (Ctrl+B)"]')!
    bold.click()
    expect(view.state.doc.toString()).toBe('hello **world**')
    const { from, to } = view.state.selection.main
    expect(view.state.doc.sliceString(from, to)).toBe('world')
    toolbar.setVisible(false)
  })

  it('inserts a horizontal rule from its button', () => {
    const { bar, view } = makeFixture()
    new FormatToolbar(bar, view)
    const rule = bar.querySelector<HTMLButtonElement>('button[title="Horizontal rule"]')!
    rule.click()
    expect(view.state.doc.toString()).toBe('---\nhello world')
  })

  it('applies a heading-3, highlight, and definition list from their buttons', () => {
    const { bar, view } = makeFixture()
    new FormatToolbar(bar, view)
    view.dispatch({ selection: { anchor: 6, head: 11 } })
    bar.querySelector<HTMLButtonElement>('button[title="Highlight"]')!.click()
    expect(view.state.doc.toString()).toBe('hello ==world==')
    bar.querySelector<HTMLButtonElement>('button[title="Heading 3"]')!.click()
    expect(view.state.doc.toString()).toBe('### hello ==world==')
    view.dispatch({ selection: { anchor: 0, head: 0 } })
    bar.querySelector<HTMLButtonElement>('button[title="Definition list"]')!.click()
    expect(view.state.doc.toString()).toBe('### hello ==world==\n: definition')
  })
})
