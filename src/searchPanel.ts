import type { EditorView } from 'prosemirror-view'
import {
  getSearchState,
  replaceAllSearch,
  replaceSearchCurrent,
  searchNext,
  selectSearchMatch,
  selectedSearchText,
  updateSearchQuery,
  type SearchFlags,
} from './search'

export interface SearchPanelOptions {
  getView: () => EditorView | null
}

/**
 * The Find/Replace bar. Search itself is a fallback plugin over the flat text
 * of the document; this panel is just the chrome that drives it: a find input,
 * match counter, prev/next, case/whole-word/regex toggles, and (optionally) a
 * replace row with Replace / Replace All. The panel never steals editor focus
 * while open; Esc returns focus to the document.
 */
export class SearchPanel {
  private readonly getView: () => EditorView | null

  private bar: HTMLElement | null = null
  private findInput: HTMLInputElement | null = null
  private replaceRow: HTMLElement | null = null
  private replaceInput: HTMLInputElement | null = null
  private countEl: HTMLElement | null = null
  private toggleEls: Record<keyof SearchFlags, HTMLButtonElement | null> = {
    caseSensitive: null,
    wholeWord: null,
    regex: null,
  }

  private query = ''
  private flags: SearchFlags = { caseSensitive: false, wholeWord: false, regex: false }

  constructor(options: SearchPanelOptions) {
    this.getView = options.getView
  }

  isOpen(): boolean {
    return this.bar !== null && !this.bar.hidden
  }

  open(options: { replace?: boolean } = {}): void {
    const view = this.getView()
    if (!view) return
    this.ensureDom()
    this.bar!.hidden = false
    this.setReplaceVisible(Boolean(options.replace))
    if (this.query === '') {
      this.query = selectedSearchText(view)
      this.findInput!.value = this.query
      this.findInput!.setSelectionRange(this.query.length, this.query.length)
    }
    this.applyQuery({ jump: false })
    this.findInput!.focus()
  }

  close(): void {
    if (!this.bar) return
    this.bar.hidden = true
    this.query = ''
    this.findInput!.value = ''
    this.replaceInput!.value = ''
    const view = this.getView()
    if (view) {
      updateSearchQuery(view, '')
      this.updateCounter()
      view.focus()
    }
  }

  /** Re-run the stored query against the active view (tab/doc switch, edits). */
  refresh(): void {
    if (!this.isOpen()) return
    const view = this.getView()
    if (!view) return
    if (this.query === '') return
    const search = getSearchState(view)
    if (
      search.query === this.query &&
      search.flags.caseSensitive === this.flags.caseSensitive &&
      search.flags.wholeWord === this.flags.wholeWord &&
      search.flags.regex === this.flags.regex
    ) {
      // Ordinary doc edits already re-ran the search against the new text and
      // moved the active match next to where it used to be; re-dispatching the
      // same query here would reset the cursor to "no match". Only the counter
      // needs a refresh. A swapped-in document (query reset to '' by the fresh
      // state) takes the re-apply branch below.
      this.updateCounter()
      return
    }
    this.applyQuery({ jump: false })
  }

  // --- DOM ---------------------------------------------------------------

  private ensureDom(): void {
    if (this.bar) return
    const bar = document.createElement('section')
    bar.id = 'edi-search-bar'
    bar.setAttribute('aria-label', 'Find and replace')
    bar.hidden = true

    const findRow = document.createElement('div')
    findRow.className = 'edi-search-row'

    this.findInput = document.createElement('input')
    this.findInput.className = 'edi-search-input'
    this.findInput.type = 'text'
    this.findInput.placeholder = 'Find'
    this.findInput.setAttribute('aria-label', 'Find')
    this.findInput.spellcheck = false
    this.findInput.addEventListener('input', () => {
      this.query = this.findInput!.value
      this.applyQuery({ jump: true })
    })
    this.findInput.addEventListener('keydown', (event) => this.handleFindKey(event))

    this.countEl = document.createElement('span')
    this.countEl.className = 'edi-search-count'
    this.countEl.setAttribute('aria-live', 'polite')

    const prev = this.button('↑', 'Previous match (Shift+Enter)', () => {
      const view = this.getView()
      if (view && searchNext(view, -1)) this.updateCounter()
    })
    prev.dataset.action = 'prev'
    const next = this.button('↓', 'Next match (Enter)', () => {
      const view = this.getView()
      if (view && searchNext(view, 1)) this.updateCounter()
    })
    next.dataset.action = 'next'
    this.toggleEls.caseSensitive = this.toggle('caseSensitive', 'Aa', 'Match case')
    this.toggleEls.wholeWord = this.toggle('wholeWord', 'Ab', 'Match whole word')
    this.toggleEls.regex = this.toggle('regex', '.*', 'Regular expression')

    const replaceToggle = this.button('…', 'Replace', () => {
      const view = this.getView()
      const show = this.replaceRow!.hidden
      this.setReplaceVisible(show)
      if (show) {
        this.replaceInput!.focus()
      } else if (view) {
        view.focus()
      }
    })
    replaceToggle.dataset.action = 'toggle-replace'

    const closeBtn = this.button('×', 'Close (Esc)', () => this.close())
    closeBtn.dataset.action = 'close'

    findRow.append(this.findInput, this.countEl, prev, next)
    findRow.append(
      this.toggleEls.caseSensitive,
      this.toggleEls.wholeWord,
      this.toggleEls.regex,
    )
    findRow.append(replaceToggle, closeBtn)

    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'edi-search-row'
    this.replaceRow.hidden = true

    this.replaceInput = document.createElement('input')
    this.replaceInput.className = 'edi-search-input'
    this.replaceInput.type = 'text'
    this.replaceInput.placeholder = 'Replace'
    this.replaceInput.setAttribute('aria-label', 'Replace')
    this.replaceInput.spellcheck = false
    this.replaceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        this.replaceOne()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        this.close()
      }
    })

    const replaceBtn = document.createElement('button')
    replaceBtn.type = 'button'
    replaceBtn.className = 'toolbar-btn toolbar-primary edi-search-btn'
    replaceBtn.textContent = 'Replace'
    replaceBtn.dataset.action = 'replace'
    replaceBtn.addEventListener('click', () => this.replaceOne())

    const allBtn = document.createElement('button')
    allBtn.type = 'button'
    allBtn.className = 'toolbar-btn edi-search-btn'
    allBtn.textContent = 'Replace all'
    allBtn.dataset.action = 'replace-all'
    allBtn.addEventListener('click', () => {
      const view = this.getView()
      if (!view) return
      replaceAllSearch(view, this.replaceInput!.value)
      this.updateCounter()
      view.focus()
    })

    this.replaceRow.append(this.replaceInput, replaceBtn, allBtn)

    bar.append(findRow, this.replaceRow)
    const workspace = document.querySelector<HTMLElement>('#workspace')
    const container = document.querySelector<HTMLElement>('#editor-container')
    if (workspace && container) {
      workspace.insertBefore(bar, container)
    } else {
      document.body.append(bar)
    }
    this.bar = bar
    this.updateCounter()
  }

  private button(
    label: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'toolbar-btn edi-search-btn'
    el.textContent = label
    el.title = title
    el.setAttribute('aria-label', title)
    el.addEventListener('click', onClick)
    return el
  }

  private toggle(kind: keyof SearchFlags, label: string, title: string): HTMLButtonElement {
    const el = this.button(label, title, () => {
      this.flags = { ...this.flags, [kind]: !this.flags[kind] }
      this.syncToggleState()
      this.applyQuery({ jump: true })
    })
    el.dataset.toggle = kind
    return el
  }

  private syncToggleState(): void {
    for (const kind of Object.keys(this.flags) as (keyof SearchFlags)[]) {
      const el = this.toggleEls[kind]
      if (el) el.setAttribute('aria-pressed', String(this.flags[kind]))
    }
  }

  private setReplaceVisible(visible: boolean): void {
    if (this.replaceRow !== null) this.replaceRow.hidden = !visible
  }

  // --- Behaviour ---------------------------------------------------------

  /**
   * Re-run the stored query. With `jump` the document focus moves with the
   * result set: the first match is selected and scrolled into view while the
   * find input keeps focus, so what you type in the box is where the caret
   * (and the editor's scroll position) lands. Opening the bar and refreshing
   * after an edit pass `jump: false` so existing cursor/selection survives.
   */
  private applyQuery(options: { jump: boolean }): void {
    const view = this.getView()
    if (!view) return
    updateSearchQuery(view, this.query, this.flags)
    if (options.jump) selectSearchMatch(view, 0)
    this.syncToggleState()
    this.updateCounter()
  }

  private updateCounter(): void {
    if (!this.countEl) return
    const view = this.getView()
    if (!view) {
      this.countEl.textContent = '0 / 0'
      return
    }
    const { matches, current } = getSearchState(view)
    const at = current >= 0 ? current + 1 : 0
    this.countEl.textContent = `${at} / ${matches.length}`
  }

  private handleFindKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      const view = this.getView()
      if (view && searchNext(view, event.shiftKey ? -1 : 1)) this.updateCounter()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    }
  }

  private replaceOne(): void {
    const view = this.getView()
    if (!view) return
    if (replaceSearchCurrent(view, this.replaceInput!.value)) this.updateCounter()
  }
}