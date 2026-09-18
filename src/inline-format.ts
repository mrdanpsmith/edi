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

export interface CellLinkContext {
  /** The link's text context: the selected text, or the cell's content when
   * nothing is selected. '' means none — the dialog then asks for link text. */
  text: string
  /** The existing href the text context points at ('' when not already a
   * link), prefilled into the dialog. */
  url: string
}

export interface InlineCellHost {
  /**
   * Apply an inline formatting toggle to the host's active cell (marking the
   * cell's raw markdown), or `false` when there is nothing to format.
   */
  applyInline(kind: InlineCellKind, url?: string): boolean
  /**
   * Snapshot the active cell's link context before the dialog opens — the
   * dialog steals focus, which blurs and commits any in-cell editor and would
   * otherwise discard the user's text selection. Must be called on mousedown.
   */
  beginCellLink(): CellLinkContext
  /** Apply (or, with an empty URL, remove) a link from the snapshot taken by
   * `beginCellLink`, using the dialog's optional link text when no text was
   * selected. Returns `false` when there was no snapshot or nothing changed. */
  applyCellLink(text: string, url: string): boolean
}

let activeHost: InlineCellHost | null = null

export function getActiveCellHost(): InlineCellHost | null {
  return activeHost
}

export function setActiveCellHost(host: InlineCellHost | null): void {
  activeHost = host
}