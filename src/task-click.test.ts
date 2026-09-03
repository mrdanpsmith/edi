import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { taskClickPlugin } from './formatToolbar'

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

function makeView(markdown: string): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = markdownToProse(markdown, schema)
  return new EditorView(host, {
    state: EditorState.create({ doc, plugins: [taskClickPlugin(), keymap(baseKeymap)] }),
  })
}

function clickCheckbox(view: EditorView, index: number): void {
  const input = view.dom.querySelectorAll('input[data-task-check]')[index]
  if (!input) throw new Error(`checkbox ${index} not found in editor DOM`)
  input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('taskClickPlugin checkbox clicks', () => {
  it('unchecks a checked item', () => {
    const view = makeView('- [x] task\n- [ ] two')
    clickCheckbox(view, 0)
    expect(proseToMarkdown(view.state.doc)).toContain('- [ ] task')
    view.destroy()
  })

  it('checks an unchecked item', () => {
    const view = makeView('- [x] task\n- [ ] two')
    clickCheckbox(view, 1)
    expect(proseToMarkdown(view.state.doc)).toContain('- [x] two')
    view.destroy()
  })

  it('does not toggle a non-task list item', () => {
    const view = makeView('- plain item\n- [ ] two')
    const inputs = view.dom.querySelectorAll('input[data-task-check]')
    expect(inputs.length).toBe(1)
    expect(proseToMarkdown(view.state.doc)).toContain('- plain item')
    expect(proseToMarkdown(view.state.doc)).toContain('- [ ] two')
    view.destroy()
  })
})
