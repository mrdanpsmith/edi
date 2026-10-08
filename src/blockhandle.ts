import type { EditorView } from 'prosemirror-view'
import { currentBlockMode, toggleSourceMode } from './block-modes'

export function findBlockPosForHandle(view: EditorView, handleEl: Element): number | null {
  let wrapper: Element | null = handleEl.parentElement
  while (wrapper && wrapper !== view.dom) {
    if (wrapper.parentElement === view.dom) break
    wrapper = wrapper.parentElement
  }
  if (!wrapper || wrapper === view.dom) return null

  let result: number | null = null
  view.state.doc.forEach((_node, offset) => {
    if (result !== null) return
    if (view.nodeDOM(offset) === wrapper) {
      result = offset
    }
  })
  return result
}

export function attachBlockHandles(view: EditorView): void {
  view.dom.addEventListener('click', (e) => {
    const target = (e.target as Element).closest('.block-handle')
    if (!target) return
    e.preventDefault()
    e.stopPropagation()

    const pos = findBlockPosForHandle(view, target)
    if (pos === null || pos < 0 || pos >= view.state.doc.content.size) return

    const mode = currentBlockMode(view.state)

    if (mode !== null && mode.pos === pos) {
      return
    }

    toggleSourceMode(view, pos)
  })
}
