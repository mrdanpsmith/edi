/**
 * The lexical half of the two recursive-descent formula parsers: the cell
 * parser (`spreadsheet.ts`, which reads `=B2*2`) and the document-definition
 * body parser (`formulaDsl.ts`, which reads the right-hand side of
 * `MYAVG(a, b) = (a + b) / 2`).
 *
 * The two grammars are deliberately the same — a definition body has to mean in
 * a body exactly what it means in a cell, which is what `formulaDsl.ts`'s
 * "Mirrors the main formula parser's precedence" is about — so the scanner is
 * one thing. What they do *not* share is what a token means: the cell parser
 * resolves `B2` against a grid, the body parser resolves a name against its
 * parameter scope, and only the body parser can run in validate-only mode.
 * That lives in each subclass's `atom` and `comparison`; everything below is
 * pure scanning over the source text and has no opinion about either.
 *
 * Keeping one scanner is what stops the two from drifting: `""` inside a string
 * literal, `<=` before `<`, or whitespace handling are one decision, made once.
 */
import type { CompareOp } from './formulas'

export abstract class FormulaScanner {
  /** Offset into `source`; advanced by every reader below. */
  protected pos = 0

  constructor(protected readonly source: string) {}

  /** Consume `op` if it is next, advancing past it. */
  protected match(op: string): boolean {
    if (this.source.startsWith(op, this.pos)) {
      this.pos += op.length
      return true
    }
    return false
  }

  protected peek(): string | undefined {
    return this.source[this.pos]
  }

  protected skipWs(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos]!)) {
      this.pos++
    }
  }

  /** Consume a run of digits and `.`; `Number` of the empty run is 0, which is
   * what `atom` wants when it has already decided this is not a number. */
  protected readNumber(): number {
    const start = this.pos
    while (this.pos < this.source.length && /[0-9.]/.test(this.source[this.pos]!)) {
      this.pos++
    }
    return Number(this.source.slice(start, this.pos))
  }

  /** A doubled `""` inside a literal is an escaped quote; `null` on an
   * unterminated literal (no closing `"`). */
  protected readString(): string | null {
    this.pos++ // opening "
    let out = ''
    let closed = false
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos]!
      if (ch === '"') {
        if (this.source[this.pos + 1] === '"') {
          out += '"'
          this.pos += 2
          continue
        }
        this.pos++
        closed = true
        break
      }
      out += ch
      this.pos++
    }
    return closed ? out : null
  }

  /**
   * Step over one function argument without evaluating it: up to the `,` or
   * `)` that ends it, past nested parentheses and string literals. A lazy
   * function (`IF`, `IFERROR`, …) evaluates its arguments itself, from their
   * source, only when it needs them; evaluating them here as well doubled the
   * work at every level of nesting. False on an unterminated string or a
   * missing `)`.
   */
  protected skipArgument(): boolean {
    let depth = 0
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos]!
      if (ch === '"') {
        if (this.readString() === null) return false
        continue
      }
      if (depth === 0 && (ch === ',' || ch === ')')) return true
      if (ch === '(') depth++
      else if (ch === ')') depth--
      this.pos++
    }
    return false
  }

  /** The six comparison operators, two-character forms first so `<=` is not
   * read as `<` followed by a stray `=`. */
  protected matchComparisonOp(): CompareOp | null {
    if (this.match('<>')) return '<>'
    if (this.match('<=')) return '<='
    if (this.match('>=')) return '>='
    if (this.match('=')) return '='
    if (this.match('<')) return '<'
    if (this.match('>')) return '>'
    return null
  }
}
