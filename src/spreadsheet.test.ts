import { describe, expect, it } from 'vitest'

import { BUILTIN_ENV } from './formulas'
import {
  colToLetters,
  computeSpreadsheet,
  formatNumber,
  isFormula,
  parseCellRef,
  solve,
} from './spreadsheet'
import {
  domTableToPipes,
  parsePipesAlign,
  inlineMarkdownToHtml,
  parsePipes,
  tableToPipes,
  resolveTableValue,
  hydrateResolvedTable,
  formatTableCarrier,
  parseTableCarrier,
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

  it('recognizes mark-wrapped formulas so a bolded cell keeps computing', () => {
    expect(isFormula('=SUM(A2:A3)')).toBe(true)
    expect(isFormula('**=SUM(A2:A3)**')).toBe(true)
    expect(isFormula('*##')).toBe(false)
    expect(isFormula('**bold text**')).toBe(false)
    const out = cells('| A | B |\n| --- | --- |\n| **10** | 20 |\n| **=SUM(A2:B2)** | =SUM(A2:B2) |')
    expect(out[2]![0]).toBe('**30**')
    expect(out[2]![1]).toBe('30')
    const styled = solve(parsePipes('| A | B |\n| --- | --- |\n| 2 | 3 |\n| **=A2+B2** | |'))!
    expect(styled.cells[2]![0]!.styled).toBe(true)
    expect(kinds('| A | B |\n| --- | --- |\n| 2 | 3 |\n| **=A2+B2** | |')[2]![0]).toBe('formula')
  })

  it('keeps the formula result live but styled for nested and code marks', () => {
    const out = cells('| A | B |\n| --- | --- |\n| 2 | 3 |\n| ***=A2+B2*** | `=A2*B2` |')
    expect(out[2]![0]).toBe('***5***')
    expect(out[2]![1]).toBe('`6`')
  })

  it('requires the marks to wrap the whole formula to count as a marked formula', () => {
    // The trailing ` extra` is outside the strong run, so marks are not
    // uniform across segments and the cell stays literal text.
    expect(isFormula('**=SUM(A2:A3)** extra')).toBe(false)
    expect(kinds('| A |\n| --- |\n| 1 |\n| 2 |\n| **=SUM(A2:A3)** extra |')[3]![0]).toBe('text')
    expect(cells('| A |\n| --- |\n| 1 |\n| 2 |\n| **=SUM(A2:A3)** extra |')[3]![0]).toBe(
      '**=SUM(A2:A3)** extra',
    )
    expect(isFormula('=2+2')).toBe(true)
  })

  it('marks an error in a bold formula and keeps the marks on its display', () => {
    const solution = solve(parsePipes('| A |\n| --- |\n| 0 |\n| **=3/A2** |'))
    expect(solution.cells[2]![0]!.display).toBe('**#DIV/0!**')
    expect(solution.cells[2]![0]!.error).toBe('#DIV/0!')
    expect(solution.cells[2]![0]!.styled).toBe(true)
    expect(solution.cells[2]![0]!.kind).toBe('error')
  })

  it('unbalanced or mismatched marks around = stay literal text', () => {
    expect(isFormula('**=SUM(1)')).toBe(false) // dangling open mark
    expect(cells('| A |\n| --- |\n| **=SUM(A2:A3) |\n| 5 |')[1]![0]).toBe('**=SUM(A2:A3)')
    expect(kinds('| A |\n| --- |\n| **=SUM(A2:A3) |')[1]![0]).toBe('text')
  })

  it('aggregates ranges with row 1 = header', () => {
    const out = cells(
      '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| =SUM(A2:C3) | =AVERAGE(A2:B3) | =COUNT(A2:C3) |',
    )
    expect(out[3]![0]).toBe('21')
    expect(out[3]![1]).toBe('3')
    expect(out[3]![2]).toBe('6')
  })

  it('resolves references with $ absolute markers', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| 10 | 20 |\n| =$A$2 | =A$2+$B2 |',
    )
    expect(out[2]![0]).toBe('10')
    expect(out[2]![1]).toBe('30')
    expect(kinds('| A | B |\n| --- | --- |\n| 10 | 20 |\n| =$A$2 | =A$2+$B2 |')[2]![0]).toBe('formula')
  })

  it('resolves $ markers inside ranges', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| =SUM($A$2:$B$3) | |',
    )
    expect(out[3]![0]).toBe('10')
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

  it('math works on bold, italic, and strike-wrapped numbers', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| **10** | *20* |\n| ~~5~~ | 6 |\n| =SUM(A2:B3) | |',
    )
    expect(out[3]![0]).toBe('41')
  })

  it('aggregates code, highlight, sub, and sup-wrapped numbers', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| `10` | ==20== |\n| ~5~ | ^6^ |\n| =SUM(A2:B3) |',
    )
    expect(out[3]![0]).toBe('41')
  })

  it('collapses nested bold+italic wraps to a number', () => {
    const out = cells('| A | B |\n| --- | --- |\n| ***10*** | =A2*2 |')
    expect(out[1]![1]).toBe('20')
  })

  it('uses a formatted number in a direct arithmetic reference', () => {
    const out = cells('| A | B |\n| --- | --- |\n| **10** | =A2*3 |')
    expect(out[1]![1]).toBe('30')
  })

  it('does not treat mixed, linked, or escaped content as numbers', () => {
    const textOut = cells('| A | B |\n| --- | --- |\n| **1** and 2 | \\*3\\* |\n| =SUM(A2:B2) |')
    expect(textOut[2]![0]).toBe('0')
    expect(
      kinds('| A | B |\n| --- | --- |\n| [10](http://x.example) | =A2+1 |')[1]![1],
    ).toBe('error')
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

  it('parses references with $ absolute markers on either axis', () => {
    expect(parseCellRef('$B$2')).toEqual({ col: 2, row: 2 })
    expect(parseCellRef('B$2')).toEqual({ col: 2, row: 2 })
    expect(parseCellRef('$B2')).toEqual({ col: 2, row: 2 })
    expect(parseCellRef('$aa10')).toEqual({ col: 27, row: 10 })
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

  it('flags links whose text does not match their destination', () => {
    const raw = '[https://www.google.com](https://attacker.address)'
    expect(inlineMarkdownToHtml(raw)).toBe(
      '<a href="https://attacker.address">https://www.google.com</a>',
    )
    expect(inlineMarkdownToHtml(raw, { markMisleading: true })).toBe(
      '<a href="https://attacker.address" class="ml-misleading">https://www.google.com</a>',
    )
  })

  it('does not flag a link whose text matches its destination', () => {
    const raw = '[https://example.com](https://example.com)'
    expect(inlineMarkdownToHtml(raw, { markMisleading: true })).toBe(
      '<a href="https://example.com">https://example.com</a>',
    )
  })

  it('keeps a link split by nested marks in one anchor', () => {
    const raw = '[**www.google.com**](https://attacker.address)'
    expect(inlineMarkdownToHtml(raw, { markMisleading: true })).toBe(
      '<a href="https://attacker.address" class="ml-misleading">' +
        '<strong>www.google.com</strong></a>',
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

describe('logical formula cells', () => {
  function cells(markdown: string): string[][] {
    const solution = solve(parsePipes(markdown))
    return solution.cells.map((row) => row.map((cell) => cell.display))
  }

  it('IF picks a branch lazily, never evaluating the untaken one', () => {
    const guard = cells('| A |\n| --- |\n| 0 |\n| =IF(A2=0, 0, 10/A2) |')
    expect(guard[2]![0]).toBe('0')
    const skipError = cells('| A |\n| --- |\n| 1 |\n| =IF(A2>0, A2*10, 1/0) |')
    expect(skipError[2]![0]).toBe('10')
  })

  it('IF returns text results that render like text cells', () => {
    const grade = cells('| A |\n| --- |\n| 55 |\n| =IF(A2>=70, "Pass", "Fail") |')
    expect(grade[2]![0]).toBe('Fail')
    const pass = cells('| A |\n| --- |\n| 90 |\n| =IF(A2>=70, "Pass", "Fail") |')
    expect(pass[2]![0]).toBe('Pass')
  })

  it('IFERROR, IFS, and SWITCH evaluate lazily and string literal branches', () => {
    const out = cells(
      '| A |\n| --- |\n| 0 |\n| =IFERROR(10/A2, "none") |\n| =IFS(A2=0, "zero", A2>0, "pos", TRUE, "neg") |\n| =SWITCH(A2, 0, "none", 1, "one", "other") |',
    )
    expect(out[2]![0]).toBe('none')
    expect(out[3]![0]).toBe('zero')
    expect(out[4]![0]).toBe('none')
  })

  it('IF selects lazily even when the untaken branch is out of range', () => {
    const out = cells('| A |\n| --- |\n| 7 |\n| =IF(A2>3, 1, C9) |')
    expect(out[2]![0]).toBe('1')
  })

  it('nests lazy conditionals and evaluates ranges only in the taken branch', () => {
    const out = cells(
      '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| =IF(TRUE, SUM(B2:C3), 1/0) |',
    )
    expect(out[3]![0]).toBe('16')
  })

  it('IFS reports #N/A! when no condition matches', () => {
    const out = cells('| A |\n| --- |\n| 5 |\n| =IFS(A2>10, "big", A2<0, "neg") |')
    expect(out[2]![0]).toBe('#N/A!')
  })

  it('folds AND, OR, NOT, and the IS helpers to TRUE/FALSE', () => {
    const out = cells(
      '| A | B | C |\n| --- | --- | --- |\n| 3 | 5 | |\n| =AND(A2>0, B2>A2) | =OR(A2>10, B2=5) | =NOT(B2=5) |\n| =ISNUMBER(A2) | =ISTEXT("hi") | =ISBLANK(C2) |',
    )
    expect(out[2]![0]).toBe('TRUE')
    expect(out[2]![1]).toBe('TRUE')
    expect(out[2]![2]).toBe('FALSE')
    expect(out[3]![0]).toBe('TRUE')
    expect(out[3]![1]).toBe('TRUE')
    expect(out[3]![2]).toBe('TRUE')
  })

  it('ISNUMBER rejects text that merely looks numeric', () => {
    const out = cells('| A | B |\n| --- | --- |\n| 3 | =ISNUMBER("3") |')
    expect(out[1]![1]).toBe('FALSE')
  })

  it('marks a text formula result so renderers treat it as markdown', () => {
    const solution = solve(parsePipes('| A | B |\n| --- | --- |\n| 4 | =IF(A2>1, "yes", "no") |'))
    expect(solution.cells[1]![1]!.display).toBe('yes')
    expect(solution.cells[1]![1]!.rendersMarkdown).toBe(true)
    expect(solution.cells[1]![1]!.kind).toBe('formula')
  })
})

describe('text formula cells', () => {
  function cells(markdown: string): string[][] {
    const solution = solve(parsePipes(markdown))
    return solution.cells.map((row) => row.map((cell) => cell.display))
  }

  it('CONCAT joins values, references, and ranges into a text cell', () => {
    const out = cells('| A | B |\n| --- | --- |\n| hello | 5 |\n| =CONCAT(A2, " ", B2) | =CONCATENATE("x", A2) |')
    expect(out[2]![0]).toBe('hello 5')
    expect(out[2]![1]).toBe('xhello')
  })

  it('TEXTJOIN joins a range with a delimiter and skips blanks', () => {
    const out = cells(
      '| A | B | C |\n| --- | --- | --- |\n| red |  | green |\n| =TEXTJOIN(", ", TRUE, A2:C2) | |',
    )
    expect(out[2]![0]).toBe('red, green')
  })

  it('UPPER, LOWER, TRIM, and LEN transform their display form', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| HeLLo | |\n| =UPPER(A2) | =LOWER(SUBSTITUTE(A2, "L", "l")) |\n| =LEN(TRIM("  hi   there  ")) | =CONCAT("(", A2, ")") |',
    )
    expect(out[2]![0]).toBe('HELLO')
    expect(out[2]![1]).toBe('hello')
    expect(out[3]![0]).toBe('8')
    expect(out[3]![1]).toBe('(HeLLo)')
  })

  it('LEFT, RIGHT, and MID slice characters from a text result', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| 123456 | =LEFT(A2, 3) |\n| =RIGHT(A2, 2) | =MID(A2, 2, 2) |',
    )
    expect(out[1]![1]).toBe('123')
    expect(out[2]![0]).toBe('56')
    expect(out[2]![1]).toBe('23')
  })

  it('SUBSTITUTE, REPT, EXACT, and VALUE evaluate end to end', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| a-b-c | =EXACT(A2, "a-b-c") |\n| =SUBSTITUTE(A2, "-", "/") | =REPT("ab", 2) |\n| =VALUE("12.5") | =IF(EXACT(A2, B2), 1, 0) |',
    )
    expect(out[1]![1]).toBe('TRUE')
    expect(out[2]![0]).toBe('a/b/c')
    expect(out[2]![1]).toBe('abab')
    expect(out[3]![0]).toBe('12.5')
    expect(out[3]![1]).toBe('0')
  })

  it('reports a #VALUE! for a negative slice count', () => {
    const out = cells('| A |\n| --- |\n| hello |\n| =LEFT(A2, -1) |')
    expect(out[2]![0]).toBe('#VALUE!')
  })
})

describe('math, aggregate, and criteria formula cells', () => {
  function cells(markdown: string): string[][] {
    const solution = solve(parsePipes(markdown))
    return solution.cells.map((row) => row.map((cell) => cell.display))
  }

  it('MOD, INT, TRUNC, and ROUNDUP evaluate end to end', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| 7 | 2 |\n| =MOD(A2, B2) | =INT(-1.5) |\n| =TRUNC(1.2345, 2) | =ROUNDUP(3.2, 0) |',
    )
    expect(out[2]![0]).toBe('1')
    expect(out[2]![1]).toBe('-2')
    expect(out[3]![0]).toBe('1.23')
    expect(out[3]![1]).toBe('4')
  })

  it('CEILING, POWER, and the logarithm family evaluate end to end', () => {
    const out = cells(
      '| A |\n| --- |\n| 8 |\n| =LN(A2) |\n| =LOG(A2, 2) |\n| =POWER(2, 3) |\n| =CEILING(A2, 3) |',
    )
    expect(out[2]![0]).toBe('2.0794')
    expect(out[3]![0]).toBe('3')
    expect(out[4]![0]).toBe('8')
    expect(out[5]![0]).toBe('9')
  })

  it('SUMIF, COUNTIF, AVERAGEIF, and MEDIAN work on ranges and criteria', () => {
    const out = cells(
      '| A | B | C |\n| --- | --- | --- |\n| 1 | Apples | 10 |\n| 5 | Pears | 20 |\n| 9 | Apples | 30 |\n| =SUMIF(B2:B4, "Apples", C2:C4) | =COUNTIF(A2:A4, ">4") | =MEDIAN(A2:A4) |\n| =LARGE(A2:A4, 2) | =AVERAGEIF(A2:A4, ">4") | =MOD(A3, 3) |',
    )
    expect(out[4]![0]).toBe('40')
    expect(out[4]![1]).toBe('2')
    expect(out[4]![2]).toBe('5')
    expect(out[5]![0]).toBe('5')
    expect(out[5]![1]).toBe('7')
    expect(out[5]![2]).toBe('2')
  })

  it('surfaces a #NUM! for an out-of-domain math error', () => {
    const out = cells('| A |\n| --- |\n| 0 |\n| =LN(A2) |')
    expect(out[2]![0]).toBe('#NUM!')
  })
})

describe('date formula cells', () => {
  function cells(markdown: string): string[][] {
    const solution = solve(parsePipes(markdown))
    return solution.cells.map((row) => row.map((cell) => cell.display))
  }

  it('DATE renders as YYYY-MM-DD and feeds the extractors', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| =DATE(2024, 2, 29) | =YEAR(A2) + 1 |\n| =MONTH(A2) | =WEEKDAY(A2, 2) |\n| =DAYS(DATE(2024, 3, 1), A2) | =EOMONTH(A2, 1) |',
    )
    expect(out[1]![0]).toBe('2024-02-29')
    expect(out[1]![1]).toBe('2025')
    expect(out[2]![0]).toBe('2')
    expect(out[2]![1]).toBe('4')
    expect(out[3]![0]).toBe('1')
    expect(out[3]![1]).toBe('2024-03-31')
  })

  it('DATE normalizes overflow and an EDATE clamps to the month end', () => {
    const out = cells(
      '| A |\n| --- |\n| =DATE(2024, 13, 40) |\n| =EDATE(DATE(2024, 1, 31), 1) |',
    )
    expect(out[1]![0]).toBe('2025-02-09')
    expect(out[2]![0]).toBe('2024-02-29')
  })

  it('threads the injected clock into TODAY and NOW cells', () => {
    const env = { ...BUILTIN_ENV, now: () => new Date(2024, 5, 15, 9, 0) }
    const solution = solve(parsePipes('| A |\n| --- |\n| =TODAY() |\n| =NOW() |'), env)
    expect(solution.cells[1]![0]!.display).toBe('2024-06-15')
    expect(solution.cells[2]![0]!.display).toBe('2024-06-15 09:00:00')
  })
})

describe('lookup formula cells', () => {
  function cells(markdown: string): string[][] {
    const solution = solve(parsePipes(markdown))
    return solution.cells.map((row) => row.map((cell) => cell.display))
  }

  it('VLOOKUP, INDEX, and MATCH read values out of a table', () => {
    const out = cells(
      '| Item | Price | Qty |\n| --- | --- | --- |\n| Apples | 10 | 3 |\n| Pears | 20 | 5 |\n| Oranges | 30 | 2 |\n| =VLOOKUP("Pears", A2:C4, 3, FALSE) | =INDEX(A2:C4, 3, 2) | =MATCH("Oranges", A2:A4, 0) |',
    )
    expect(out[4]![0]).toBe('5')
    expect(out[4]![1]).toBe('30')
    expect(out[4]![2]).toBe('3')
  })

  it('VLOOKUP and MATCH approximate-match on sorted data', () => {
    const out = cells(
      '| A | B |\n| --- | --- |\n| 1 | x |\n| 3 | y |\n| 5 | z |\n| =VLOOKUP(4, A2:B4, 2) | =MATCH(4, A2:A4, 1) |',
    )
    expect(out[4]![0]).toBe('y')
    expect(out[4]![1]).toBe('2')
  })

  it('HLOOKUP matches along the first row', () => {
    const out = cells(
      '| A | B | C |\n| --- | --- | --- |\n| 10 | 20 | 30 |\n| a | b | c |\n| =HLOOKUP(20, A2:C3, 2, FALSE) | | |',
    )
    expect(out[3]![0]).toBe('b')
  })

  it('surfaces a #N/A! when the lookup finds nothing', () => {
    const out = cells(
      '| A |\n| --- |\n| Apples |\n| =VLOOKUP("Pears", A2:A2, 1, FALSE) |\n| =MATCH("Pears", A2:A2, 0) |',
    )
    expect(out[2]![0]).toBe('#N/A!')
    expect(out[3]![0]).toBe('#N/A!')
  })
})

describe('resolved table markdown helpers', () => {
  it('resolves formula cells to displays and keeps plain cells verbatim', () => {
    const { pipes, formulas } = resolveTableValue(
      '| Item | Q1 | Q2 | Total |\n| --- | --- | --- | --- |\n| A | 10 | 20 | =SUM(B2:C2) |',
    )
    expect(pipes).toBe(
      '| Item | Q1 | Q2 | Total |\n| --- | --- | --- | --- |\n| A | 10 | 20 | 30 |',
    )
    expect(formulas).toEqual({ D2: '=SUM(B2:C2)' })
  })

  it('keeps styled numbers verbatim (they are not formulas)', () => {
    const { pipes, formulas } = resolveTableValue(
      '| A | B |\n| --- | --- |\n| **10** | *20* |\n| =SUM(A2:B2) | |',
    )
    expect(pipes).toBe(
      '| A | B |\n| --- | --- |\n| **10** | *20* |\n| 30 |  |',
    )
    expect(formulas).toEqual({ A3: '=SUM(A2:B2)' })
  })

  it('carries an error display and formula through the round trip', () => {
    const { pipes, formulas } = resolveTableValue('| A |\n| --- |\n| =1/0 |')
    expect(pipes).toBe('| A |\n| --- |\n| #DIV/0! |')
    expect(formulas).toEqual({ A2: '=1/0' })
    expect(hydrateResolvedTable(parsePipes(pipes), parsePipesAlign(pipes), formulas)).toBe(
      '| A |\n| --- |\n| =1/0 |',
    )
  })

  it('keeps the delimiter-row alignment on resolution', () => {
    const { pipes } = resolveTableValue('| A | B |\n| :--- | ---: |\n| 1 | =A2*2 |')
    expect(pipes).toBe('| A | B |\n| :--- | ---: |\n| 1 | 2 |')
  })

  it('carries a styled formula through bake + hydrate without losing marks', () => {
    const original = '| A | B |\n| --- | --- |\n| 2 | 3 |\n| **=A2+B2** | =A2*B2 |\n| `=SUM(A2:B3)` |  |'
    const { pipes, formulas } = resolveTableValue(original)
    // SUM(A2:B3) sees 2, 3, 5 (=A2+B2), 6 (=A2*B2) → 16.
    expect(pipes).toBe(
      '| A | B |\n| --- | --- |\n| 2 | 3 |\n| **5** | 6 |\n| `16` |  |',
    )
    expect(formulas).toEqual({
      A3: '**=A2+B2**',
      B3: '=A2*B2',
      A4: '`=SUM(A2:B3)`',
    })
    expect(
      hydrateResolvedTable(parsePipes(pipes), parsePipesAlign(pipes), formulas),
    ).toBe(original)
    // Re-solving the hydrated grid restores live, styled formula cells.
    const solution = solve(parsePipes(original))
    expect(solution.cells[2]![0]!.display).toBe('**5**')
    expect(solution.cells[2]![1]!.display).toBe('6')
    expect(solution.cells[3]![0]!.display).toBe('`16`')
  })

  it('formats the carrier comment as a single HTML comment line', () => {
    expect(formatTableCarrier({ C2: '=B2*1.5', D2: '=SUM(B2:C2)' })).toBe(
      '<!-- edi-fml {"C2":"=B2*1.5","D2":"=SUM(B2:C2)"} -->',
    )
  })

  it('hydrates formulas back into their cells and rebuilds normalized pipes', () => {
    const original = '| Item | Qty | Price | Total |\n| --- | --- | --- | --- |\n| A | 3 | =B2*1.5 | =SUM(B2:C2) |'
    const { pipes, formulas } = resolveTableValue(original)
    expect(
      hydrateResolvedTable(parsePipes(pipes), parsePipesAlign(pipes), formulas),
    ).toBe(original)
  })

  it('hydrate skips refs outside the grid', () => {
    const out = hydrateResolvedTable(
      [['A', 'B'], ['1', '2']],
      null,
      { C9: '=B2*3', A2: '=A1+B1' },
    )
    expect(out).toBe('| A | B |\n| --- | --- |\n| =A1+B1 | 2 |')
  })

  it('parses only well-formed carrier comments', () => {
    expect(parseTableCarrier('<!-- edi-fml {"C2":"=SUM(B2:C2)"} -->')).toEqual({
      C2: '=SUM(B2:C2)',
    })
    expect(parseTableCarrier('  <!-- edi-fml {"A2":"=1"} -->  ')).toEqual({ A2: '=1' })
    expect(parseTableCarrier('<!-- edi-fml {"nope":1} -->')).toBeNull()
    expect(parseTableCarrier('<!-- edi-fml {"C2":"=1","bad":"x"} -->')).toBeNull()
    expect(parseTableCarrier('<!-- edi-fml not-json -->')).toBeNull()
    expect(parseTableCarrier('<!-- a normal comment -->')).toBeNull()
    expect(parseTableCarrier('<!-- edi-other {"x":1} -->')).toBeNull()
  })
})
