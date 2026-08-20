import type { EditorView } from 'prosemirror-view'
import { getSourceBlockState, toggleSourceMode } from './blockplugin'

export function attachBlockHandles(view: EditorView): void {
  view.dom.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.block-handle')
    if (!target) return
    e.preventDefault()
    e.stopPropagation()

    const posAttr = target.getAttribute('data-block-pos')
    if (!posAttr) return
    const pos = Number(posAttr)
    if (isNaN(pos) || pos < 0 || pos >= view.state.doc.content.size) return

    const state = view.state
    const blockState = getSourceBlockState(state)

    if (blockState.sourceBlockPos === pos) {
      return
    }

    const tr = toggleSourceMode(state, pos)
    view.dispatch(tr)
  })
}
