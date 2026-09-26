import { beforeEach, describe, expect, it } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { createBlockEditor, type BlockEditor } from './editor'
import { SearchPanel } from './searchPanel'

beforeEach(() => {
  document.body.innerHTML = ''
})

function setup(markdown: string): { editor: BlockEditor; panel: SearchPanel } {
  const workspace = document.createElement('div')
  workspace.id = 'workspace'
  const toolbar = document.createElement('div')
  toolbar.id = 'toolbar'
  const container = document.createElement('div')
  container.id = 'editor-container'
  workspace.append(toolbar, container)
  document.body.append(workspace)
  const editor = createBlockEditor(container, markdown)
  const panel = new SearchPanel({ getView: () => editor.getView() })
  return { editor, panel }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SearchPanel', () => {
  it('builds the bar inside the workspace and focuses the find input on open', () => {
    const { panel } = setup('hello')
    panel.open()
    const bar = document.querySelector('#edi-search-bar')!
    expect(bar).not.toBeNull()
    expect(bar.parentElement!.id).toBe('workspace')
    const find = bar.querySelector<HTMLInputElement>('.edi-search-input')!
    expect(document.activeElement).toBe(find)
    panel.close()
  })

  it('updates the counter as you type, jumping to the first match', () => {
    const { editor, panel } = setup('hello world hello')
    panel.open()
    const bar = document.querySelector('#edi-search-bar')!
    const find = bar.querySelector<HTMLInputElement>('.edi-search-input')!
    const count = bar.querySelector<HTMLElement>('.edi-search-count')!
    expect(count.textContent).toBe('0 / 0')
    setInputValue(find, 'hello')
    expect(count.textContent).toBe('1 / 2')
    expect(editor.getView().dom.querySelectorAll('.edi-search-match, .edi-search-match-current').length).toBe(2)
    panel.close()
  })

  it('typing moves the document selection to the first match', () => {
    const { editor, panel } = setup('hello world hello')
    const view = editor.getView()
    panel.open()
    const bar = document.querySelector('#edi-search-bar')!
    const find = bar.querySelector<HTMLInputElement>('.edi-search-input')!
    setInputValue(find, 'hello')
    expect(view.state.selection.from).toBe(1)
    expect(view.state.selection.to).toBe(6)
    expect(view.dom.querySelector('.edi-search-match-current')?.textContent).toBe('hello')
    panel.close()
  })

  it('open() with a seeded query keeps the existing editor selection', () => {
    const { editor, panel } = setup('find this text')
    const view = editor.getView()
    const doc = view.state.doc
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 6, 10)))
    panel.open()
    expect(view.state.selection.from).toBe(6)
    expect(view.state.selection.to).toBe(10)
    panel.close()
  })

  it('Enter steps through matches and updates the counter', () => {
    const { panel } = setup('one two one')
    panel.open()
    const bar = document.querySelector('#edi-search-bar')!
    const find = bar.querySelector<HTMLInputElement>('.edi-search-input')!
    setInputValue(find, 'one')
    expect(bar.querySelector<HTMLElement>('.edi-search-count')!.textContent).toBe('1 / 2')
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(bar.querySelector<HTMLElement>('.edi-search-count')!.textContent).toBe('2 / 2')
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(bar.querySelector<HTMLElement>('.edi-search-count')!.textContent).toBe('1 / 2')
    panel.close()
  })

  it('edits under an open search keep the active match instead of resetting it', () => {
    const { editor, panel } = setup('hello world hello')
    const view = editor.getView()
    panel.open()
    const bar = document.querySelector('#edi-search-bar')!
    const find = bar.querySelector<HTMLInputElement>('.edi-search-input')!
    setInputValue(find, 'hello')
    expect(bar.querySelector<HTMLElement>('.edi-search-count')!.textContent).toBe('1 / 2')
    view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size))
    panel.refresh()
    expect(view.dom.querySelectorAll('.edi-search-match, .edi-search-match-current').length).toBe(2)
    expect(bar.querySelector<HTMLElement>('.edi-search-count')!.textContent).toBe('1 / 2')
    expect(view.state.selection.from).toBe(1)
    expect(view.state.selection.to).toBe(6)
    panel.close()
  })

  it('Escape closes and returns focus to the editor, clearing highlights', () => {
    const { editor, panel } = setup('hello hello')
    panel.open()
    const bar = document.querySelector('#edi-search-bar')!
    const find = bar.querySelector<HTMLInputElement>('.edi-search-input')!
    setInputValue(find, 'hello')
    const view = editor.getView()
    expect(view.dom.querySelectorAll('.edi-search-match, .edi-search-match-current').length).toBe(2)
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect((bar as HTMLElement).hidden).toBe(true)
    expect(view.dom.querySelectorAll('.edi-search-match, .edi-search-match-current').length).toBe(0)
    expect(document.activeElement).toBe(view.dom)
  })

  it('seeds the query from the current editor selection', () => {
    const { editor, panel } = setup('find this text')
    const view = editor.getView()
    const doc = view.state.doc
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(doc, 6, 10)),
    )
    panel.open()
    const bar = document.querySelector('#edi-search-bar')!
    const find = bar.querySelector<HTMLInputElement>('.edi-search-input')!
    expect(find.value).toBe('this')
    panel.close()
  })

  it('hides the replace row by default and shows it on demand', () => {
    const { panel } = setup('a')
    panel.open()
    const row = document.querySelector('.edi-search-row:last-child') as HTMLElement
    expect(row.hidden).toBe(true)
    panel.close()

    panel.open({ replace: true })
    expect(row.hidden).toBe(false)
    panel.close()
  })

  it('Replace All rewrites every match in the document', () => {
    const { editor, panel } = setup('hello hello\n\n| hello |\n| --- |')
    panel.open({ replace: true })
    const bar = document.querySelector('#edi-search-bar')!
    const find = bar.querySelectorAll<HTMLInputElement>('.edi-search-input')[0]!
    const replace = bar.querySelectorAll<HTMLInputElement>('.edi-search-input')[1]!
    setInputValue(find, 'hello')
    setInputValue(replace, 'bye')
    const all = bar.querySelector<HTMLButtonElement>('[data-action="replace-all"]')!
    all.click()
    expect(bar.querySelector<HTMLElement>('.edi-search-count')!.textContent).toBe('0 / 0')
    const markdown = editor.getView().state.doc.textContent
    expect(markdown).toContain('bye bye')
    expect(all.closest('#edi-search-bar')!.parentElement).toBeTruthy()
    panel.close()
  })

  it('case toggle re-runs the query', () => {
    const { panel } = setup('Hello hello')
    panel.open()
    const bar = document.querySelector('#edi-search-bar')!
    const find = bar.querySelector<HTMLInputElement>('.edi-search-input')!
    const count = bar.querySelector<HTMLElement>('.edi-search-count')!
    setInputValue(find, 'hello')
    expect(count.textContent).toBe('1 / 2')
    const toggle = bar.querySelector<HTMLButtonElement>('[data-toggle="caseSensitive"]')!
    toggle.click()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(count.textContent).toBe('1 / 1')
    panel.close()
  })
})