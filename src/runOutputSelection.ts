/**
 * What the reader has selected in a run's output, for Copy.
 *
 * The output (`.exec-output`, `src/terminal.ts`) is not document content, so the
 * document model cannot hold a selection in it: a drag there is the browser's
 * own selection, and ProseMirror's stays wherever it was before. The editor's
 * Copy, Cut and "is anything selected" read ProseMirror's, so they would copy
 * that stale selection, or nothing. They ask this first.
 *
 * Only a selection with both ends in one output counts. One that runs from the
 * output out into the document is the document's to answer.
 */
export function runOutputSelectionText(): string | null {
  const selection = document.getSelection()
  if (selection === null || selection.isCollapsed) return null
  const output = outputOf(selection.anchorNode)
  if (output === null || output !== outputOf(selection.focusNode)) return null
  const text = selection.toString()
  return text === '' ? null : text
}

function outputOf(node: Node | null): Element | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  return element?.closest('.exec-output') ?? null
}
