import { NodeSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import type { Mark, Node as ProseNode } from 'prosemirror-model'

/** Match-case / whole-word / regex toggles for the search query. */
export interface SearchFlags {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export const DEFAULT_FLAGS: SearchFlags = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
}

/**
 * A match in the document's flat text. `doc` matches live inside a text node
 * (positions the ProseMirror editor can select and decorate). `block` matches
 * live inside an atom block whose visible text is stored in an attribute
 * (`table` and `mermaid_block` keep their cell/source text as `attrs.value`,
 * i.e. the raw pipe/source markup) — the editor cannot select inside an atom,
 * so those matches address the block node plus an offset range into the attr.
 */
export type SearchMatch =
  | { kind: 'doc'; from: number; to: number }
  | { kind: 'block'; nodeType: 'table' | 'mermaid_block'; pos: number; from: number; to: number }

export interface SearchState {
  query: string
  flags: SearchFlags
  matches: SearchMatch[]
  current: number
}

export const SEARCH_KEY = new PluginKey<SearchState>('edi-search')

/** Atom blocks whose visible text is plain text in `attrs.value`. */
const SEARCHABLE_BLOCK_ATOMS: ReadonlySet<string> = new Set(['table', 'mermaid_block'])

const MAX_SELECTION_SEED = 200

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the RegExp a query implies. Literal queries are escaped verbatim;
 * regex queries are used as-is. Whole-word wraps the source in Unicode-aware
 * letter/digit/underscore boundaries. Returns null for invalid regex input.
 */
export function buildSearchRegex(query: string, flags: SearchFlags): RegExp | null {
  try {
    let source = flags.regex ? query : escapeRegexLiteral(query)
    if (flags.wholeWord) {
      source = `(?<![\\p{L}\\p{M}\\p{N}_])(?:${source})(?![\\p{L}\\p{M}\\p{N}_])`
    }
    return new RegExp(source, flags.caseSensitive ? 'gu' : 'giu')
  } catch {
    return null
  }
}

function collectSpanMatches(
  re: RegExp,
  text: string,
  push: (from: number, to: number) => void,
): void {
  re.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const { index } = match
    const length = match[0].length
    if (length > 0) push(index, index + length)
    if (length === 0) re.lastIndex++ // zero-length regexes must advance or they loop forever
    if (re.lastIndex > text.length) break
  }
}

/**
 * Match ranges of one query within an arbitrary string. The table node views
 * use this on each rendered cell's text so search highlights the *on-screen*
 * version of a spreadsheet/table (ProseMirror decorations cannot reach inside
 * an atom node). The match counter/navigation stays driven by
 * `findSearchMatches` over the document's raw flat text.
 */
export function searchMatchesInText(
  query: string,
  flags: SearchFlags,
  text: string,
): { from: number; to: number }[] {
  const re = buildSearchRegex(query, flags)
  if (!re || text === '') return []
  const ranges: { from: number; to: number }[] = []
  collectSpanMatches(re, text, (from, to) => ranges.push({ from, to }))
  return ranges
}

/**
 * Flat-text search over one document: every text node plus the raw value text
 * of spreadsheet/mermaid blocks. Matches never straddle node boundaries, so a
 * `doc` match is always decoratable and a `block` match maps cleanly back onto
 * its attribute string. Masked fields, images and source blocks contribute no
 * text: their content is deliberately hidden or machine-buffered.
 */
export function findSearchMatches(query: string, flags: SearchFlags, doc: ProseNode): SearchMatch[] {
  const re = buildSearchRegex(query, flags)
  if (!re) return []
  const matches: SearchMatch[] = []
  doc.descendants((node, pos) => {
    if (node.isText && node.text != null) {
      collectSpanMatches(re, node.text, (from, to) => {
        matches.push({ kind: 'doc', from: pos + from, to: pos + to })
      })
    } else if (SEARCHABLE_BLOCK_ATOMS.has(node.type.name)) {
      const value = String(node.attrs.value ?? '')
      if (value !== '') {
        collectSpanMatches(re, value, (from, to) => {
          matches.push({
            kind: 'block',
            nodeType: node.type.name as 'table' | 'mermaid_block',
            pos,
            from,
            to,
          })
        })
      }
    }
  })
  return matches
}

function nearestMatchIndex(matches: SearchMatch[], pos: number): number {
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const anchor = match.kind === 'doc' ? match.from : match.pos
    const distance = Math.abs(anchor - pos)
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/**
 * ProseMirror plugin driving find/replace. Plugin state holds the query, the
 * recomputed match list for the *current* document, and the index of the active
 * match; `props.decorations` lights the doc matches up in the rendered editor
 * (the "highlight on the rendered version"). Block matches are kept out of the
 * decoration set — selecting one highlights the whole block via NodeSelection.
 */
export function searchPlugin(): Plugin {
  return new Plugin<SearchState>({
    key: SEARCH_KEY,
    state: {
      init() {
        return { query: '', flags: DEFAULT_FLAGS, matches: [], current: -1 }
      },
      apply(tr, value, _oldState, newState) {
        const meta = tr.getMeta(SEARCH_KEY) as
          | { query?: string; flags?: SearchFlags; current?: number }
          | undefined
        // Nothing about the search can change on a transaction that carries no
        // search meta and does not touch the document. Returning the *same*
        // state object lets the view hook below (and any identity-based
        // subscriber) tell "search state actually changed" apart from "view
        // blinked". With no active query the match list is definitionally empty,
        // so doc edits cannot change it either.
        if (meta === undefined && (!tr.docChanged || value.query === '')) return value
        const query = meta?.query ?? value.query
        const flags = meta?.flags ?? value.flags
        const matches = findSearchMatches(query, flags, newState.doc)
        let current = value.current
        if (meta && typeof meta.current === 'number') {
          current = meta.current
        } else if (tr.docChanged && current >= 0 && value.matches[current]) {
          // Editing under an open search should keep the cursor on the match
          // nearest to where the old one used to be, not silently jump to 0.
          const previous = value.matches[current]!
          const anchor = previous.kind === 'doc' ? previous.from : previous.pos
          current = nearestMatchIndex(matches, tr.mapping.map(anchor))
        }
        if (matches.length === 0) {
          current = -1
        } else if (current >= matches.length) {
          current = matches.length - 1
        }
        return { query, flags, matches, current }
      },
    },
    props: {
      decorations(state) {
        const search = SEARCH_KEY.getState(state)
        if (!search || search.matches.length === 0) return DecorationSet.empty
        const decorations: Decoration[] = []
        for (let i = 0; i < search.matches.length; i++) {
          const match = search.matches[i]!
          if (match.kind !== 'doc') continue
          const cls = i === search.current ? 'edi-search-match-current' : 'edi-search-match'
          decorations.push(Decoration.inline(match.from, match.to, { class: cls }))
        }
        return DecorationSet.create(state.doc, decorations)
      },
    },
    view() {
      return {
        update(view, prevState) {
          if (SEARCH_KEY.getState(view.state) === SEARCH_KEY.getState(prevState)) return
          const listeners = searchListeners.get(view)
          if (!listeners) return
          for (const listener of [...listeners]) listener()
        },
      }
    },
  })
}

export function getSearchState(view: EditorView): SearchState {
  return (
    SEARCH_KEY.getState(view.state) ?? { query: '', flags: DEFAULT_FLAGS, matches: [], current: -1 }
  )
}

const searchListeners = new WeakMap<EditorView, Set<() => void>>()

/**
 * Subscribe to search-state changes (query, flags, active match) for one
 * editor view. Node views that render *inside* searchable atoms — the
 * spreadsheet/plain table grids, which ProseMirror decorations cannot reach —
 * use this to repaint cell-level highlights. The returned function
 * unsubscribes. Fires only when the search state object identity changes,
 * i.e. when the query/flags/matches/current actually moved.
 */
export function subscribeSearchChanges(view: EditorView, listener: () => void): () => void {
  let listeners = searchListeners.get(view)
  if (!listeners) {
    listeners = new Set()
    searchListeners.set(view, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners!.delete(listener)
    if (listeners!.size === 0) searchListeners.delete(view)
  }
}

export function hasSearchSelection(view: EditorView): boolean {
  const search = getSearchState(view)
  return search.current >= 0 && search.current < search.matches.length
}

/** Re-run the query against the current document, clearing any active match. */
export function updateSearchQuery(
  view: EditorView,
  query: string,
  flags: SearchFlags = getSearchState(view).flags,
): void {
  view.dispatch(view.state.tr.setMeta(SEARCH_KEY, { query, flags, current: -1 }))
}

/** Make the numbered match active: select the text (or the whole block) and scroll it in. */
export function selectSearchMatch(view: EditorView, index: number): boolean {
  const search = getSearchState(view)
  const count = search.matches.length
  if (count === 0) return false
  const clamped = ((index % count) + count) % count
  const match = search.matches[clamped]!
  let tr = view.state.tr
  if (match.kind === 'doc') {
    tr = tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to))
  } else {
    if (!view.state.doc.nodeAt(match.pos)) return false
    tr = tr.setSelection(NodeSelection.create(view.state.doc, match.pos))
  }
  view.dispatch(tr.setMeta(SEARCH_KEY, { current: clamped }).scrollIntoView())
  return true
}

/** Move to the next (dir 1) or previous (dir -1) match, wrapping around. */
export function searchNext(view: EditorView, dir: 1 | -1 = 1): boolean {
  const search = getSearchState(view)
  const count = search.matches.length
  if (count === 0) return false
  if (search.current < 0) {
    return selectSearchMatch(view, dir > 0 ? 0 : count - 1)
  }
  return selectSearchMatch(view, search.current + dir)
}

function marksAt(view: EditorView, pos: number): readonly Mark[] {
  return view.state.doc.resolve(pos).marks()
}

/** Replace text across `ranges` (ascending); returns null when nothing changed. */
export function applyReplacementsToText(
  text: string,
  ranges: readonly { from: number; to: number }[],
  replacement: string,
): string | null {
  let out = text
  let changed = false
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { from, to } = ranges[i]!
    if (from >= to) continue
    out = out.slice(0, from) + replacement + out.slice(to)
    changed = true
  }
  return changed ? out : null
}

/** Replace the active match. Doc matches keep the marks active at their start. */
export function replaceSearchCurrent(view: EditorView, replacement: string): boolean {
  const search = getSearchState(view)
  const match = search.matches[search.current]
  if (!match) return false

  if (match.kind === 'doc') {
    const from = match.from
    const to = match.to
    let tr = view.state.tr
    tr = replacement === ''
      ? tr.delete(from, to)
      : tr.replaceWith(from, to, view.state.schema.text(replacement, marksAt(view, from)))
    view.dispatch(tr.setMeta(SEARCH_KEY, { current: -1 }))
  } else {
    // A table's value is pipe-format markup; an embedded newline would break the
    // row structure, so refuse rather than corrupt the grid.
    if (match.nodeType === 'table' && replacement.includes('\n')) return false
    const node = view.state.doc.nodeAt(match.pos)
    if (!node) return false
    const value = applyReplacementsToText(String(node.attrs.value ?? ''), [match], replacement)
    if (value === null) return false
    const tr = view.state.tr.setNodeMarkup(match.pos, undefined, { ...node.attrs, value })
    view.dispatch(tr.setMeta(SEARCH_KEY, { current: -1 }))
  }
  // Settle on the next occurrence now that the list has shifted.
  return selectSearchMatch(view, search.current)
}

/**
 * Replace every match in one transaction. Doc replacements are applied in
 * reverse document order; spreadsheet/mermaid blocks have their whole value
 * rebuilt once and written via setNodeMarkup (the table node view re-parses and
 * re-renders on an attr change).
 */
export function replaceAllSearch(
  view: EditorView,
  replacement: string,
): { replaced: number } {
  const search = getSearchState(view)
  const doc = view.state.doc
  type BlockGroup = { nodeType: 'table' | 'mermaid_block'; pos: number; ranges: { from: number; to: number }[] }
  const blocks = new Map<number, BlockGroup>()
  for (const match of search.matches) {
    let group = match.kind === 'block' ? blocks.get(match.pos) : undefined
    if (!group && match.kind === 'block') {
      group = { nodeType: match.nodeType, pos: match.pos, ranges: [] }
      blocks.set(match.pos, group)
    }
    if (group) group.ranges.push({ from: match.from, to: match.to })
  }

  const ops: ({ kind: 'doc'; from: number; to: number; marks: readonly Mark[] } | BlockGroup & {
    kind: 'block'
    value: string
  })[] = []
  for (const match of search.matches) {
    if (match.kind === 'doc') {
      ops.push({ kind: 'doc', from: match.from, to: match.to, marks: marksAt(view, match.from) })
    }
  }
  for (const group of blocks.values()) {
    const node = doc.nodeAt(group.pos)
    if (!node) return { replaced: 0 }
    if (group.nodeType === 'table' && replacement.includes('\n')) continue
    const value = applyReplacementsToText(String(node.attrs.value ?? ''), group.ranges, replacement)
    if (value !== null) ops.push({ kind: 'block', ...group, value })
  }

  ops.sort((a, b) => {
    const posA = a.kind === 'doc' ? a.from : a.pos
    const posB = b.kind === 'doc' ? b.from : b.pos
    return posB - posA
  })

  let tr = view.state.tr
  for (const op of ops) {
    if (op.kind === 'doc') {
      const from = tr.mapping.map(op.from)
      const to = tr.mapping.map(op.to)
      tr = replacement === ''
        ? tr.delete(from, to)
        : tr.replaceWith(from, to, view.state.schema.text(replacement, op.marks))
    } else {
      const pos = tr.mapping.map(op.pos)
      const node = doc.nodeAt(op.pos)
      if (!node) continue
      tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, value: op.value })
    }
  }
  view.dispatch(tr.setMeta(SEARCH_KEY, { current: -1 }))
  return { replaced: ops.length }
}

/** Text (capped) of the editor's current selection, for seeding the find box. */
export function selectedSearchText(view: EditorView): string {
  const { selection } = view.state
  if (selection.empty) return ''
  if (selection instanceof NodeSelection) return ''
  const text = view.state.doc.textBetween(selection.from, selection.to, '\n', '\n')
  return text.length <= MAX_SELECTION_SEED ? text : text.slice(0, MAX_SELECTION_SEED)
}