/**
 * `:` emoji autocomplete for the body editor, the table cells and (via
 * `createBlockCodeMirror`) the block source editor.
 *
 * The ProseMirror plugin owns no DOM of its own beyond the suggestion card: it
 * tracks the token at the caret in plugin state, and the card is rendered and
 * torn down from the plugin's `view`. A plain `<input>` (the fx bar and the
 * in-cell editor) uses {@link EmojiAutocomplete}, which shares the same card
 * and key handling.
 */
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { closeHistory } from 'prosemirror-history'
import { EMOJI_ENTRIES, matchEmoji, type EmojiEntry } from './emoji'
import { emojiTokenAt, type EmojiToken } from './emojiToken'

const MAX_SUGGESTIONS = 10

interface EmojiMeta {
  active?: number
  close?: boolean
}

export interface EmojiPluginState {
  token: EmojiToken | null
  open: boolean
  active: number
}

const EMPTY: EmojiPluginState = { token: null, open: false, active: 0 }

export const EMOJI_PLUGIN_KEY = new PluginKey<EmojiPluginState>('EDI_EMOJI')

interface Anchor {
  left: number
  bottom: number
  width?: number
}

/**
 * The suggestion card. It is the same DOM for all three surfaces: up to ten
 * `emoji  name` rows, a highlighted active row, pointer interaction that never
 * blurs the surface that opened it.
 */
class EmojiSuggest {
  private listEl: HTMLDivElement | null = null
  private itemsEl: HTMLDivElement | null = null
  private matches: EmojiEntry[] = []
  private active = 0
  private onAccept: ((entry: EmojiEntry) => void) | null = null

  get isOpen(): boolean {
    return this.listEl !== null
  }

  show(anchor: Anchor, matches: EmojiEntry[], active: number, onAccept: (entry: EmojiEntry) => void): void {
    this.matches = matches
    this.active = matches.length ? ((active % matches.length) + matches.length) % matches.length : 0
    this.onAccept = onAccept
    if (!this.listEl) this.build()
    this.render()
    const el = this.listEl!
    el.style.left = `${Math.round(anchor.left)}px`
    el.style.top = `${Math.round(anchor.bottom + 2)}px`
    el.style.minWidth = `${Math.max(160, Math.round(anchor.width ?? 0))}px`
  }

  close(): void {
    this.listEl?.remove()
    this.listEl = null
    this.itemsEl = null
    this.matches = []
    this.active = 0
    this.onAccept = null
  }

  /** Handle a keydown. Returns true when the open card consumed the key. */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.listEl || this.matches.length === 0) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      this.active = (this.active + delta + this.matches.length) % this.matches.length
      this.render()
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      this.acceptActive()
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
      return true
    }
    return false
  }

  private acceptActive(): void {
    const entry = this.matches[this.active]
    if (entry) this.onAccept?.(entry)
  }

  private build(): void {
    const list = document.createElement('div')
    list.className = 'emoji-suggest'
    list.setAttribute('role', 'listbox')
    const items = document.createElement('div')
    items.className = 'emoji-suggest-items'
    list.appendChild(items)
    // Keep focus — and the uncommitted edit — in the surface that opened it.
    list.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    list.addEventListener('click', (event) => {
      const row = closestRow(event.target)
      const index = row ? Number(row.dataset.index) : NaN
      if (Number.isInteger(index)) {
        this.active = index
        this.acceptActive()
      }
    })
    list.addEventListener('mouseover', (event) => {
      const row = closestRow(event.target)
      const index = row ? Number(row.dataset.index) : NaN
      if (Number.isInteger(index) && index !== this.active) {
        this.active = index
        this.render()
      }
    })
    document.body.appendChild(list)
    this.listEl = list
    this.itemsEl = items
  }

  private render(): void {
    const items = this.itemsEl
    if (!items) return
    items.textContent = ''
    this.matches.forEach((entry, index) => {
      const selected = index === this.active
      const row = document.createElement('div')
      row.className = selected ? 'emoji-row is-selected' : 'emoji-row'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(selected))
      row.dataset.index = String(index)
      const glyph = document.createElement('span')
      glyph.className = 'emoji-row-glyph'
      glyph.textContent = entry.emoji
      const name = document.createElement('span')
      name.className = 'emoji-row-name'
      name.textContent = `:${entry.name}:`
      row.append(glyph, name)
      items.appendChild(row)
      if (selected) row.scrollIntoView?.({ block: 'nearest' })
    })
  }
}

function closestRow(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? (target.closest('.emoji-row') as HTMLElement | null) : null
}

/** Caret coordinates, or a zero anchor where the platform has no layout (jsdom). */
function caretAnchor(view: EditorView): Anchor {
  try {
    const coords = view.coordsAtPos(view.state.selection.from)
    if (coords) return { left: coords.left, bottom: coords.bottom }
  } catch {
    // jsdom has no layout: `coordsAtPos` throws. Fall through to the zero
    // anchor so the plugin still works (the tests only care about the list).
  }
  return { left: 0, bottom: 0 }
}

/** The token ending at the caret when it sits in a textblock, else null. */
function emojiTokenInState(state: EditorState): EmojiToken | null {
  const sel = state.selection
  if (!(sel instanceof TextSelection) || !sel.empty) return null
  const $from = sel.$from
  if (!$from.parent.isTextblock) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, () => '\ufffc')
  return emojiTokenAt(before, before.length)
}

function acceptEmoji(view: EditorView, entry: EmojiEntry): void {
  const pluginState = EMOJI_PLUGIN_KEY.getState(view.state)
  const sel = view.state.selection
  if (!pluginState?.token || !(sel instanceof TextSelection) || !sel.empty) return
  const from = sel.$from.start() + pluginState.token.from
  const to = sel.$from.start() + pluginState.token.to
  // One transaction, and a history break so the accepted glyph is its own undo
  // step — one undo restores the whole `:query` run.
  view.dispatch(closeHistory(view.state.tr.insertText(entry.emoji, from, to)))
  view.focus()
}

export function emojiPlugin(): Plugin<EmojiPluginState> {
  return new Plugin<EmojiPluginState>({
    key: EMOJI_PLUGIN_KEY,
    state: {
      init: () => EMPTY,
      apply(tr, prev, _old, newState) {
        const meta = tr.getMeta(EMOJI_PLUGIN_KEY) as EmojiMeta | undefined
        if (meta?.active !== undefined) return { ...prev, active: meta.active }
        if (meta?.close) return { ...prev, open: false }
        const token = emojiTokenInState(newState)
        if (!token) return EMPTY
        const changed =
          !prev.token || prev.token.from !== token.from || prev.token.query !== token.query
        if (changed) return { token, open: true, active: 0 }
        return { token, open: prev.open, active: prev.active }
      },
    },
    props: {
      handleKeyDown(view, event) {
        const pluginState = EMOJI_PLUGIN_KEY.getState(view.state)
        if (!pluginState?.open || !pluginState.token) return false
        const matches = matchEmoji(EMOJI_ENTRIES, pluginState.token.query, MAX_SUGGESTIONS)
        if (matches.length === 0) return false
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const delta = event.key === 'ArrowDown' ? 1 : -1
          const active = (pluginState.active + delta + matches.length) % matches.length
          view.dispatch(view.state.tr.setMeta(EMOJI_PLUGIN_KEY, { active }))
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          acceptEmoji(view, matches[Math.min(pluginState.active, matches.length - 1)]!)
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          view.dispatch(view.state.tr.setMeta(EMOJI_PLUGIN_KEY, { close: true }))
          return true
        }
        return false
      },
      handleDOMEvents: {
        blur(view) {
          view.dispatch(view.state.tr.setMeta(EMOJI_PLUGIN_KEY, { close: true }))
          return false
        },
      },
    },
    view() {
      const suggest = new EmojiSuggest()
      return {
        update(view) {
          const pluginState = EMOJI_PLUGIN_KEY.getState(view.state)
          if (!pluginState?.open || !pluginState.token) {
            suggest.close()
            return
          }
          const matches = matchEmoji(EMOJI_ENTRIES, pluginState.token.query, MAX_SUGGESTIONS)
          if (matches.length === 0) {
            suggest.close()
            return
          }
          suggest.show(caretAnchor(view), matches, pluginState.active, (entry) =>
            acceptEmoji(view, entry),
          )
        },
        destroy() {
          suggest.close()
        },
      }
    },
  })
}

/**
 * The same card for a plain `<input>` (the spreadsheet fx bar and the in-cell
 * editor). `refresh` re-reads the token at the input's caret; the owning input
 * forwards its keydowns so the open card owns Enter/Tab/Esc.
 */
export class EmojiAutocomplete {
  private readonly suggest = new EmojiSuggest()
  private input: HTMLInputElement | null = null
  private token: EmojiToken | null = null

  get isOpen(): boolean {
    return this.suggest.isOpen
  }

  refresh(input: HTMLInputElement): void {
    const caret = input.selectionStart ?? input.value.length
    const token = emojiTokenAt(input.value.slice(0, caret), caret)
    if (!token) {
      this.close()
      return
    }
    const matches = matchEmoji(EMOJI_ENTRIES, token.query, MAX_SUGGESTIONS)
    if (matches.length === 0) {
      this.close()
      return
    }
    this.input = input
    this.token = token
    const rect = input.getBoundingClientRect()
    this.suggest.show({ left: rect.left, bottom: rect.bottom, width: rect.width }, matches, 0, (entry) =>
      this.accept(entry),
    )
  }

  handleKeydown(event: KeyboardEvent): boolean {
    return this.suggest.handleKeydown(event)
  }

  close(): void {
    this.suggest.close()
    this.input = null
    this.token = null
  }

  private accept(entry: EmojiEntry): void {
    const input = this.input
    const token = this.token
    if (!input || !token) return
    input.value = input.value.slice(0, token.from) + entry.emoji + input.value.slice(token.to)
    const caret = token.from + entry.emoji.length
    input.setSelectionRange(caret, caret)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    this.close()
  }
}
