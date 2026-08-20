import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from './schema'
import { FormatToolbar } from './formatToolbar'
import type { FormatToolbarContext } from './formatToolbar'

function makeFixture() {
  const bar = document.createElement('div')
  const host = document.createElement('div')
  document.body.appendChild(host)

  const view = new EditorView(host, {
    state: EditorState.create({
      doc: schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('hello world')]),
      ]),
    }),
  })

  const ctx: FormatToolbarContext = {
    getView: () => view,
  }
  return { bar, view, ctx, host }
}

describe('FormatToolbar', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('builds buttons for format commands', () => {
    const { bar, ctx } = makeFixture()
    const toolbar = new FormatToolbar(bar, ctx)
    expect(toolbar.isVisible()).toBe(true)
    expect(bar.querySelectorAll('.fmt-btn').length).toBeGreaterThan(5)
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

  it('applies bold on button click', () => {
    const { bar, view, ctx } = makeFixture()
    new FormatToolbar(bar, ctx)
    const bold = bar.querySelector<HTMLButtonElement>('button[title="Bold (Ctrl+B)"]')!
    bold.click()
    expect(view.state.doc.textContent).toBe('hello world')
  })
})
