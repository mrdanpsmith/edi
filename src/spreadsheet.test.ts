import { describe, expect, it } from 'vitest'

import { computeSpreadsheet, formatNumber } from './spreadsheet'

function renderTable(markdown: string): string {
  const lines = markdown.split('\n')
  const rows: string[][] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim())
    if (cells.every((c) => /^-+$/.test(c))) continue
    rows.push(cells)
  }
  if (rows.length === 0) return ''
  let html = '<table>'
  for (let i = 0; i < rows.length; i++) {
    const tag = i === 0 ? 'th' : 'td'
    html += '<tr>'
    for (const cell of rows[i]!) {
      html += `<${tag}>${cell}</${tag}>`
    }
    html += '</tr>'
  }
  html += '</table>'
  return html
}

function compute(markdown: string): string {
  const container = document.createElement('div')
  container.innerHTML = renderTable(markdown)
  computeSpreadsheet(container)
  return container.innerHTML
}

function cellText(html: string, index: number): string {
  const cells = html.match(/<td[^>]*>.*?<\/td>/g) ?? []
  return cells[index] ?? ''
}

describe('formatNumber', () => {
  it('rounds to four decimals and drops trailing zeros', () => {
    expect(formatNumber(1 / 3)).toBe('0.3333')
    expect(formatNumber(10)).toBe('10')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
  })

  it('flags non-finite values', () => {
    expect(formatNumber(Number.NaN)).toBe('#VALUE!')
  })
})

describe('computeSpreadsheet', () => {
  it('sums a horizontal range', () => {
    const html = compute(
      '| Item | Q1 | Q2 | Total |\n| --- | --- | --- | --- |\n| A | 10 | 20 | =SUM(B2:C2) |',
    )
    expect(cellText(html, 3)).toContain('spreadsheet-formula')
    expect(cellText(html, 3)).toContain('>30<')
  })

  it('supports arithmetic and cell references', () => {
    const html = compute('| A | B |\n| --- | --- |\n| 10 | 20 |\n| 5 | 7 |\n| =B2*2 | =A3+B3 |')
    expect(cellText(html, 4)).toContain('>40<')
    expect(cellText(html, 5)).toContain('>12<')
  })

  it('treats blank cells as zero in arithmetic', () => {
    const html = compute('| A | B |\n| --- | --- |\n| | =A2+5 |')
    expect(cellText(html, 1)).toContain('>5<')
  })

  it('evaluates ranges across rows and columns', () => {
    const html = compute(
      '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| =SUM(A2:C3) | =AVERAGE(A2:B3) | =COUNT(A2:C3) |',
    )
    expect(cellText(html, 6)).toContain('>21<')
    expect(cellText(html, 7)).toContain('>3<')
    expect(cellText(html, 8)).toContain('>6<')
  })

  it('ignores non-numeric cells inside aggregate functions', () => {
    const html = compute('| A | B |\n| --- | --- |\n| text | 5 |\n| =SUM(A2:B2) | =AVERAGE(A2:B2) |')
    expect(cellText(html, 2)).toContain('>5<')
    expect(cellText(html, 3)).toContain('>5<')
  })

  it('reports division by zero', () => {
    const html = compute('| A |\n| --- |\n| 0 |\n| =5/A2 |')
    expect(cellText(html, 1)).toContain('>#DIV/0!<')
  })

  it('reports value errors for text in arithmetic', () => {
    const html = compute('| A | B |\n| --- | --- |\n| abc | =A2+1 |')
    expect(cellText(html, 1)).toContain('#VALUE!')
  })

  it('reports unknown function names', () => {
    const html = compute('| A |\n| --- |\n| 1 |\n| =FOO(A2) |')
    expect(cellText(html, 1)).toContain('#NAME?')
  })

  it('reports empty formulas', () => {
    const html = compute('| A |\n| --- |\n| = |')
    expect(cellText(html, 0)).toContain('#ERROR!')
  })

  it('detects circular references', () => {
    const html = compute('| A | B |\n| --- | --- |\n| =B2 | =A2 |')
    expect(cellText(html, 0)).toContain('#CYCLE!')
    expect(cellText(html, 1)).toContain('#CYCLE!')
  })

  it('detects self references', () => {
    const html = compute('| A |\n| --- |\n| =A2 |')
    expect(cellText(html, 0)).toContain('#CYCLE!')
  })

  it('computes chained formulas', () => {
    const html = compute('| A | B |\n| --- | --- |\n| 2 | =A2*3 |\n| =B2+1 | =A3*2 |')
    expect(cellText(html, 1)).toContain('>6<')
    expect(cellText(html, 2)).toContain('>7<')
    expect(cellText(html, 3)).toContain('>14<')
  })

  it('supports MIN, MAX, PRODUCT, and exponentiation', () => {
    const html = compute(
      '| A | B | C |\n| --- | --- | --- |\n| 2 | 8 | 4 |\n| =MIN(A2:C2) | =MAX(A2:C2) | =2^A2 |',
    )
    expect(cellText(html, 3)).toContain('>2<')
    expect(cellText(html, 4)).toContain('>8<')
    expect(cellText(html, 5)).toContain('>4<')
  })

  it('supports ROUND', () => {
    const html = compute('| A | B |\n| --- | --- |\n| 10 | 3 |\n| =ROUND(A2/B2, 2) |')
    expect(cellText(html, 2)).toContain('>3.33<')
  })

  it('uses the header row as row 1', () => {
    const html = compute('| Item | Value |\n| --- | --- |\n| x | 7 |\n| =B2*2 |')
    expect(cellText(html, 2)).toContain('>14<')
  })

  it('leaves non-formula tables untouched', () => {
    const html = compute('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<td>1</td>')
    expect(html).toContain('<td>2</td>')
  })
})
