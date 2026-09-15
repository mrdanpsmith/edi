// Shared pipe-table utilities for the spreadsheet table atom. The `table` node
// stores its whole grid as the attribute `value` (pipe-table markdown, mermaid
// style); this module converts between that text and the 2-D string grid the
// solver and the visual grid node-view work on.

const DELIMITER_CELL = /^:?-+:?$/

function splitRow(line: string): string[] {
  // Split on `|` unless it is escaped (`\|`). Backslashes are kept verbatim so
  // a round-trip preserves them.
  const cells: string[] = []
  let buf = ''
  let prev = ''
  for (const ch of line) {
    if (ch === '|' && prev !== '\\') {
      cells.push(buf)
      buf = ''
    } else {
      buf += ch
    }
    prev = ch
  }
  cells.push(buf)
  return cells
}

function trimOuterPipes(line: string): string {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s
}

function unescapeCell(cell: string): string {
  return cell.replace(/\\\|/g, '|').trim()
}

/**
 * Parse normalized pipe-table markdown (`| a | b |` lines with the GFM `| --- |`
 * delimiter after the header row) into a 2-D grid of raw cell text. The header
 * row is index 0; the delimiter row is dropped; ragged rows are padded with
 * `''` to the widest row.
 */
export function parsePipes(value: string): string[][] {
  const rows: string[][] = []
  for (const line of value.split('\n')) {
    if (line.trim() === '') continue
    const cells = splitRow(trimOuterPipes(line)).map(unescapeCell)
    // Drop the GFM delimiter row (`| --- |`, `| :---: |`, …). Any row whose
    // every cell is dash-shaped is an alignment row, never data.
    if (cells.every((cell) => DELIMITER_CELL.test(cell))) continue
    rows.push(cells)
  }
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  for (const row of rows) {
    while (row.length < maxCols) row.push('')
  }
  return rows
}

/**
 * Re-emit a 2-D grid as normalized pipe-table markdown: a delimiter row after
 * the header (row 0), pipes escaped (`|` → `\|`), ragged rows padded with `''`.
 */
export function tableToPipes(rows: string[][]): string {
  if (rows.length === 0) return ''
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const formatRow = (cells: readonly string[]): string => {
    const padded = [...cells]
    while (padded.length < maxCols) padded.push('')
    return `| ${padded.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`
  }
  const lines = [formatRow(rows[0]!)]
  if (rows.length > 1) {
    lines.push(`| ${Array.from({ length: maxCols }, () => '---').join(' | ')} |`)
  }
  for (const row of rows.slice(1)) lines.push(formatRow(row))
  return lines.join('\n')
}

/**
 * Read an HTML `<table>` (as pasted from a real page/app) into pipe-table
 * markdown. Cell text is trimmed like every other parse path.
 */
export function domTableToPipes(dom: HTMLTableElement): string {
  const rows: string[][] = []
  for (const tr of Array.from(dom.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children).filter(
      (child): child is HTMLTableCellElement =>
        child.tagName === 'TD' || child.tagName === 'TH',
    )
    if (cells.length === 0) continue
    rows.push(cells.map((cell) => (cell.textContent ?? '').trim()))
  }
  return tableToPipes(rows)
}

function escapeCellHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

type InlineKind = 'strong' | 'em' | 'code' | 'del' | 'link'

const MASKED_TOKEN = /!masked\[([^\]\n]*)\](?:\{label="((?:[^"\\]|\\.)*)"\})?/g
const MASKED_BULLETS = '••••••••••••'

export interface MaskedToken {
  content: string
  label: string
  raw: string
}

/** List every ``!masked[…]`` token in a cell's raw text, in order, with the
 * quote-unescaped label and the original token text (for round-trip editing). */
export function listMaskedTokens(text: string): MaskedToken[] {
  const out: MaskedToken[] = []
  for (const match of text.matchAll(new RegExp(MASKED_TOKEN.source, 'g'))) {
    out.push({
      content: match[1] ?? '',
      label: (match[2] ?? '').replace(/\\(.)/g, '$1'),
      raw: match[0],
    })
  }
  return out
}

/**
 * Replace ``!masked[cipher]{label="…"}`` tokens with a static masked pill so
 * cells can display encrypted fields. Returns fully HTML-escaped text (safe to
 * feed to `renderInline`): literal text is escaped, the pill markup is ours.
 * When ``indexed`` is set, each pill carries a `data-edi-masked` index matching
 * `listMaskedTokens(text)` so the grid can wire per-token interactions.
 */
function renderMaskedSpans(raw: string, indexed: boolean): string {
  let out = ''
  let last = 0
  let index = 0
  for (const match of raw.matchAll(new RegExp(MASKED_TOKEN.source, 'g'))) {
    out += escapeCellHtml(raw.slice(last, match.index))
    const label = (match[2] ?? '').replace(/\\(.)/g, '$1').replace(/[\\`*_{}[\]]~/g, '')
    const suffix = label ? ` (${escapeCellHtml(label)})` : ''
    const attr = indexed ? ` data-edi-masked="${index}"` : ''
    out += `<span class="masked-field"${attr}>${MASKED_BULLETS}${suffix}</span>`
    last = match.index + match[0].length
    index++
  }
  out += escapeCellHtml(raw.slice(last))
  return out
}

/**
 * Tiny, safe renderer for the inline markdown a spreadsheet cell can hold:
 * `**b**`/`__b__` → strong, `*i*`/`_i_` → em, `` `c` `` → code, `~~d~~` → del,
 * `[t](u)` → link, `!masked[…]` → a masked pill. Everything else (including
 * sub/sup/highlight markers) is HTML-escaped text. Input is never trusted as
 * HTML. When ``opts.indexedMasked`` is set, mask pills get a `data-edi-masked`
 * index so the grid can attach interactivity.
 */
export function inlineMarkdownToHtml(
  text: string,
  opts?: { indexedMasked?: boolean },
): string {
  return renderInline(renderMaskedSpans(text, opts?.indexedMasked ?? false))
}

function renderInline(escaped: string): string {
  interface Candidate {
    index: number
    match: RegExpExecArray
    kind: InlineKind
  }
  const patterns: Array<{ re: RegExp; kind: InlineKind }> = [
    { re: /\*\*([^*]+?)\*\*/, kind: 'strong' },
    { re: /__([^_]+?)__/, kind: 'strong' },
    { re: /(?<!\*)\*([^*]+)\*(?!\*)/, kind: 'em' },
    { re: /(?<!_)_([^_]+)_(?!_)/, kind: 'em' },
    { re: /~~([^~]+?)~~/, kind: 'del' },
    { re: /`([^`]+)`/, kind: 'code' },
    { re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*"?)?\)/, kind: 'link' },
  ]
  let out = ''
  let rest = escaped
  while (rest.length > 0) {
    let best: Candidate | null = null
    for (const { re, kind } of patterns) {
      const match = re.exec(rest)
      if (match && (!best || match.index < best.index)) {
        best = { index: match.index, match, kind }
      }
    }
    if (!best) {
      out += rest
      break
    }
    out += rest.slice(0, best.index)
    const { match, kind } = best
    if (kind === 'link') {
      const label = renderInline(match[1]!)
      out += `<a href="${match[2]!}">${label}</a>`
    } else {
      // Code spans are literal — never recurse into their content.
      const inner = kind === 'code' ? match[1]! : renderInline(match[1]!)
      const tag = kind === 'strong' ? 'strong' : kind === 'em' ? 'em' : kind === 'del' ? 'del' : 'code'
      out += `<${tag}>${inner}</${tag}>`
    }
    rest = rest.slice(best.index + match[0].length)
  }
  return out
}