import { describe, expect, it } from 'vitest'
import { TerminalOutput, TerminalScreen, styleCss } from './terminal'

function screenText(...chunks: string[]): string {
  const screen = new TerminalScreen()
  for (const chunk of chunks) screen.write(chunk)
  return screen.text()
}

function styledRuns(...chunks: string[]): [string, string][] {
  const screen = new TerminalScreen()
  for (const chunk of chunks) screen.write(chunk)
  const runs: [string, string][] = []
  for (let row = 0; row < screen.lineCount; row++) {
    for (const { text, style } of screen.segments(row)) runs.push([text, styleCss(style)])
  }
  return runs
}

describe('TerminalScreen', () => {
  it('keeps plain lines as written', () => {
    expect(screenText('one\ntwo\n')).toBe('one\ntwo\n')
  })

  it('overwrites a line from its start after a carriage return, as a progress bar does', () => {
    expect(screenText('Downloading  10%', '\rDownloading  55%', '\rDownloading 100%\n')).toBe(
      'Downloading 100%\n',
    )
    // A shorter rewrite leaves the old line's tail, as a terminal does…
    expect(screenText('12345\rab')).toBe('ab345')
    // …which is why progress output erases the line first.
    expect(screenText('12345\r\x1b[Kab')).toBe('ab')
    expect(screenText('12345\r\x1b[2Kab')).toBe('ab')
  })

  it('steps back with backspace, the spinner way', () => {
    expect(screenText('abc\b\bX')).toBe('aXc')
    expect(screenText('working |', '\b/', '\b-', '\b\\')).toBe('working \\')
    expect(screenText('\b\bx')).toBe('x')
  })

  it('moves up and rewrites earlier lines for multi-line progress', () => {
    expect(screenText('one\ntwo\n', '\x1b[2Aonce\x1b[2B')).toBe('once\ntwo\n')
    expect(screenText('a: 1\nb: 1\n', '\x1b[2F\x1b[Ka: 2\n\x1b[Kb: 2\n')).toBe('a: 2\nb: 2\n')
    expect(screenText('abc', '\x1b[2D', 'X', '\x1b[G', 'Y')).toBe('YXc')
  })

  it('clears what was shown', () => {
    expect(screenText('one\ntwo', '\x1b[2J\x1b[Hthree')).toBe('three\n')
    expect(screenText('one\ntwo', '\x1b[1;1H\x1b[J', 'x')).toBe('x')
  })

  it('expands tabs to the next stop of 8', () => {
    expect(screenText('a\tb', '\nabcdefgh\tc')).toBe('a       b\nabcdefgh        c')
  })

  it('drops sequences that draw nothing, even split across chunks', () => {
    expect(screenText('\x1b[?25lhi\x1b[?25h')).toBe('hi')
    // A hyperlink (OSC 8), ended by BEL and by ST.
    expect(screenText('\x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\')).toBe('link')
    expect(screenText('\x1b]0;a title\x07x')).toBe('x')
    expect(screenText('\x1b(Bx\x07y\x1b=z')).toBe('xyz')
    expect(screenText('\x1b[3', '1mre', 'd\x1b', '[0m')).toBe('red')
  })

  it('colors text by SGR: the 16 colors, 256, 24-bit, and attributes', () => {
    expect(styledRuns('\x1b[31mred\x1b[0m plain')).toEqual([
      ['red', 'color: var(--term-1)'],
      [' plain', ''],
    ])
    expect(styledRuns('\x1b[1;32mok\x1b[22m', '\x1b[39m.')).toEqual([
      // Bold base colors show in their bright half.
      ['ok', 'color: var(--term-10); font-weight: bold'],
      ['.', ''],
    ])
    expect(styledRuns('\x1b[94;103mx')).toEqual([['x', 'color: var(--term-12); background-color: var(--term-11)']])
    expect(styledRuns('\x1b[38;5;196ma\x1b[38;5;244mb\x1b[38;5;4mc')).toEqual([
      ['a', 'color: rgb(255, 0, 0)'],
      ['b', 'color: rgb(128, 128, 128)'],
      ['c', 'color: var(--term-4)'],
    ])
    expect(styledRuns('\x1b[38;2;10;20;30mx\x1b[48:2::1:2:3my')).toEqual([
      ['x', 'color: rgb(10, 20, 30)'],
      ['y', 'color: rgb(10, 20, 30); background-color: rgb(1, 2, 3)'],
    ])
    expect(styledRuns('\x1b[2;3;4;9mx')).toEqual([
      ['x', 'opacity: 0.6; font-style: italic; text-decoration: underline line-through'],
    ])
    expect(styledRuns('\x1b[7mx\x1b[27;31;7my')).toEqual([
      ['x', 'color: var(--exec-bg); background-color: var(--exec-fg)'],
      ['y', 'color: var(--exec-bg); background-color: var(--term-1)'],
    ])
    expect(styledRuns('\x1b[31mx\x1b[my')).toEqual([
      ['x', 'color: var(--term-1)'],
      ['y', ''],
    ])
  })

  it('appends status lines after the output, without its trailing blank lines', () => {
    const screen = new TerminalScreen()
    screen.write('\x1b[31mboom\x1b[0m\n\n')
    screen.appendStatus(['Process exited with code 1'])
    expect(screen.text()).toBe('boom\nProcess exited with code 1')

    const empty = new TerminalScreen()
    empty.appendStatus(['Process stopped'])
    expect(empty.text()).toBe('Process stopped')
  })
})

describe('TerminalOutput', () => {
  it('draws one span per line whose text is the screen text', () => {
    const pre = document.createElement('pre')
    const output = new TerminalOutput(pre)
    output.write('one\n\x1b[32mtwo\x1b[0m\n')
    expect(pre.textContent).toBe('one\ntwo\n')
    expect(pre.querySelectorAll('.term-line')).toHaveLength(3)
    expect((pre.querySelectorAll('.term-line')[1].querySelector('span') as HTMLElement).style.color).toBe(
      'var(--term-2)',
    )
  })

  it('redraws only from the line a write changed', () => {
    const pre = document.createElement('pre')
    const output = new TerminalOutput(pre)
    output.write('header\nstep 1\nprogress  0%')
    const [header, step] = pre.querySelectorAll('.term-line')
    output.write('\rprogress 50%')
    output.write('\rprogress 99%')
    const lines = pre.querySelectorAll('.term-line')
    expect(lines[0]).toBe(header)
    expect(lines[1]).toBe(step)
    expect(pre.textContent).toBe('header\nstep 1\nprogress 99%')
    const progress = pre.querySelectorAll('.term-line')[2]
    output.write('\n')
    expect(pre.querySelectorAll('.term-line')[2]).toBe(progress)
    expect(pre.textContent).toBe('header\nstep 1\nprogress 99%\n')
  })

  it('appends status lines and empties the element when made', () => {
    const pre = document.createElement('pre')
    pre.textContent = 'a previous run'
    const output = new TerminalOutput(pre)
    expect(pre.textContent).toBe('')
    expect(output.isEmpty).toBe(true)
    output.write('done\n')
    output.appendStatus(['Process exited with code 2'])
    expect(pre.textContent).toBe('done\nProcess exited with code 2')
  })
})
