/**
 * A run's output as a terminal would show it: colors and the cursor moves that
 * progress output relies on.
 *
 * `TerminalScreen` is the model. It reads the text a program wrote, escape
 * sequences included, and keeps the lines a terminal would be showing: `\r`
 * returns to the start of the line so the next write overwrites it, `\b` steps
 * back, `ESC [ K` erases, `ESC [ A` moves up (multi-line progress bars), and SGR
 * (`ESC [ … m`) sets the color and weight of what follows. Anything else that
 * starts with ESC is read to its end and dropped, so it never shows as text.
 * The parser keeps its state between writes: a sequence split across two
 * chunks still parses.
 *
 * There is no wrapping in the model; the `<pre>` wraps long lines visually,
 * and a `\r` still returns to the start of the logical line.
 *
 * `TerminalOutput` draws a screen into an element, redrawing only the lines a
 * write touched, so a progress bar that rewrites its line many times a second
 * costs one line each time.
 */

/** The 16 ANSI colors are CSS variables (`--term-0` … `--term-15`, in `code.css`). */
type Color = { index: number } | { rgb: string } | null

interface Style {
  readonly fg: Color
  readonly bg: Color
  readonly bold: boolean
  readonly dim: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
  readonly strike: boolean
}

interface Cell {
  readonly ch: string
  readonly style: Style
}

const PLAIN: Style = Object.freeze({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
})

/** The screen height `ESC [ row ; col H` counts from, matching the pty the shell opens. */
export const TERMINAL_ROWS = 24
const TAB_WIDTH = 8

type ParseState = 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' | 'charset'

export class TerminalScreen {
  private lines: Cell[][] = [[]]
  private row = 0
  private col = 0
  private style: Style = PLAIN
  private saved = { row: 0, col: 0 }
  private state: ParseState = 'text'
  private params = ''
  /** The first line changed since `takeDirty`; `Infinity` when none has. */
  private dirtyFrom = 0

  write(text: string): void {
    for (const ch of text) this.feed(ch)
  }

  get lineCount(): number {
    return this.lines.length
  }

  /** The line's text runs, merged where neighbouring cells share a style. */
  segments(row: number): { text: string; style: Style }[] {
    const out: { text: string; style: Style }[] = []
    for (const cell of this.lines[row] ?? []) {
      const last = out[out.length - 1]
      if (last && last.style === cell.style) last.text += cell.ch
      else out.push({ text: cell.ch, style: cell.style })
    }
    return out
  }

  /** The screen's text, with no styling. */
  text(): string {
    return this.lines.map((line) => line.map((cell) => cell.ch).join('')).join('\n')
  }

  /** The first line changed since the last call, or `null` if none has. */
  takeDirty(): number | null {
    const from = this.dirtyFrom
    this.dirtyFrom = Infinity
    return Number.isFinite(from) ? Math.min(from, this.lines.length) : null
  }

  /**
   * Status lines after the output ("Process exited with code 1"), plain and
   * on lines of their own, with the output's trailing blank lines dropped.
   */
  appendStatus(lines: readonly string[]): void {
    this.trimTrailingBlankLines()
    for (const line of lines) {
      if (this.lines.length > 1 || this.lines[0].length > 0) this.newLine()
      this.lines[this.row] = [...line].map((ch) => ({ ch, style: PLAIN }))
      this.col = this.lines[this.row].length
      this.touch(this.row)
    }
  }

  private trimTrailingBlankLines(): void {
    while (this.lines.length > 1 && this.lines[this.lines.length - 1].every((cell) => cell.ch.trim() === '')) {
      this.lines.pop()
    }
    this.row = this.lines.length - 1
    this.col = this.lines[this.row].length
    this.touch(this.row)
  }

  private feed(ch: string): void {
    switch (this.state) {
      case 'text':
        return this.feedText(ch)
      case 'escape':
        return this.feedEscape(ch)
      case 'csi':
        // Parameter and intermediate bytes, then one final byte in @ … ~.
        if (ch >= '@' && ch <= '~') {
          this.state = 'text'
          this.csi(ch, this.params)
        } else {
          this.params += ch
        }
        return
      case 'osc':
        // An operating-system command (a title, a hyperlink's target) ends at
        // BEL or at ST (`ESC \`); none of it is text.
        if (ch === '\x07') this.state = 'text'
        else if (ch === '\x1b') this.state = 'oscEscape'
        return
      case 'oscEscape':
        this.state = ch === '\\' ? 'text' : 'osc'
        return
      case 'charset':
        // `ESC ( B` and friends pick a character set: one more byte, then done.
        this.state = 'text'
        return
    }
  }

  private feedText(ch: string): void {
    switch (ch) {
      case '\x1b':
        this.state = 'escape'
        return
      case '\n':
        // The pty's line discipline sends `\r\n`, which the shell folds to `\n`;
        // a pipe sends `\n` alone. Both mean "the start of the next line".
        this.newLine()
        return
      case '\r':
        this.col = 0
        return
      case '\b':
        this.col = Math.max(0, this.col - 1)
        return
      case '\t':
        this.moveTo(this.row, (Math.floor(this.col / TAB_WIDTH) + 1) * TAB_WIDTH, true)
        return
    }
    // Other C0 controls (BEL, …) and DEL are not printed.
    if (ch < ' ' || ch === '\x7f') return
    this.put(ch)
  }

  private feedEscape(ch: string): void {
    this.state = 'text'
    switch (ch) {
      case '[':
        this.state = 'csi'
        this.params = ''
        return
      case ']':
        this.state = 'osc'
        return
      case '(':
      case ')':
      case '*':
      case '+':
        this.state = 'charset'
        return
      case '7':
        this.saved = { row: this.row, col: this.col }
        return
      case '8':
        this.moveTo(this.saved.row, this.saved.col)
        return
      case 'c':
        this.reset()
        return
    }
    // Any other two-byte sequence (keypad modes, index, …) is dropped.
  }

  private reset(): void {
    this.lines = [[]]
    this.row = 0
    this.col = 0
    this.style = PLAIN
    this.touch(0)
  }

  private csi(final: string, raw: string): void {
    // Private sequences (`ESC [ ? 25 l`, hiding the cursor) change nothing shown.
    if (/^[?<=>]/.test(raw)) return
    const params = raw.split(/[;:]/).map((part) => (part === '' ? NaN : Number(part)))
    const n = (index: number, fallback = 1) => {
      const value = params[index]
      return Number.isFinite(value) && value > 0 ? value : fallback
    }
    switch (final) {
      case 'm':
        this.style = applySgr(this.style, raw === '' ? [0] : params)
        return
      case 'K':
        return this.eraseInLine(n(0, 0))
      case 'J':
        return this.eraseInDisplay(n(0, 0))
      case 'A':
        return this.moveTo(this.row - n(0), this.col)
      case 'B':
        return this.moveTo(this.row + n(0), this.col)
      case 'C':
        return this.moveTo(this.row, this.col + n(0))
      case 'D':
        return this.moveTo(this.row, this.col - n(0))
      case 'E':
        return this.moveTo(this.row + n(0), 0)
      case 'F':
        return this.moveTo(this.row - n(0), 0)
      case 'G':
        return this.moveTo(this.row, n(0) - 1)
      case 'H':
      case 'f': {
        // Rows count from the top of the visible screen, which is the last
        // TERMINAL_ROWS lines of the output.
        const top = Math.max(0, this.lines.length - TERMINAL_ROWS)
        return this.moveTo(top + n(0) - 1, n(1) - 1)
      }
      case 's':
        this.saved = { row: this.row, col: this.col }
        return
      case 'u':
        return this.moveTo(this.saved.row, this.saved.col)
    }
  }

  private eraseInLine(mode: number): void {
    const line = this.lines[this.row]
    if (mode === 0) {
      line.length = Math.min(line.length, this.col)
    } else if (mode === 1) {
      for (let i = 0; i <= this.col && i < line.length; i++) line[i] = { ch: ' ', style: PLAIN }
    } else if (mode === 2) {
      line.length = 0
    }
    this.touch(this.row)
  }

  private eraseInDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseInLine(0)
      this.lines.length = this.row + 1
    } else if (mode === 1) {
      for (let r = 0; r < this.row; r++) this.lines[r] = []
      this.eraseInLine(1)
      this.touch(0)
    } else {
      // Clear the screen (2), and its scrollback (3): everything shown so far.
      this.lines = this.lines.map(() => [])
      this.touch(0)
    }
  }

  /** Moves the cursor, creating the lines it lands on; `pad` writes spaces up to it. */
  private moveTo(row: number, col: number, pad = false): void {
    this.row = Math.max(0, row)
    this.col = Math.max(0, col)
    while (this.lines.length <= this.row) this.lines.push([])
    this.touch(this.row)
    if (pad) {
      const line = this.lines[this.row]
      while (line.length < this.col) line.push({ ch: ' ', style: PLAIN })
    }
  }

  private newLine(): void {
    this.moveTo(this.row + 1, 0)
  }

  private put(ch: string): void {
    const line = this.lines[this.row]
    // A cursor moved past the end of the line leaves blanks behind it.
    while (line.length < this.col) line.push({ ch: ' ', style: PLAIN })
    line[this.col] = { ch, style: this.style }
    this.col += 1
    this.touch(this.row)
  }

  private touch(row: number): void {
    if (row < this.dirtyFrom) this.dirtyFrom = row
  }
}

/** The style after an SGR sequence's parameters. Unknown ones are ignored. */
function applySgr(style: Style, params: number[]): Style {
  const next = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = Number.isFinite(params[i]) ? params[i] : 0
    if (p === 0) Object.assign(next, PLAIN)
    else if (p === 1) next.bold = true
    else if (p === 2) next.dim = true
    else if (p === 3) next.italic = true
    else if (p === 4 || p === 21) next.underline = true
    else if (p === 7) next.inverse = true
    else if (p === 9) next.strike = true
    else if (p === 22) next.bold = next.dim = false
    else if (p === 23) next.italic = false
    else if (p === 24) next.underline = false
    else if (p === 27) next.inverse = false
    else if (p === 29) next.strike = false
    else if (p >= 30 && p <= 37) next.fg = { index: p - 30 }
    else if (p === 39) next.fg = null
    else if (p >= 40 && p <= 47) next.bg = { index: p - 40 }
    else if (p === 49) next.bg = null
    else if (p >= 90 && p <= 97) next.fg = { index: p - 90 + 8 }
    else if (p >= 100 && p <= 107) next.bg = { index: p - 100 + 8 }
    else if (p === 38 || p === 48) {
      const [color, used] = extendedColor(params, i + 1)
      i += used
      if (p === 38) next.fg = color
      else next.bg = color
    }
  }
  // One shared object per distinct style, so a line's cells merge into runs by
  // identity (`segments`) rather than by comparing every field.
  return internStyle(next)
}

/** `5;n` (the 256-color table) or `2;r;g;b`, after a 38 or 48; returns how many params it used. */
function extendedColor(params: number[], at: number): [Color, number] {
  const kind = params[at]
  if (kind === 5) {
    const n = params[at + 1]
    return [Number.isFinite(n) ? color256(n) : null, 2]
  }
  if (kind === 2) {
    // `38:2::r:g:b` carries an empty color-space id before the channels.
    const start = params.length - at >= 5 && !Number.isFinite(params[at + 1]) ? at + 2 : at + 1
    const [r, g, b] = [params[start], params[start + 1], params[start + 2]].map((v) => clampByte(v))
    return [{ rgb: `rgb(${r}, ${g}, ${b})` }, start - at + 3]
  }
  return [null, 0]
}

function clampByte(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value))) : 0
}

function color256(n: number): Color {
  if (n < 0 || n > 255) return null
  if (n < 16) return { index: n }
  if (n >= 232) {
    const level = 8 + (n - 232) * 10
    return { rgb: `rgb(${level}, ${level}, ${level})` }
  }
  const cube = n - 16
  const steps = [0, 95, 135, 175, 215, 255]
  const r = steps[Math.floor(cube / 36)]
  const g = steps[Math.floor(cube / 6) % 6]
  const b = steps[cube % 6]
  return { rgb: `rgb(${r}, ${g}, ${b})` }
}

const styles = new Map<string, Style>([[JSON.stringify(PLAIN), PLAIN]])

function internStyle(style: Style): Style {
  const key = JSON.stringify(style)
  let shared = styles.get(key)
  if (!shared) {
    shared = Object.freeze({ ...style })
    styles.set(key, shared)
  }
  return shared
}

function cssColor(color: Color, fallback: string): string {
  if (color === null) return fallback
  return 'index' in color ? `var(--term-${color.index})` : color.rgb
}

/** The inline CSS for a style, or `''` for plain text. */
export function styleCss(style: Style): string {
  if (style === PLAIN) return ''
  let fg = style.fg
  const bg = style.bg
  // Bold text in the eight base colors shows in their bright half, as most
  // terminals draw it.
  if (style.bold && fg !== null && 'index' in fg && fg.index < 8) fg = { index: fg.index + 8 }
  let fgCss = cssColor(fg, '')
  let bgCss = cssColor(bg, '')
  if (style.inverse) {
    ;[fgCss, bgCss] = [bgCss || 'var(--exec-bg)', fgCss || 'var(--exec-fg)']
  }
  const parts: string[] = []
  if (fgCss) parts.push(`color: ${fgCss}`)
  if (bgCss) parts.push(`background-color: ${bgCss}`)
  if (style.bold) parts.push('font-weight: bold')
  if (style.dim) parts.push('opacity: 0.6')
  if (style.italic) parts.push('font-style: italic')
  const lines = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean)
  if (lines.length) parts.push(`text-decoration: ${lines.join(' ')}`)
  return parts.join('; ')
}

/**
 * A screen drawn into `element`: one `<span>` per line, each but the first
 * starting with `\n`, so the element's `textContent` is the screen's text
 * (which is what the output's Copy button copies).
 */
export class TerminalOutput {
  readonly screen = new TerminalScreen()
  private lineElements: HTMLElement[] = []

  constructor(private readonly element: HTMLElement) {
    element.textContent = ''
  }

  write(text: string): void {
    this.screen.write(text)
    this.render()
  }

  appendStatus(lines: readonly string[]): void {
    this.screen.appendStatus(lines)
    this.render()
  }

  get isEmpty(): boolean {
    return this.screen.text() === ''
  }

  private render(): void {
    const dirty = this.screen.takeDirty()
    if (dirty === null) return
    const from = Math.min(dirty, this.lineElements.length)
    for (const stale of this.lineElements.splice(from)) stale.remove()
    const count = this.screen.lineCount
    for (let row = from; row < count; row++) {
      const line = document.createElement('span')
      line.className = 'term-line'
      // Each line but the first starts with its `\n`, so adding or removing
      // lines below never changes one already drawn.
      if (row > 0) line.append('\n')
      for (const { text, style } of this.screen.segments(row)) {
        const css = styleCss(style)
        if (css) {
          const span = document.createElement('span')
          span.style.cssText = css
          span.textContent = text
          line.append(span)
        } else {
          line.append(text)
        }
      }
      this.element.append(line)
      this.lineElements.push(line)
    }
  }
}
