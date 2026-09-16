// Shared pipe-table utilities for the spreadsheet table atom. The `table` node
// stores its whole grid as the attribute `value` (pipe-table markdown, mermaid
// style); this module converts between that text and the 2-D string grid the
// solver and the visual grid node-view work on.
import { renderCellHtml } from './inline-md'

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

const MASKED_TOKEN = /!masked\[([^\]\n]*)\](?:\{label="((?:[^"\\]|\\.)*)"\})?/g

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
 * Tiny, safe renderer for the inline markdown a spreadsheet cell can hold.
 * Cells are parsed with the same micromark pipeline as the document editor, so
 * every CommonMark construct (including combined marks like `***bold***` or
 * `` **bold `code`** ``) renders correctly; everything else is HTML-escaped
 * text. When ``opts.indexedMasked`` is set, mask pills get a `data-edi-masked`
 * index so the grid can attach interactivity.
 */
export function inlineMarkdownToHtml(
  text: string,
  opts?: { indexedMasked?: boolean },
): string {
  return renderCellHtml(text, opts?.indexedMasked ?? false)
}