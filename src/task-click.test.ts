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

function taskPluginOf(view: EditorView) {
  return view.state.plugins.find((p) => p.props?.handleDOMEvents?.click)!
}

function clickAt(view: EditorView, resolveTo: number): void {
  // Simulate a DOM click whose resolved document position is `resolveTo`.
  view.posAtCoords = () => ({ pos: resolveTo, inside: -1 }) as never
  const li = {
    closest: (sel: string) => (sel === 'li[data-checked]' ? { dataset: {} } : null),
  }
  const event = { target: li, clientX: 0, clientY: 0 } as unknown as MouseEvent
  const plugin = taskPluginOf(view)
  const handler = plugin.props.handleDOMEvents!.click as (
    v: EditorView,
    e: MouseEvent,
  ) => boolean
  handler.call(plugin, view, event)
}

function makeView(markdown: string): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = markdownToProse(markdown, schema)
  return new EditorView(host, {
    state: EditorState.create({ doc, plugins: [taskClickPlugin(), keymap(baseKeymap)] }),
  })
}

describe('taskClickPlugin boundary clicks', () => {
  it('toggles when clicking inside the task text', () => {
    const view = makeView('- [x] task\n- [ ] two')
    clickAt(view, 5) // inside "task"
    expect(proseToMarkdown(view.state.doc)).toContain('- [ ] task')
    view.destroy()
  })

  it('does not toggle when clicking at the trailing boundary of a task item', () => {
    const view = makeView('- [x] task\n- [ ] two')
    clickAt(view, 8) // boundary right after "task" inside the li
    expect(proseToMarkdown(view.state.doc)).toContain('- [x] task')
    view.destroy()
  })
})
