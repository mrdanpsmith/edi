/**
 * Each runnable block's last finished run, kept with the document's editor state.
 *
 * A run's output is drawn by the block's node view, and node views do not
 * outlive the state they were built for: switching tabs swaps the editor state
 * (`src/tabs.ts` keeps one per tab), which rebuilds every node view, and the
 * output went with them. Kept here, in plugin state, the record travels with
 * its tab's state and the rebuilt view draws it again (`RunnableBlockNodeView`).
 *
 * Like a block mode (`src/block-modes.ts`), it is **plugin state, never document
 * content**: recording a run is a transaction with no steps, so it does not
 * dirty the file and is kept out of undo.
 *
 * A record is keyed by its block's position, mapped through every edit, and
 * dropped when that block goes or its code changes: fresh code starts with no
 * output, which is also what the node view shows when its text changes.
 */

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

export interface RunRecord {
  /** The block's text when it ran; a record for any other text is stale. */
  readonly source: string
  /** Everything the run wrote, escape sequences included, in arrival order. */
  readonly output: string
  /** How it ended ("Process exited with code 1"), one line each. */
  readonly status: readonly string[]
  /** Whether the output is marked as an error. */
  readonly failed: boolean
}

type Records = ReadonlyMap<number, RunRecord>

interface RecordMeta {
  pos: number
  record: RunRecord | null
}

const runResultsKey = new PluginKey<Records>('EDI_RUN_RESULTS')

export const runResultsPlugin = new Plugin<Records>({
  key: runResultsKey,
  state: {
    init: () => new Map(),
    apply(tr, records, _before, state) {
      const meta = tr.getMeta(runResultsKey) as RecordMeta | undefined
      if (!tr.docChanged && meta === undefined) return records
      const next = new Map<number, RunRecord>()
      for (const [pos, record] of records) {
        if (!tr.docChanged) {
          next.set(pos, record)
          continue
        }
        // Text inserted right before the block pushes it along (`assoc` 1).
        const mapped = tr.mapping.mapResult(pos, 1)
        if (mapped.deleted) continue
        const node = state.doc.nodeAt(mapped.pos)
        if (node?.type.name === 'code_block' && node.textContent === record.source) next.set(mapped.pos, record)
      }
      if (meta !== undefined) {
        if (meta.record === null) next.delete(meta.pos)
        else next.set(meta.pos, meta.record)
      }
      return next
    },
  },
})

/** Whether the kept runs differ between two states: an edit, a recorded run, or a tab switch. */
export function runsChanged(before: EditorState, after: EditorState): boolean {
  return runResultsKey.getState(before) !== runResultsKey.getState(after)
}

/** Whether `state` keeps runs at all (a bare editor without the plugin does not). */
export function keepsRuns(state: EditorState): boolean {
  return runResultsKey.getState(state) !== undefined
}

/** The last finished run of the block at `pos`, if it ran the block's current text. */
export function runRecordAt(state: EditorState, pos: number): RunRecord | null {
  const record = runResultsKey.getState(state)?.get(pos) ?? null
  if (record === null) return null
  return state.doc.nodeAt(pos)?.textContent === record.source ? record : null
}

/** Keep `record` (or, with `null`, forget it) for the block at `pos`. */
export function recordRun(view: EditorView, pos: number, record: RunRecord | null): void {
  // An editor without the plugin (a bare test view) has nowhere to keep it.
  if (!keepsRuns(view.state)) return
  view.dispatch(view.state.tr.setMeta(runResultsKey, { pos, record }).setMeta('addToHistory', false))
}
