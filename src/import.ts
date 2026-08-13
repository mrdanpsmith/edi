import { invoke } from './bridge'

export interface ParsedTable {
  name: string
  rows: string[][]
}

export function toMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) {
    return ''
  }
  const escapeCell = (cell: string): string =>
    cell.replace(/[|\\\n]/g, (char) => (char === '\n' ? '<br>' : `\\${char}`))
  const formatRow = (row: string[]): string => `| ${row.map(escapeCell).join(' | ')} |`
  const header = rows[0]!
  const lines = [formatRow(header), `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of rows.slice(1)) {
    lines.push(formatRow(row))
  }
  return lines.join('\n')
}

export async function parseTableFile(path: string): Promise<ParsedTable> {
  return invoke<ParsedTable>('parseTableFile', { path })
}
