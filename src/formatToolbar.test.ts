import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from './schema'
import { FormatToolbar, getButtons } from './formatToolbar'
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

function makeMultiBlockFixture() {
  const bar = document.createElement('div')
  const host = document.createElement('div')
  document.body.appendChild(host)

  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('first')]),
    schema.node('paragraph', null, [schema.text('second')]),
    schema.node('paragraph', null, [schema.text('third')]),
  ])
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 0, doc.content.size - 1),
  })
  const view = new EditorView(host, { state })

  const ctx: FormatToolbarContext = {
    getView: () => view,
  }
  return { bar, view, ctx, host }
}

function makeFixtureWithCursor(cursorPos: number) {
  const bar = document.createElement('div')
  const host = document.createElement('div')
  document.body.appendChild(host)

  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('hello world')]),
  ])
  const state = EditorState.create({
    doc,
    selection: new TextSelection(doc.resolve(cursorPos)),
  })
  const view = new EditorView(host, { state })

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

  it('inserts a horizontal rule via run function', () => {
    const { view, ctx } = makeFixtureWithCursor(5)
    const hrBtn = getButtons(ctx).find((b) => b.title === 'Horizontal rule')!
    const result = hrBtn.run(view)
    expect(result).toBe(true)
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.lastChild!.type.name).toBe('horizontal_rule')
  })

  it('inserts a horizontal rule via button click', () => {
    const { bar, view, ctx } = makeFixtureWithCursor(5)
    new FormatToolbar(bar, ctx)
    const hrBtn = bar.querySelector<HTMLButtonElement>('button[title="Horizontal rule"]')!
    hrBtn.click()
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.lastChild!.type.name).toBe('horizontal_rule')
  })

  it('wraps paragraph in bullet list', () => {
    const { view, ctx } = makeFixtureWithCursor(5)
    const btn = getButtons(ctx).find((b) => b.title === 'Bullet list')!
    const result = btn.run(view)
    expect(result).toBe(true)
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list')
    expect(view.state.doc.textContent).toBe('hello world')
  })

  it('wraps paragraph in numbered list', () => {
    const { view, ctx } = makeFixtureWithCursor(5)
    const btn = getButtons(ctx).find((b) => b.title === 'Numbered list')!
    const result = btn.run(view)
    expect(result).toBe(true)
    expect(view.state.doc.firstChild!.type.name).toBe('ordered_list')
    expect(view.state.doc.textContent).toBe('hello world')
  })

  it('toggles off bullet list when clicking bullet list again', () => {
    const { view, ctx } = makeFixtureWithCursor(5)
    const btn = getButtons(ctx).find((b) => b.title === 'Bullet list')!
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list')
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    expect(view.state.doc.textContent).toBe('hello world')
  })

  it('preserves cursor position when toggling off a list', () => {
    const { view, ctx } = makeFixtureWithCursor(5)
    const btn = getButtons(ctx).find((b) => b.title === 'Bullet list')!
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list')
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    const pos = (view.state.selection as import('prosemirror-state').TextSelection).$from.parentOffset
    expect(pos).toBe(4)
  })

  it('preserves selection range when toggling off a list', () => {
    const { view, ctx } = makeFixture()
    const btn = getButtons(ctx).find((b) => b.title === 'Bullet list')!
    const doc = view.state.doc
    const sel = TextSelection.create(doc, 2, 7)
    view.dispatch(view.state.tr.setSelection(sel))
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list')
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    expect(view.state.selection.empty).toBe(false)
    const s = view.state.selection as import('prosemirror-state').TextSelection
    expect(s.$from.parentOffset).toBe(1)
    expect(s.$to.parentOffset).toBe(6)
  })

  it('switches bullet list to numbered list', () => {
    const { view, ctx } = makeFixtureWithCursor(5)
    const bullet = getButtons(ctx).find((b) => b.title === 'Bullet list')!
    const numbered = getButtons(ctx).find((b) => b.title === 'Numbered list')!
    bullet.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list')
    numbered.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('ordered_list')
    expect(view.state.doc.textContent).toBe('hello world')
  })

  it('wraps multiple blocks into a single list', () => {
    const { view, ctx } = makeMultiBlockFixture()
    const btn = getButtons(ctx).find((b) => b.title === 'Bullet list')!
    btn.run(view)
    const doc = view.state.doc
    expect(doc.childCount).toBe(1)
    expect(doc.firstChild!.type.name).toBe('bullet_list')
    expect(doc.firstChild!.childCount).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(doc.firstChild!.child(i).type.name).toBe('list_item')
    }
    expect(doc.textContent).toBe('firstsecondthird')
  })

  it('toggles off multi-block bullet list', () => {
    const { view, ctx } = makeMultiBlockFixture()
    const btn = getButtons(ctx).find((b) => b.title === 'Bullet list')!
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list')
    btn.run(view)
    expect(view.state.doc.childCount).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(view.state.doc.child(i).type.name).toBe('paragraph')
    }
  })
})
