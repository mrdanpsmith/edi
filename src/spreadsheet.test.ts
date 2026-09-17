import { describe, expect, it } from 'vitest'

import {
  colToLetters,
  computeSpreadsheet,
  formatNumber,
  parseCellRef,
  solve,
} from './spreadsheet'
import {
  domTableToPipes,
  parsePipesAlign,
  inlineMarkdownToHtml,
  parsePipes,
  tableToPipes,
} from './spreadsheet-util'

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

describe('solve', () => {
  function cells(markdown: string): string[][] {
    const solution = solve(parsePipes(markdown))
    return solution.cells.map((row) => row.map((cell) => cell.display))
  }

  function kinds(markdown: string): string[][] {
    const solution = solve(parsePipes(markdown))
    return solution.cells.map((row) => row.map((cell) => cell.kind))
  }

  it('solves a horizontal sum', () => {
    const out = cells('| Item | Q1 | Q2 | Total |\n| --- | --- | --- | --- |\n| A | 10 | 20 | =SUM(B2:C2) |')
    expect(out[1]![3]).toBe('30')
  })

  it('evaluates arithmetic, references, blanks, and chained formulas', () => {
    const out = cells('| A | B |\n| --- | --- |\n| | =A2+5 |')
    expect(out[1]![1]).toBe('5')
    const chained = cells('| A | B |\n| --- | --- |\n| 2 | =A2*3 |\n| =B2+1 | =A3*2 |')
    expect(chained[1]![1]).toBe('6')
    expect(chained[2]![0]).toBe('7')
    expect(chained[2]![1]).toBe('14')
  })

  it('treats a leading == as highlight markdown, not a formula', () => {
    const out = cells('| A |\n| --- |\n| ==hey== |\n| ==nope |\n| =2+2 |')
    expect(out[1]![0]).toBe('==hey==')
    expect(out[1]![0]).not.toBe('#ERROR!')
    expect(out[2]![0]).toBe('==nope') // unbalanced `==` is literal text
    expect(out[3]![0]).toBe('4') // plain `=` still evaluates as a formula
  })

  it('aggregates ranges with row 1 = header', () => {
    const out = cells(
      '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| =SUM(A2:C3) | =AVERAGE(A2:B3) | =COUNT(A2:C3) |',
    )
    expect(out[3]![0]).toBe('21')
    expect(out[3]![1]).toBe('3')
    expect(out[3]![2]).toBe('6')
  })

  it('marks each error kind', () => {
    expect(kinds('| A |\n| --- |\n| 0 |\n| =5/A2 |')[2]![0]).toBe('error')
    expect(kinds('| A |\n| --- |\n| abc |\n| =A2+1 |')[2]![0]).toBe('error')
    expect(kinds('| A |\n| --- |\n| 1 |\n| =FOO(A2) |')[2]![0]).toBe('error')
    expect(kinds('| A |\n| --- |\n| =A2 |')[1]![0]).toBe('error')
  })

  it('displays error text and raw text verbatim', () => {
    const solution = solve(parsePipes('| A |\n| --- |\n| 0 |\n| =1/A2 |'))
    expect(solution.cells[2]![0]!.display).toBe('#DIV/0!')
    expect(solution.cells[2]![0]!.error).toBe('#DIV/0!')
    expect(solution.cells[1]![0]!.display).toBe('0')
    expect(solution.cells[1]![0]!.value).toBeUndefined()
  })

  it('evaluates a literal #REF! as a reference error, not #ERROR!', () => {
    const out = cells('| A |\n| --- |\n| =#REF! |')
    expect(out[1]![0]).toBe('#REF!')
    expect(kinds('| A |\n| --- |\n| =#REF!+1 |')[1]![0]).toBe('error')
    expect(cells('| A |\n| --- |\n| =#REF!+1 |')[1]![0]).toBe('#REF!')
  })

  it('errors on a reference outside the table instead of treating it as empty', () => {
    expect(cells('| A | B |\n| --- | --- |\n| 1 | =F2+C2 |')[1]![1]).toBe('#REF!')
    expect(kinds('| A | B |\n| --- | --- |\n| 1 | =F2+C2 |')[1]![1]).toBe('error')
    expect(cells('| A | B |\n| --- | --- |\n| 1 | =A5 |')[1]![1]).toBe('#REF!')
    expect(cells('| A | B |\n| --- | --- |\n| 1 | =SUM(C2:C9) |')[1]![1]).toBe('#REF!')
  })

  it('still treats an in-bounds empty cell as blank', () => {
    const out = cells('| A | B |\n| --- | --- |\n| 1 | 2 |\n| =A2+B3 | |')
    expect(out[2]![0]).toBe('1')
  })

  it('treats a lone `=` as blank and leaves text cells as raw text', () => {
    const out = cells('| A |\n| --- |\n| = |\n| hello |')
    expect(out[1]![0]).toBe('')
    expect(out[2]![0]).toBe('hello')
    const k = kinds('| A |\n| --- |\n| = |')
    expect(k[1]![0]).toBe('blank')
  })

  it('reports rows and cols in the solution', () => {
    const solution = solve(parsePipes('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |'))
    expect(solution.rows).toBe(4)
    expect(solution.cols).toBe(2)
  })
})

describe('cell reference helpers', () => {
  it('converts column numbers to spreadsheet letters', () => {
    expect(colToLetters(1)).toBe('A')
    expect(colToLetters(26)).toBe('Z')
    expect(colToLetters(27)).toBe('AA')
    expect(colToLetters(52)).toBe('AZ')
  })

  it('parses uppercase and lowercase cell references', () => {
    expect(parseCellRef('B2')).toEqual({ col: 2, row: 2 })
    expect(parseCellRef('aa10')).toEqual({ col: 27, row: 10 })
    expect(parseCellRef('nope')).toBeNull()
    expect(parseCellRef('2B')).toBeNull()
  })
})

describe('pipe-table utils', () => {
  it('round-trips escape pipes, ragged rows, and the delimiter', () => {
    const rows = parsePipes('| a\\|b |\n| --- |\n| c | d |\n| e |')
    expect(rows).toEqual([
      ['a|b', ''],
      ['c', 'd'],
      ['e', ''],
    ])
    const back = parsePipes(tableToPipes(rows))
    expect(back).toEqual(rows)
  })

  it('emits a delimiter row only when data rows exist', () => {
    expect(tableToPipes([['A', 'B']])).toBe('| A | B |')
    expect(tableToPipes([['A', 'B'], ['1', '2']])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
  })

  it('skips blank lines and delimiter-shaped data rows', () => {
    expect(parsePipes('\n| A |\n| --- |\n')).toEqual([['A']])
    expect(parsePipes('| :---: |\n| x |')).toEqual([['x']])
  })

  it('converts a DOM table into normalized pipe markdown', () => {
    const table = document.createElement('table')
    table.innerHTML =
      '<thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>a</td><td> b </td></tr></tbody>'
    expect(domTableToPipes(table)).toBe('| H1 | H2 |\n| --- | --- |\n| a | b |')
  })

  it('reads column alignment from the delimiter row', () => {
    expect(parsePipesAlign('| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |')).toEqual([
      'left',
      'center',
      'right',
    ])
    expect(parsePipesAlign('| A |\n| --- |')).toEqual(['none'])
    expect(parsePipesAlign('| A |\n| 1 |')).toEqual([])
  })

  it('writes column alignments into the delimiter row', () => {
    expect(tableToPipes([['A', 'B', 'C'], ['1', '2', '3']], ['left', 'center', 'right'])).toBe(
      '| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |',
    )
    expect(tableToPipes([['A', 'B'], ['1', '2']])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
  })

  it('carries HTML cell alignment into the delimiter row', () => {
    const table = document.createElement('table')
    table.innerHTML =
      '<tr><th style="text-align: center">H1</th><th align="right">H2</th></tr><tr><td>a</td><td>b</td></tr>'
    expect(domTableToPipes(table)).toBe('| H1 | H2 |\n| :---: | ---: |\n| a | b |')
  })
})

describe('inlineMarkdownToHtml', () => {
  it('renders the supported inline constructs', () => {
    expect(inlineMarkdownToHtml('**b** and *i*')).toBe('<strong>b</strong> and <em>i</em>')
    expect(inlineMarkdownToHtml('__b__ _i_')).toBe('<strong>b</strong> <em>i</em>')
    expect(inlineMarkdownToHtml('`c` and ~~d~~')).toBe('<code>c</code> and <del>d</del>')
    expect(inlineMarkdownToHtml('[t](http://x.example)')).toBe(
      '<a href="http://x.example">t</a>',
    )
  })

  it('escapes raw HTML and quotes', () => {
    expect(inlineMarkdownToHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(inlineMarkdownToHtml('a "b" & c')).toBe('a &quot;b&quot; &amp; c')
  })

  it('renders highlight, subscript, and superscript', () => {
    expect(inlineMarkdownToHtml('==mark==')).toBe('<mark>mark</mark>')
    expect(inlineMarkdownToHtml('H~2~O')).toBe('H<sub>2</sub>O')
    expect(inlineMarkdownToHtml('x^2^')).toBe('x<sup>2</sup>')
    expect(inlineMarkdownToHtml('~a~ ~~del~~')).toBe('<sub>a</sub> <del>del</del>')
    expect(inlineMarkdownToHtml('==**b** and *i*==')).toBe(
      '<strong><mark>b</mark></strong><mark> and </mark><em><mark>i</mark></em>',
    )
  })

  it('escapes HTML inside highlight/sub/sup marks', () => {
    expect(inlineMarkdownToHtml('==<&>==')).toBe('<mark>&lt;&amp;&gt;</mark>')
    expect(inlineMarkdownToHtml('~<x>~')).toBe('<sub>&lt;x&gt;</sub>')
  })

  it('composes overlapping inline marks', () => {
    expect(inlineMarkdownToHtml('***b***')).toBe('<strong><em>b</em></strong>')
    expect(inlineMarkdownToHtml('**b *i***')).toBe('<strong>b </strong><strong><em>i</em></strong>')
    expect(inlineMarkdownToHtml('***b** i*')).toBe('<strong><em>b</em></strong><em> i</em>')
    expect(inlineMarkdownToHtml('**b `c`**')).toBe('<strong>b </strong><strong><code>c</code></strong>')
    expect(inlineMarkdownToHtml('~~s **b**~~')).toBe('<del>s </del><strong><del>b</del></strong>')
    expect(inlineMarkdownToHtml('*i [l](http://x.example)*')).toBe(
      '<em>i </em><a href="http://x.example"><em>l</em></a>',
    )
    expect(inlineMarkdownToHtml('***`c`***')).toBe('<strong><em><code>c</code></em></strong>')
  })

  it('escapes HTML inside composed marks', () => {
    expect(inlineMarkdownToHtml('***<&>***')).toBe('<strong><em>&lt;&amp;&gt;</em></strong>')
  })

  it('renders masked-field tokens as static pills', () => {
    expect(inlineMarkdownToHtml('!masked[c1phers]')).toBe(
      '<span class="masked-field">••••••••••••</span>',
    )
    expect(inlineMarkdownToHtml('!masked[c1phers]{label="PIN"}')).toBe(
      '<span class="masked-field">•••••••••••• (PIN)</span>',
    )
    expect(inlineMarkdownToHtml('**User** !masked[x]{label="pw"}')).toBe(
      '<strong>User</strong> <span class="masked-field">•••••••••••• (pw)</span>',
    )
  })

  it('escapes masked labels before embedding them', () => {
    expect(inlineMarkdownToHtml('!masked[x]{label="a<b"}')).toBe(
      '<span class="masked-field">•••••••••••• (a&lt;b)</span>',
    )
  })
})

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
