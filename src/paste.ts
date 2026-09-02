import type { EditorView } from 'prosemirror-view'
import { Fragment } from 'prosemirror-model'
import type { Node as ProseNode } from 'prosemirror-model'

const URL_TOKEN = /^(https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s]+$/i

export function isRawUrl(text: string): boolean {
  return URL_TOKEN.test(text.trim())
}

export function containsRawUrl(text: string): boolean {
  return text.split(/\s+/).some((token) => isRawUrl(token))
}

export function hrefForUrl(text: string): string {
  const trimmed = text.trim()
  return /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed
}

/**
 * Insert pasted text, automatically wrapping any raw URL tokens in a link mark
 * so pasting e.g. `https://example.com` becomes a clickable link. Non-URL
 * tokens (words, spaces, newlines) are preserved as plain text.
 */
export function insertPastedText(view: EditorView, text: string): void {
  const schema = view.state.schema
  const linkType = schema.marks.link
  const nodes: ProseNode[] = []
  for (const part of text.split(/(\s+)/)) {
    if (part === '') continue
    if (isRawUrl(part)) {
      nodes.push(schema.text(part, [linkType.create({ href: hrefForUrl(part), title: null })]))
    } else {
      nodes.push(schema.text(part))
    }
  }
  if (nodes.length === 0) return
  const tr = view.state.tr.replaceWith(
    view.state.selection.from,
    view.state.selection.to,
    Fragment.fromArray(nodes),
  )
  view.dispatch(tr)
}
