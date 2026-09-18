/**
 * Function-name autocomplete for the spreadsheet's fx bar and in-cell editor.
 *
 * Shows a compact dropdown list (Google-Sheets style) anchored under the
 * editor:
 *
 * - up to {@link MAX_SUGGESTIONS} matches, rendered as bare function names,
 *   with the selected row expanded to show its signature and description;
 * - ArrowUp/ArrowDown cycle, mouse hover selects, click inserts;
 * - an (×) button in the top-right corner dismisses the list.
 *
 * The list takes pointer events so rows can be hovered and clicked, but it
 * swallows `mousedown` so interacting with it never blurs (and thus commits)
 * the editor that opened it.
 */
import { type FormulaFunction } from './formulas'
import { isFormula } from './spreadsheet'

const IDENTIFIER = /([A-Za-z][A-Za-z0-9_]*)$/
const MAX_SUGGESTIONS = 10

export interface AutocompleteToken {
  text: string
  start: number
  end: number
}

/** The function-name identifier being typed at the caret, or null elsewhere.
 * An empty token (`=`, `(`, `,` with nothing typed yet) yields null so the list
 * only appears once at least one character of a name is present. */
export function functionToken(value: string, caret: number): AutocompleteToken | null {
  const before = value.slice(0, caret)
  const match = IDENTIFIER.exec(before)
  if (!match) return null
  const text = match[1]!
  const start = caret - text.length
  const preceding = start > 0 ? value[start - 1]! : ''
  if (/[A-Za-z0-9_.$]/.test(preceding)) {
    return null
  }
  return { text, start, end: caret }
}

/** Functions matching `query` case-insensitively, best match first. The search
 * is a contains match over the canonical name, aliases, and description; name
 * matches outrank description-only matches so a typed prefix stays on top. */
export function matchFunctions(
  functions: readonly FormulaFunction[],
  query: string,
): FormulaFunction[] {
  const needle = query.toUpperCase()
  return functions
    .map((fn, order) => ({ fn, order, score: matchScore(fn, needle) }))
    .filter((entry): entry is { fn: FormulaFunction; order: number; score: number } =>
      entry.score !== null,
    )
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.fn)
}

function matchScore(fn: FormulaFunction, needle: string): number | null {
  const names = [fn.name, ...(fn.aliases ?? [])].map((name) => name.toUpperCase())
  if (names.some((name) => name.startsWith(needle))) return 0
  if (names.some((name) => name.includes(needle))) return 1
  if (fn.summary.toUpperCase().includes(needle)) return 2
  return null
}

export class FormulaAutocomplete {
  private listEl: HTMLDivElement | null = null
  private itemsEl: HTMLDivElement | null = null
  private matches: FormulaFunction[] = []
  private activeIndex = 0
  private input: HTMLInputElement | null = null
  private token: AutocompleteToken | null = null
  private tokenText = ''

  constructor(private readonly getFunctions: () => readonly FormulaFunction[]) {}

  /** Show, update, or hide the suggestions for the token at the input's caret. */
  refresh(input: HTMLInputElement): void {
    if (!isFormula(input.value.trim())) {
      this.close()
      return
    }
    const caret = input.selectionStart ?? input.value.length
    const token = functionToken(input.value, caret)
    if (!token) {
      this.close()
      return
    }
    const matches = matchFunctions(this.getFunctions(), token.text).slice(0, MAX_SUGGESTIONS)
    if (matches.length === 0) {
      this.close()
      return
    }
    this.input = input
    this.token = token
    this.matches = matches
    // A longer (or changed) prefix should start at the best match again rather
    // than keep the position the user arrowed to for the previous token.
    if (token.text !== this.tokenText) {
      this.tokenText = token.text
      this.activeIndex = 0
    } else if (this.activeIndex >= matches.length) {
      this.activeIndex = 0
    }
    this.render()
  }

  /** Handle a keydown. Returns true when the list consumed the key. */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.listEl) return false
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      this.activeIndex = (this.activeIndex + 1) % this.matches.length
      this.render()
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      this.activeIndex = (this.activeIndex - 1 + this.matches.length) % this.matches.length
      this.render()
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      this.accept(this.matches[this.activeIndex]!)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
      return true
    }
    return false
  }

  close(): void {
    this.listEl?.remove()
    this.listEl = null
    this.itemsEl = null
    this.matches = []
    this.activeIndex = 0
    this.input = null
    this.token = null
    this.tokenText = ''
  }

  private buildList(): void {
    const list = document.createElement('div')
    list.className = 'ss-ac-list'
    list.setAttribute('role', 'listbox')

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ss-ac-close'
    close.setAttribute('aria-label', 'Dismiss suggestions')
    close.textContent = '×'

    const items = document.createElement('div')
    items.className = 'ss-ac-items'

    list.append(close, items)
    // Keep focus (and the uncommitted edit) in the owning input.
    list.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    list.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.ss-ac-close')) {
        this.close()
        return
      }
      const item = target?.closest('.ss-ac-item') as HTMLElement | null
      const index = item ? Number(item.dataset.index) : NaN
      const fn = Number.isInteger(index) ? this.matches[index] : undefined
      if (fn) this.accept(fn)
    })
    list.addEventListener('mouseover', (event) => {
      const target = event.target instanceof Element ? event.target : null
      const item = target?.closest('.ss-ac-item') as HTMLElement | null
      if (!item) return
      const index = Number(item.dataset.index)
      if (Number.isInteger(index) && index !== this.activeIndex) {
        this.activeIndex = index
        this.render()
      }
    })

    document.body.appendChild(list)
    this.listEl = list
    this.itemsEl = items
  }

  private render(): void {
    const input = this.input
    if (!input) return
    if (!this.listEl) this.buildList()
    const items = this.itemsEl!
    items.textContent = ''
    this.matches.forEach((fn, index) => {
      const selected = index === this.activeIndex
      const item = document.createElement('div')
      item.className = selected ? 'ss-ac-item is-selected' : 'ss-ac-item'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(selected))
      item.dataset.index = String(index)
      const name = document.createElement('span')
      name.className = 'ss-ac-item-name'
      name.textContent = fn.name
      item.appendChild(name)
      if (selected) {
        const detail = document.createElement('div')
        detail.className = 'ss-ac-item-detail'
        const signature = document.createElement('span')
        signature.className = 'ss-ac-item-signature'
        signature.textContent = fn.signature
        const summary = document.createElement('span')
        summary.className = 'ss-ac-item-summary'
        summary.textContent = fn.summary
        detail.append(signature, summary)
        item.appendChild(detail)
      }
      items.appendChild(item)
      if (selected) item.scrollIntoView?.({ block: 'nearest' })
    })
    const rect = input.getBoundingClientRect()
    this.listEl!.style.left = `${Math.round(rect.left)}px`
    this.listEl!.style.top = `${Math.round(rect.bottom + 2)}px`
    this.listEl!.style.minWidth = `${Math.max(200, Math.round(rect.width))}px`
    this.listEl!.style.maxWidth = `${Math.round(Math.min(440, window.innerWidth - rect.left - 8))}px`
  }

  private accept(fn: FormulaFunction): void {
    const input = this.input
    const token = this.token
    if (!input || !token) return
    const insert = `${fn.name}()`
    const next = input.value.slice(0, token.start) + insert + input.value.slice(token.end)
    input.value = next
    const caret = token.start + fn.name.length + 1
    input.setSelectionRange(caret, caret)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    this.close()
  }
}
