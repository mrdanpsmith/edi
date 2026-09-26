import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { createBlockEditor, type BlockEditor } from './editor'
import { proseToMarkdown } from './markdown'
import {
  buildSearchRegex,
  findSearchMatches,
  getSearchState,
  replaceAllSearch,
  replaceSearchCurrent,
  searchNext,
  selectSearchMatch,
  updateSearchQuery,
  type SearchFlags,
} from './search'

beforeEach(() => {
  document.body.innerHTML = ''
})

const DEFAULT_FLAGS: SearchFlags = { caseSensitive: false, wholeWord: false, regex: false }

function flags(overrides: Partial<SearchFlags>): SearchFlags {
  return { ...DEFAULT_FLAGS, ...overrides }
}

describe('buildSearchRegex', () => {
  it('escapes literal input', () => {
    const re = buildSearchRegex('a.b', flags({}))!
    expect('a.b axb'.match(re)).toEqual(['a.b'])
  })

  it('uses regex input verbatim and flags via i/u', () => {
    const re = buildSearchRegex('h.llo', flags({ regex: true }))!
    expect('hello hullo'.match(re)).toEqual(['hello', 'hullo'])
  })

  it('applies case sensitivity', () => {
    const re = buildSearchRegex('hello', flags({ caseSensitive: true }))!
    expect('hello Hello'.match(re)).toEqual(['hello'])
  })

  it('wraps whole-word in unicode-aware boundaries', () => {
    const re = buildSearchRegex('hello', flags({ wholeWord: true }))!
    expect('hello xhellox xhello hello2'.match(re)).toEqual(['hello'])
  })

  it('returns null for an invalid regex', () => {
    expect(buildSearchRegex('(((', flags({ regex: true }))).toBeNull()
  })
})

describe('findSearchMatches', () => {
  function matches(markdown: string, query: string, overrides: Partial<SearchFlags> = {}) {
    const editor = createBlockEditor(document.body, markdown)
    try {
      return findSearchMatches(query, flags(overrides), editor.getView().state.doc)
    } finally {
      editor.destroy()
    }
  }

  it('finds text across paragraphs, headings and fenced code (case-insensitive)', () => {
    const found = matches(
      '# Hello\n\nhello world\n\n```js\nsay("hello")\n```',
      'hello',
    )
    expect(found.filter((m) => m.kind === 'doc')).toHaveLength(3)
  })

  it('respects case sensitivity', () => {
    const found = matches('# Hello\n\nhello', 'hello', { caseSensitive: true })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'doc', from: expect.any(Number) })
  })

  it('matches whole words only', () => {
    const found = matches('cat scatter cat', 'cat', { wholeWord: true })
    expect(found).toHaveLength(2)
  })

  it('finds text inside spreadsheet and mermaid block values', () => {
    const found = matches(
      '| Name | Qty |\n| --- | --- |\n| Bolt | 12 |\n\n```mermaid\ngraph TD\nA --> B\n```',
      '12',
    )
    const table = found.find((m) => m.kind === 'block' && m.nodeType === 'table')
    expect(table).toMatchObject({ kind: 'block', nodeType: 'table' })

    const mermaid = matches(
      '```mermaid\ngraph TD\nA --> B\n```',
      'graph',
    ).find((m) => m.kind === 'block')
    expect(mermaid).toMatchObject({ kind: 'block', nodeType: 'mermaid_block' })
  })

  it('never matches inside masked fields or images', () => {
    const found = matches('before !masked[secret]{label="hidden"} after ![x](img.png)', 'secret')
    expect(found).toHaveLength(0)
  })

  it('skips zero-length regex matches instead of looping', () => {
    const found = matches('mmm', 'm*', { regex: true })
    expect(found.every((m) => m.kind !== 'doc' || m.to > m.from)).toBe(true)
  })

  it('returns nothing for an empty query or invalid regex', () => {
    expect(matches('hello', '')).toHaveLength(0)
    expect(matches('hello', '(((', { regex: true })).toHaveLength(0)
  })
})

describe('search plugin and editor actions', () => {
  function setup(markdown: string) {
    const editor = createBlockEditor(document.body, markdown)
    return { editor, view: editor.getView() }
  }

  it('decorates every doc match in the rendered editor', () => {
    const { editor, view } = setup('hello world hello')
    updateSearchQuery(view, 'hello')
    expect(getSearchState(view).matches).toHaveLength(2)
    expect(view.dom.querySelectorAll('.edi-search-match').length).toBe(2)
    expect(view.dom.querySelectorAll('.edi-search-match-current').length).toBe(0)
    editor.destroy()
  })

  it('advances through matches with wrap-around', () => {
    const { editor, view } = setup('one, two, one, two')
    updateSearchQuery(view, 'one')
    expect(searchNext(view, 1)).toBe(true)
    expect(getSearchState(view).current).toBe(0)
    expect(searchNext(view, 1)).toBe(true)
    expect(getSearchState(view).current).toBe(1)
    expect(searchNext(view, 1)).toBe(true)
    expect(getSearchState(view).current).toBe(0)
    expect(searchNext(view, -1)).toBe(true)
    expect(getSearchState(view).current).toBe(1)
    editor.destroy()
  })

  it('selects the match text', () => {
    const { editor, view } = setup('find me here')
    updateSearchQuery(view, 'find me')
    expect(selectSearchMatch(view, 0)).toBe(true)
    const { from, to } = view.state.selection
    expect(view.state.doc.textBetween(from, to)).toBe('find me')
    editor.destroy()
  })

  it('replaces the active match, preserving its marks', () => {
    const { editor, view } = setup('**bold** and bold')
    updateSearchQuery(view, 'bold')
    expect(selectSearchMatch(view, 0)).toBe(true)
    expect(replaceSearchCurrent(view, 'big')).toBe(true)
    expect(proseToMarkdown(view.state.doc)).toContain('**big**')
    editor.destroy()
  })

  it('replaces every match in one transaction, incl. spreadsheet cell text', () => {
    const { editor, view } = setup('222\n\n| A | 2 |\n| --- | --- |\n| 2 | B |')
    updateSearchQuery(view, '2')
    replaceAllSearch(view, '9')
    const markdown = proseToMarkdown(view.state.doc)
    expect(markdown).toContain('999')
    expect(markdown).toContain('| A | 9 |')
    expect(markdown).toContain('| 9 | B |')
    expect(getSearchState(view).matches).toHaveLength(0)
    editor.destroy()
  })

  it('selects spreadsheet/match blocks with a node selection (highlight on render)', () => {
    const { editor, view } = setup('| Bolt | 12 |\n| --- | --- |')
    updateSearchQuery(view, 'Bolt')
    const index = getSearchState(view).matches.findIndex(
      (m) => m.kind === 'block' && m.nodeType === 'table',
    )
    expect(selectSearchMatch(view, index)).toBe(true)
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    expect((view.state.selection as NodeSelection).node.type.name).toBe('table')
    editor.destroy()
  })

  it('refuses to inject a newline into a spreadsheet value', () => {
    const { editor, view } = setup('| Bolt | 12 |\n| --- | --- |')
    updateSearchQuery(view, '12')
    const index = getSearchState(view).matches.findIndex(
      (m) => m.kind === 'block' && m.nodeType === 'table',
    )
    expect(selectSearchMatch(view, index)).toBe(true)
    expect(replaceSearchCurrent(view, '12\n3')).toBe(false)
    expect(proseToMarkdown(view.state.doc)).toContain('12')
    editor.destroy()
  })

  it('keeps the cursor anchored to the active match when the doc is edited', () => {
    const { editor, view } = setup('cat fox cat')
    updateSearchQuery(view, 'cat')
    selectSearchMatch(view, 1)
    expect(getSearchState(view).current).toBe(1)
    view.dispatch(view.state.tr.insertText(' cat', 12))
    expect(getSearchState(view).current).toBe(1)
    expect(getSearchState(view).matches).toHaveLength(3)
    editor.destroy()
  })

  it('clears matches and decorations on an empty query', () => {
    const { editor, view } = setup('a a a')
    updateSearchQuery(view, 'a')
    expect(view.dom.querySelectorAll('.edi-search-match').length).toBe(3)
    updateSearchQuery(view, '')
    expect(getSearchState(view).matches).toHaveLength(0)
    expect(view.dom.querySelectorAll('.edi-search-match').length).toBe(0)
    editor.destroy()
  })

  it('keeps a replacing cursor anchored to the match when its text is edited', () => {
    const { editor, view } = setup('hello')
    updateSearchQuery(view, 'hello')
    expect(selectSearchMatch(view, 0)).toBe(true)
    view.dispatch(view.state.tr.insertText('Z', 1))
    expect(getSearchState(view).current).toBe(0)
    const { from, to } = view.state.selection as TextSelection
    expect(view.state.doc.textBetween(from, to)).toBe('hello')
    editor.destroy()
  })
})

describe('table-cell search highlighting (highlight on the rendered version)', () => {
  function setup(markdown: string) {
    const editor = createBlockEditor(document.body, markdown)
    return { editor, view: editor.getView() }
  }

  function tablePos(view: EditorView): number {
    let pos = -1
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'table') {
        pos = p
        return false
      }
      return true
    })
    if (pos < 0) throw new Error('no table in doc')
    return pos
  }

  function toSpreadsheet(editor: BlockEditor): void {
    const view = editor.getView()
    const pos = tablePos(view)
    const node = view.state.doc.nodeAt(pos)
    if (!node) throw new Error('no table node at pos')
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, _plain: false }))
  }

  it('wraps matching cell text in the spreadsheet grid', () => {
    const { editor, view } = setup('| Bolt | 12 |\n| --- | --- |\n| Nut | 12 |')
    toSpreadsheet(editor)
    updateSearchQuery(view, '12')
    const spans = Array.from(view.dom.querySelectorAll('.ss-grid .edi-search-match'))
    expect(spans).toHaveLength(2)
    expect(spans.map((s) => s.textContent)).toEqual(['12', '12'])
    editor.destroy()
  })

  it('moves the current-match emphasis from cell to cell as the search steps', () => {
    const { editor, view } = setup('| Bolt | 12 |\n| --- | --- |\n| Nut | 12 |')
    toSpreadsheet(editor)
    updateSearchQuery(view, '12')
    const current = (): string | undefined =>
      view.dom.querySelector('.edi-search-match-current')?.closest('td')?.dataset.row
    expect(current()).toBeUndefined()
    selectSearchMatch(view, 0)
    expect(current()).toBe('0')
    searchNext(view, 1)
    expect(current()).toBe('1')
    searchNext(view, 1)
    expect(current()).toBe('0')
    editor.destroy()
  })

  it('highlights matches in the default plain (view-mode) table', () => {
    const { editor, view } = setup('| Bolt | 12 |\n| --- | --- |\n| Nut | 12 |')
    updateSearchQuery(view, '12')
    const spans = Array.from(view.dom.querySelectorAll('.ss-plain .edi-search-match'))
    expect(spans).toHaveLength(2)
    editor.destroy()
  })

  it('clears cell highlights when the query is emptied', () => {
    const { editor, view } = setup('| Bolt | 12 |\n| --- | --- |')
    updateSearchQuery(view, '12')
    expect(view.dom.querySelectorAll('.ss-plain .edi-search-match').length).toBe(1)
    updateSearchQuery(view, '')
    expect(view.dom.querySelectorAll('.ss-plain .edi-search-match').length).toBe(0)
    editor.destroy()
  })

  it('highlights the displayed text of a cell that contains an escaped pipe', () => {
    const { editor, view } = setup('| a\\|b | c |\n| --- | --- |')
    updateSearchQuery(view, 'b')
    const spans = Array.from(view.dom.querySelectorAll('.ss-plain .edi-search-match'))
    expect(spans).toHaveLength(1)
    expect(spans[0]?.textContent).toBe('b')
    editor.destroy()
  })

  it('scrolls the cell under the active match into view', () => {
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    const scrollSpy = vi.fn()
    const owned = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollSpy,
      configurable: true,
    })
    try {
      const { editor, view } = setup('| Bolt | 12 |\n| --- | --- |\n| Nut | 12 |')
      updateSearchQuery(view, '12')
      // No current match yet: no scroll is scheduled.
      expect(raf).not.toHaveBeenCalled()
      selectSearchMatch(view, 0)
      expect(raf).toHaveBeenCalled()
      for (const [callback] of raf.mock.calls) callback(0)
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
      editor.destroy()
    } finally {
      vi.unstubAllGlobals()
      if (owned) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', owned)
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})