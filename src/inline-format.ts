// Registry for "inline formatting applies to the active spreadsheet cell".
// The formatting toolbar's inline buttons (bold/italic/strike/code/link/
// highlight/sub/sup) act on the ProseMirror selection by default, but when a
// spreadsheet cell is the active editing target they should format that cell's
// markdown instead. The active table node-view registers itself when it gains
// focus; the toolbar checks the registry before touching the editor selection.

export type InlineCellKind =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'secret'
  | 'highlight'
  | 'sub'
  | 'sup'

export interface InlineCellHost {
  /**
   * Apply an inline formatting toggle to the host's active cell (marking the
   * cell's raw markdown), or `false` when there is nothing to format.
   */
  applyInline(kind: InlineCellKind, url?: string): boolean
}

let activeHost: InlineCellHost | null = null

export function getActiveCellHost(): InlineCellHost | null {
  return activeHost
}

export function setActiveCellHost(host: InlineCellHost | null): void {
  activeHost = host
}