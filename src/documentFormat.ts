import { codeFence } from './markdown'
import { fileExtension } from './files'

/**
 * What a file on disk holds, as distinct from the markdown the editor works on.
 *
 * A markdown file is the editor's markdown, byte for byte. A Mermaid file
 * (`.mmd`, `.mermaid`) is bare diagram source, which other Mermaid tools read
 * and which must not grow a fence. The editor still sees it as markdown: one
 * fenced `mermaid` block, so it renders and edits like any other diagram.
 *
 * Every place a file's text becomes the editor's markdown, or the other way
 * round, goes through `fileTextToMarkdown` / `markdownToFileText`. See
 * docs/mermaid.md, "Mermaid files".
 */
export type DocumentFormat = 'markdown' | 'mermaid'

const MERMAID_EXTENSIONS = new Set(['mmd', 'mermaid'])

export function documentFormat(path: string | null | undefined): DocumentFormat {
  return path && MERMAID_EXTENSIONS.has(fileExtension(path)) ? 'mermaid' : 'markdown'
}

/**
 * The editor's markdown for `text` read from `path`.
 *
 * A Mermaid file becomes one fenced block. Whether the file ends in a newline
 * is carried by what follows the closing fence, which the editor's source
 * record keeps, so an unedited diagram writes back exactly as it was read.
 */
export function fileTextToMarkdown(path: string | null | undefined, text: string): string {
  if (documentFormat(path) !== 'mermaid') return text
  const endsWithNewline = text.endsWith('\n')
  const body = endsWithNewline ? text.slice(0, -1) : text
  const fence = codeFence(body)
  return `${fence}mermaid\n${body}\n${fence}${endsWithNewline ? '\n' : ''}`
}

/**
 * The file text that writes `markdown` to `path`, or `null` when the file's
 * format cannot hold it: a Mermaid file holds exactly one diagram, so a
 * document that is anything more (or less) has no Mermaid spelling.
 *
 * Blank lines around the diagram are allowed, because the editor keeps an
 * empty paragraph after a trailing block and a reader may leave one.
 */
export function markdownToFileText(path: string | null | undefined, markdown: string): string | null {
  if (documentFormat(path) !== 'mermaid') return markdown
  return singleDiagramSource(markdown)
}

/** The file text for `markdown`, or the markdown itself where there is none (for display). */
export function fileTextForDisplay(path: string | null | undefined, markdown: string): string {
  return markdownToFileText(path, markdown) ?? markdown
}

/**
 * The source of the one Mermaid diagram that is all of `markdown`, followed by
 * a newline if anything (blank) follows its closing fence; `null` if
 * `markdown` is not a single fenced `mermaid` block.
 */
export function singleDiagramSource(markdown: string): string | null {
  const lines = markdown.split('\n')
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  const open = /^(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/.exec(lines[start] ?? '')
  if (!open) return null
  const marker = open[1]
  const closes = (line: string): boolean => {
    const trimmed = line.trim()
    return trimmed.length >= marker.length && trimmed === marker[0].repeat(trimmed.length)
  }
  let end = start + 1
  while (end < lines.length && !closes(lines[end])) end += 1
  if (end >= lines.length) return null
  const after = lines.slice(end + 1)
  if (after.some((line) => line.trim() !== '')) return null
  const body = lines.slice(start + 1, end).join('\n')
  return after.length > 0 ? `${body}\n` : body
}
