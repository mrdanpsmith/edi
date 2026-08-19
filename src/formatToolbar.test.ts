import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FormatToolbar } from './formatToolbar'
import type { FormatToolbarContext } from './formatToolbar'
import type { Mode } from './layout'

function makeFixture(mode: Mode = 'text', visualCommand = vi.fn(() => true)) {
  const host = document.createElement('div')
  const bar = document.createElement('div')
  bar.id = 'formatbar'
  host.append(bar)
  const view = new EditorView({
    state: EditorState.create({ doc: 'hello world' }),
    parent: host,
  })
  const ctx: FormatToolbarContext = {
    getMode: () => mode,
    runVisualCommand: visualCommand,
    getTextEditor: () => view,
  }
  return { bar, view, ctx }
}

describe('FormatToolbar', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('builds one button per format command', () => {
    const { bar, ctx } = makeFixture()
    const toolbar = new FormatToolbar(bar, ctx)
    expect(toolbar.isVisible()).toBe(true)
    expect(bar.querySelectorAll('.fmt-btn')).toHaveLength(18)
  })

  it('is hidden by default only when the user hid it before', () => {
    localStorage.setItem('edi.formattingVisible', 'false')
    const { bar, ctx } = makeFixture()
    new FormatToolbar(bar, ctx)
    expect(bar.hidden).toBe(true)
  })

  it('hides and shows the toolbar on setVisible', () => {
    const { bar, ctx } = makeFixture()
    const toolbar = new FormatToolbar(bar, ctx)
    toolbar.setVisible(false)
    expect(bar.hidden).toBe(true)
    expect(toolbar.isVisible()).toBe(false)
    expect(localStorage.getItem('edi.formattingVisible')).toBe('false')
    toolbar.setVisible(true)
    expect(bar.hidden).toBe(false)
  })

  it('toggles visibility', () => {
    const { bar, ctx } = makeFixture()
    const toolbar = new FormatToolbar(bar, ctx)
    toolbar.toggle()
    expect(bar.hidden).toBe(true)
    toolbar.toggle()
    expect(bar.hidden).toBe(false)
  })

  it('applies a format from a button click in text mode', () => {
    const { bar, view, ctx } = makeFixture('text')
    const toolbar = new FormatToolbar(bar, ctx)
    view.dispatch({ selection: { anchor: 6, head: 11 } })
    const bold = bar.querySelector<HTMLButtonElement>('button[title="Bold (Ctrl+B)"]')!
    bold.click()
    expect(view.state.doc.toString()).toBe('hello **world**')
    const { from, to } = view.state.selection.main
    expect(view.state.doc.sliceString(from, to)).toBe('world')
    toolbar.setVisible(false)
  })

  it('inserts a horizontal rule from its button in text mode', () => {
    const { bar, view, ctx } = makeFixture('text')
    new FormatToolbar(bar, ctx)
    const rule = bar.querySelector<HTMLButtonElement>('button[title="Horizontal rule"]')!
    rule.click()
    expect(view.state.doc.toString()).toBe('---\nhello world')
  })

  it('applies a heading-3, highlight, and definition list from their buttons in text mode', () => {
    const { bar, view, ctx } = makeFixture('text')
    new FormatToolbar(bar, ctx)
    view.dispatch({ selection: { anchor: 6, head: 11 } })
    bar.querySelector<HTMLButtonElement>('button[title="Highlight"]')!.click()
    expect(view.state.doc.toString()).toBe('hello ==world==')
    bar.querySelector<HTMLButtonElement>('button[title="Heading 3"]')!.click()
    expect(view.state.doc.toString()).toBe('### hello ==world==')
    view.dispatch({ selection: { anchor: 0, head: 0 } })
    bar.querySelector<HTMLButtonElement>('button[title="Definition list"]')!.click()
    expect(view.state.doc.toString()).toBe('### hello ==world==\n: definition')
  })

  it('dispatches Milkdown commands in visual mode', () => {
    const visualCommand = vi.fn(() => true)
    const { bar, ctx } = makeFixture('visual', visualCommand)
    new FormatToolbar(bar, ctx)
    bar.querySelector<HTMLButtonElement>('button[title="Bold (Ctrl+B)"]')!.click()
    expect(visualCommand).toHaveBeenCalledWith('toggleStrongCommand', undefined)
  })

  it('dispatches heading commands with level payload in visual mode', () => {
    const visualCommand = vi.fn(() => true)
    const { bar, ctx } = makeFixture('visual', visualCommand)
    new FormatToolbar(bar, ctx)
    bar.querySelector<HTMLButtonElement>('button[title="Heading 2"]')!.click()
    expect(visualCommand).toHaveBeenCalledWith('wrapInHeadingCommand', 2)
  })

  it('falls back to text formatting for buttons without visual commands', () => {
    const visualCommand = vi.fn(() => true)
    const { bar, view, ctx } = makeFixture('visual', visualCommand)
    new FormatToolbar(bar, ctx)
    view.dispatch({ selection: { anchor: 6, head: 11 } })
    bar.querySelector<HTMLButtonElement>('button[title="Task list"]')!.click()
    expect(visualCommand).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('- [ ] hello world')
  })
})
