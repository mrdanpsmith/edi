import type { EditorView } from 'prosemirror-view'
import { Slice, Fragment } from 'prosemirror-model'
import type { Node as ProseNode, Schema } from 'prosemirror-model'

const URL_TOKEN = /^(https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s]+$/i
const NEWLINE_RE = /\r\n?/g

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

function linkifiedInline(line: string, schema: Schema): ProseNode[] {
  const linkType = schema.marks.link
  const inline: ProseNode[] = []
  for (const part of line.split(/(\s+)/)) {
    if (part === '') continue
    if (isRawUrl(part)) {
      inline.push(schema.text(part, [linkType.create({ href: hrefForUrl(part), title: null })]))
    } else {
      inline.push(schema.text(part))
    }
  }
  return inline
}

/**
 * Insert pasted text, automatically wrapping any raw URL tokens in a link mark
 * so pasting e.g. `https://example.com` becomes a clickable link. Non-URL
 * tokens (words, spaces) are preserved as plain text. Newlines split the paste
 * across real paragraphs rather than embedding literal newlines in one block.
 */
export function insertPastedText(view: EditorView, text: string): void {
  const schema = view.state.schema
  const normalized = text.replace(NEWLINE_RE, '\n')
  if (normalized.trim() === '') return

  const paragraphs = normalized.split('\n').map((line) =>
    schema.nodes.paragraph.create(null, linkifiedInline(line, schema)),
  )

  // Open depth 1 lets a single-line paste merge back into the surrounding
  // paragraph, while multi-line pastes become separate blocks (the built-in
  // plain-text paste behavior we want).
  const slice = new Slice(Fragment.fromArray(paragraphs), 1, 1)
  view.dispatch(view.state.tr.replaceSelection(slice))
}
