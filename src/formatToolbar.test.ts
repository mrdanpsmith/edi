import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from './schema'
import { FormatToolbar, getButtons, toggleTaskItems, applyLink, blockTypeSelectPlugin } from './formatToolbar'
import type { FormatToolbarContext } from './formatToolbar'
import { markdownToProse, proseToMarkdown } from './markdown'
import { promptForUrl } from './urlDialog'

vi.mock('./urlDialog')

async function runLinkButton(view: EditorView): Promise<boolean | undefined> {
  const ctx: FormatToolbarContext = { getView: () => view }
  const link = getButtons(ctx).find((b) => b.title === 'Hyperlink')!
  return link.run(view)
}

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

function makeHeadingFixture(level: number, withParagraph = false) {
  const bar = document.createElement('div')
  const host = document.createElement('div')
  document.body.append(bar, host)

  const blocks = [schema.node('heading', { level }, [schema.text('title')])]
  if (withParagraph) blocks.push(schema.node('paragraph', null, [schema.text('body text')]))
  const doc = schema.node('doc', null, blocks)
  const state = EditorState.create({
    doc,
    selection: new TextSelection(doc.resolve(2)),
    plugins: [blockTypeSelectPlugin()],
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

  it('renders the heading dropdown with Normal and H1–H6', () => {
    const { bar, ctx } = makeFixtureWithCursor(5)
    new FormatToolbar(bar, ctx)
    const select = bar.querySelector<HTMLSelectElement>('select.fmt-btn.fmt-select.fmt-heading')!
    expect(select).not.toBeNull()
    const labels = Array.from(select.options).map((o) => o.textContent)
    expect(labels).toEqual(['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'])
  })

  it('applies the selected heading level from the dropdown', () => {
    const { bar, view, ctx } = makeFixtureWithCursor(5)
    vi.spyOn(view, 'focus').mockImplementation(() => {})
    new FormatToolbar(bar, ctx)
    const select = bar.querySelector<HTMLSelectElement>('select.fmt-select')!
    select.value = 'Heading 5'
    select.dispatchEvent(new Event('change'))
    expect(view.state.doc.firstChild?.attrs.level).toBe(5)
    expect(select.selectedIndex).toBe(0)
  })

  it('dropdown reflects the block under the cursor', () => {
    const { bar, view, ctx } = makeHeadingFixture(3, true)
    new FormatToolbar(bar, ctx)
    const select = bar.querySelector<HTMLSelectElement>('select.fmt-select')!
    expect(select.selectedIndex).toBe(3)

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 2)))
    expect(select.selectedIndex).toBe(0)

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    expect(select.selectedIndex).toBe(3)
  })

  it('selecting Normal converts an existing heading back to a paragraph', () => {
    const { bar, view, ctx } = makeHeadingFixture(1)
    vi.spyOn(view, 'focus').mockImplementation(() => {})
    new FormatToolbar(bar, ctx)
    const select = bar.querySelector<HTMLSelectElement>('select.fmt-select')!
    expect(select.selectedIndex).toBe(1)
    select.value = 'Normal'
    select.dispatchEvent(new Event('change'))
    expect(view.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(select.selectedIndex).toBe(0)
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

  it('wraps paragraph in task list', () => {
    const { view, ctx } = makeFixtureWithCursor(5)
    const btn = getButtons(ctx).find((b) => b.title === 'Task list')!
    const result = btn.run(view)
    expect(result).toBe(true)
    const doc = view.state.doc
    expect(doc.firstChild!.type.name).toBe('bullet_list')
    expect(doc.firstChild!.child(0).attrs.checked).toBe(false)
    expect(doc.textContent).toBe('hello world')
  })

  it('toggles off task list when clicking task list again', () => {
    const { view, ctx } = makeFixtureWithCursor(5)
    const btn = getButtons(ctx).find((b) => b.title === 'Task list')!
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('bullet_list')
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBe(false)
    btn.run(view)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    expect(view.state.doc.textContent).toBe('hello world')
  })

  it('toggles checked state on task item', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', { checked: false }, [
          schema.node('paragraph', null, [schema.text('task item')]),
        ]),
      ]),
    ])
    const host = document.createElement('div')
    document.body.appendChild(host)
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
    })
    const view = new EditorView(host, { state })
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBe(false)
    const result = toggleTaskItems(view)
    expect(result).toBe(true)
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBe(true)
    toggleTaskItems(view)
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBe(false)
    view.destroy()
    host.remove()
  })

  it('converts regular list item to task item on toggle', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', { checked: null }, [
          schema.node('paragraph', null, [schema.text('regular item')]),
        ]),
      ]),
    ])
    const host = document.createElement('div')
    document.body.appendChild(host)
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
    })
    const view = new EditorView(host, { state })
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBe(null)
    const result = toggleTaskItems(view)
    expect(result).toBe(true)
    expect(view.state.doc.firstChild!.child(0).attrs.checked).toBe(false)
    view.destroy()
    host.remove()
  })

  it('wraps multiple blocks into a task list', () => {
    const { view, ctx } = makeMultiBlockFixture()
    const btn = getButtons(ctx).find((b) => b.title === 'Task list')!
    btn.run(view)
    const doc = view.state.doc
    expect(doc.childCount).toBe(1)
    expect(doc.firstChild!.type.name).toBe('bullet_list')
    expect(doc.firstChild!.childCount).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect(doc.firstChild!.child(i).type.name).toBe('list_item')
      expect(doc.firstChild!.child(i).attrs.checked).toBe(false)
    }
  })
})

describe('hyperlink', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('offers a Hyperlink toolbar button', () => {
    const { ctx } = makeFixture()
    const link = getButtons(ctx).find((b) => b.title === 'Hyperlink')!
    expect(link).toBeDefined()
    expect(link.markup).toContain('<svg')
  })

  it('applies a link mark over a selection', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello world')]),
    ])
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({
        doc,
        selection: TextSelection.create(doc, 1, 6),
      }),
    })
    const result = applyLink(view, 'https://example.com')
    expect(result).toBe(true)
    const selected = view.state.doc.textBetween(1, 6)
    expect(selected).toBe('hello')
    expect(proseToMarkdown(view.state.doc)).toContain('[hello](https://example.com)')
    view.destroy()
    host.remove()
  })

  it('prepends https for a bare www link', () => {
    const doc = markdownToProse('abc', schema)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 1, 2) }),
    })
    applyLink(view, 'www.example.com')
    expect(proseToMarkdown(view.state.doc)).toContain('[a](https://www.example.com)')
    view.destroy()
    host.remove()
  })

  it('removes a link mark when the URL is empty', () => {
    const doc = markdownToProse('[hello](https://example.com) world', schema)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 1, 6) }),
    })
    applyLink(view, '')
    expect(proseToMarkdown(view.state.doc)).toContain('hello world')
    expect(proseToMarkdown(view.state.doc)).not.toContain('example.com')
    view.destroy()
    host.remove()
  })

  it('inserts the URL as link text when there is no selection', () => {
    const doc = markdownToProse('abc', schema)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
    })
    applyLink(view, 'https://example.com')
    expect(proseToMarkdown(view.state.doc)).toContain('[https://example.com](https://example.com)')
    view.destroy()
    host.remove()
  })
})

describe('hyperlink dialog flow', () => {
  beforeEach(() => {
    vi.mocked(promptForUrl).mockReset()
    vi.mocked(promptForUrl).mockResolvedValue('https://new.example.org')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.mocked(promptForUrl).mockReset()
  })

  it('prefills the href of a linked selection then applies the new link', async () => {
    const doc = markdownToProse('[hello](https://old.example.com) world', schema)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 1, 6) }),
    })
    const result = await runLinkButton(view)
    expect(result).toBe(true)
    expect(promptForUrl).toHaveBeenCalledWith('https://old.example.com')
    expect(proseToMarkdown(view.state.doc)).toContain('[hello](https://new.example.org)')
    view.destroy()
    host.remove()
  })

  it('prefills the stored link mark for a collapsed selection', async () => {
    const doc = markdownToProse('abc', schema)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
    })
    const linkMark = view.state.schema.marks.link.create({ href: 'https://stored.example.com', title: null })
    view.dispatch(view.state.tr.setStoredMarks([linkMark]))
    await runLinkButton(view)
    expect(promptForUrl).toHaveBeenCalledWith('https://stored.example.com')
    expect(proseToMarkdown(view.state.doc)).toContain('https://new.example.org')
    view.destroy()
    host.remove()
  })

  it('does nothing when the dialog is dismissed', async () => {
    const doc = markdownToProse('plain text', schema)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, { state: EditorState.create({ doc }) })
    vi.mocked(promptForUrl).mockResolvedValue(null)
    const result = await runLinkButton(view)
    expect(result).toBe(false)
    expect(proseToMarkdown(view.state.doc)).toBe('plain text\n')
    view.destroy()
    host.remove()
  })
})

describe('command buttons', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function runTitle(title: string, view: EditorView): boolean | Promise<boolean> {
    const ctx: FormatToolbarContext = { getView: () => view }
    const spec = getButtons(ctx).find((b) => b.title === title)!
    return spec.run(view)
  }

  it('toggles inline marks via the toolbar commands', () => {
    const doc = markdownToProse('abc', schema)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
    })
    for (const title of ['Bold (Ctrl+B)', 'Italic (Ctrl+I)', 'Strikethrough', 'Highlight', 'Subscript', 'Superscript', 'Inline code']) {
      runTitle(title, view)
    }
    const markNames = (view.state.storedMarks ?? []).map((m) => m.type.name).sort()
    expect(markNames).toEqual(['code', 'em', 'highlight', 'strikethrough', 'strong', 'sub', 'sup'])
    view.destroy()
    host.remove()
  })

  it('converts the block to each heading level via the dropdown', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = markdownToProse('abc', schema)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
    })
    const ctx: FormatToolbarContext = { getView: () => view }
    const heading = getButtons(ctx).find((b) => b.title === 'Heading')!
    expect(heading.options).toHaveLength(7)
    for (const [label, level] of [['Heading 1', 1], ['Heading 2', 2], ['Heading 3', 3], ['Heading 4', 4], ['Heading 5', 5], ['Heading 6', 6]] as const) {
      const option = heading.options!.find((o) => o.label === label)!
      expect(option.run(view)).toBe(true)
      expect(view.state.doc.firstChild?.attrs.level).toBe(level)
    }
    const paragraph = heading.options!.find((o) => o.label === 'Normal')!
    expect(paragraph.run(view)).toBe(true)
    expect(view.state.doc.firstChild?.type.name).toBe('paragraph')
    view.destroy()
    host.remove()
  })

  it('wraps the paragraph in a blockquote via the quote button', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = markdownToProse('quote me', schema)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
    })
    runTitle('Blockquote', view)
    expect(view.state.doc.firstChild?.type.name).toBe('blockquote')
    view.destroy()
    host.remove()
  })
})

describe('insertCodeBlock', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function runCodeBlock(view: EditorView): boolean | Promise<boolean> {
    const ctx: FormatToolbarContext = { getView: () => view }
    const spec = getButtons(ctx).find((b) => b.title === 'Code block')!
    return spec.run(view)
  }

  it('replaces a selected paragraph with a code block', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = markdownToProse('hello world', schema)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 1, doc.content.size - 1) }),
    })
    runCodeBlock(view)
    expect(proseToMarkdown(view.state.doc)).toBe('```\nhello world\n```\n')
    view.destroy()
    host.remove()
  })

  it('replaces an empty paragraph with a code block', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc: markdownToProse('', schema) }),
    })
    runCodeBlock(view)
    expect(view.state.doc.firstChild?.type.name).toBe('code_block')
    view.destroy()
    host.remove()
  })

  it('inserts a code block after the current block', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = markdownToProse('hello world', schema)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
    })
    runCodeBlock(view)
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.lastChild?.type.name).toBe('code_block')
    view.destroy()
    host.remove()
  })
})

describe('task and list toggles', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function makeListView(markdown: string): EditorView {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = markdownToProse(markdown, schema)
    return new EditorView(host, {
      state: EditorState.create({
        doc,
        selection: TextSelection.create(doc, Math.floor(doc.content.size / 2)),
      }),
    })
  }

  it('converts a regular list into a task list', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = makeListView('- item')
    const ctx: FormatToolbarContext = { getView: () => view }
    const btn = getButtons(ctx).find((b) => b.title === 'Task list')!
    btn.run(view)
    expect(view.state.doc.firstChild?.type.name).toBe('bullet_list')
    expect(view.state.doc.firstChild?.child(0).attrs.checked).toBe(false)
    view.destroy()
    host.remove()
  })

  it('turns a multi-item task list back into a plain list', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = markdownToProse('- [x] one\n- [ ] two', schema)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
    })
    const ctx: FormatToolbarContext = { getView: () => view }
    const btn = getButtons(ctx).find((b) => b.title === 'Task list')!
    btn.run(view)
    const item = view.state.doc.firstChild!.child(0)
    expect(item.type.name).toBe('list_item')
    expect(item.attrs.checked).toBe(null)
    view.destroy()
    host.remove()
  })

  it('unwraps a list built from markdown', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = markdownToProse('- one', schema)
    const view = new EditorView(host, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, 4) }),
    })
    const ctx: FormatToolbarContext = { getView: () => view }
    const btn = getButtons(ctx).find((b) => b.title === 'Bullet list')!
    btn.run(view)
    expect(view.state.doc.childCount).toBe(1)
    expect(view.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(view.state.doc.textContent).toBe('one')
    view.destroy()
    host.remove()
  })

  it('returns false when toggling task items outside a list', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new EditorView(host, {
      state: EditorState.create({ doc: markdownToProse('plain', schema) }),
    })
    expect(toggleTaskItems(view)).toBe(false)
    view.destroy()
    host.remove()
  })
})
