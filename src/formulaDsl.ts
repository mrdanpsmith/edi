/**
 * Parser and compiler for document-local function definitions.
 *
 * A fenced code block tagged `edi-formula` holds one definition per line:
 *
 *     MYAVG(a, b) = (a + b) / 2
 *     TAX(amount) = ROUND(amount * 0.2, 2)
 *
 * Bodies are expressions over the parameters, numbers, the arithmetic
 * operators, and any builtin or other document function. Definitions are
 * compiled to ordinary `FormulaFunction`s and validated collectively: a name
 * that collides with a builtin, repeats another definition, or forms a
 * dependency cycle is rejected (and reported as an issue for the block's
 * inline error state).
 */
import {
  BUILTIN_ENV,
  add,
  applyFunction,
  blank,
  bool,
  compareValues,
  div,
  err,
  invokeFunction,
  isBuiltinName,
  mul,
  neg,
  num,
  pow,
  sub,
  text,
  type CellValue,
  type CellValueThunk,
  type CompareOp,
  type FormulaEnv,
  type FormulaFunction,
} from './formulas'

export interface FormulaDefIssue {
  /** Index of the `edi-formula` source block the issue belongs to. */
  sourceIndex: number
  /** 1-based line within that source. */
  line: number
  name: string
  message: string
}

export interface DocumentFunctions {
  functions: FormulaFunction[]
  issues: FormulaDefIssue[]
}

interface RawDefinition {
  sourceIndex: number
  line: number
  name: string
  params: string[]
  body: string
}

const DEF_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*=\s*(.+)$/
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const CALL_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
const upper = (value: string): string => value.toUpperCase()

/** Cut a `#` comment from a definition line without touching `#` inside a
 * string literal (`F(x) = CONCAT("a#b", x)` keeps the `#`). */
function stripComment(line: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inString) {
      out += ch
      if (ch === '"') {
        if (line[i + 1] === '"') {
          out += line[i + 1]!
          i++
        } else {
          inString = false
        }
      }
      continue
    }
    if (ch === '#') break
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

/** Remove string literals so a dependency scan can't false-positive on `"SUM("`
 * spoken inside a literal. Keeps doubled quotes (`""`) inside the literal. */
function stripStringLiterals(body: string): string {
  return body.replace(/"(?:[^"]|"")*"/g, '')
}

function parseSource(
  source: string,
  sourceIndex: number,
): { defs: RawDefinition[]; issues: FormulaDefIssue[] } {
  const defs: RawDefinition[] = []
  const issues: FormulaDefIssue[] = []
  source.split('\n').forEach((rawLine, index) => {
    const line = index + 1
    const text = stripComment(rawLine).trim()
    if (!text) return
    const match = DEF_RE.exec(text)
    if (!match) {
      issues.push({
        sourceIndex,
        line,
        name: '',
        message: 'Expected "NAME(params) = expression"',
      })
      return
    }
    const name = match[1]!
    const paramText = match[2]!.trim()
    const body = match[3]!.trim()
    const params = paramText ? paramText.split(',').map((param) => param.trim()) : []
    if (params.some((param) => !PARAM_RE.test(param))) {
      issues.push({ sourceIndex, line, name, message: 'Invalid parameter name' })
      return
    }
    if (new Set(params.map(upper)).size !== params.length) {
      issues.push({ sourceIndex, line, name, message: 'Duplicate parameter name' })
      return
    }
    defs.push({ sourceIndex, line, name, params, body })
  })
  return { defs, issues }
}

/**
 * Parse every `edi-formula` source in a document and compile the definitions
 * that survive validation. Builtins are reserved, duplicate names keep their
 * first definition, and definitions that are part of — or depend on — a cycle
 * are dropped with an issue.
 */
export function buildDocumentFunctions(sources: readonly string[]): DocumentFunctions {
  const raw: RawDefinition[] = []
  const issues: FormulaDefIssue[] = []
  sources.forEach((source, sourceIndex) => {
    const parsed = parseSource(source, sourceIndex)
    raw.push(...parsed.defs)
    issues.push(...parsed.issues)
  })

  const byName = new Map<string, RawDefinition>()
  const accepted: RawDefinition[] = []
  for (const def of raw) {
    if (isBuiltinName(def.name)) {
      issues.push({ ...def, message: `"${def.name}" is a built-in and cannot be redefined` })
      continue
    }
    const key = upper(def.name)
    const existing = byName.get(key)
    if (existing) {
      const where =
        existing.sourceIndex === def.sourceIndex
          ? ` on line ${existing.line}`
          : ' in another block'
      issues.push({ ...def, message: `"${def.name}" is already defined${where}` })
      continue
    }
    byName.set(key, def)
    accepted.push(def)
  }

  const names = new Set(accepted.map((def) => upper(def.name)))
  const deps = new Map<string, Set<string>>()
  for (const def of accepted) {
    const calls = new Set<string>()
    for (const match of stripStringLiterals(def.body).matchAll(CALL_RE)) {
      const dep = upper(match[1]!)
      if (names.has(dep)) calls.add(dep)
    }
    deps.set(upper(def.name), calls)
  }

  // Syntax-check every accepted body against the names visible in this
  // document. This is parse-only: it never evaluates, so `x / 0` is fine
  // (the divisor is a parameter) but `ROUNDU(` and `x +` are not. Builtin and
  // document-function names both resolve, so a call across blocks validates.
  if (accepted.length > 0) {
    const validationEnv = makeValidationEnv(accepted)
    for (const def of accepted) {
      const message = validateBody(def.body, def.params, validationEnv)
      if (message) issues.push({ ...def, message })
    }
  }

  // Peel definitions whose dependencies are all resolvable; whatever remains
  // is either inside a cycle or reaches one, so it can never be evaluated.
  const resolved = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const [name, calls] of deps) {
      if (resolved.has(name)) continue
      if ([...calls].every((dep) => resolved.has(dep))) {
        resolved.add(name)
        changed = true
      }
    }
  }

  const functions: FormulaFunction[] = []
  for (const def of accepted) {
    if (!resolved.has(upper(def.name))) {
      issues.push({ ...def, message: `"${def.name}" has a circular definition` })
      continue
    }
    functions.push(makeFormulaFunction(def))
  }
  return { functions, issues }
}

/** A validation environment: builtins plus a stub per accepted document
 * function, so a body can call any function visible in the document. */
function makeValidationEnv(accepted: readonly RawDefinition[]): FormulaEnv {
  const functions = new Map(BUILTIN_ENV.functions)
  for (const def of accepted) {
    functions.set(
      upper(def.name),
      {
        name: def.name,
        category: 'custom' as const,
        signature: '',
        summary: '',
        minArgs: 0,
        maxArgs: Infinity,
        lazy: true,
        call: () => blank(),
      },
    )
  }
  return { functions }
}

/** Syntax-check a definition body without evaluating it. Returns an
 * issue message, or null when the body parses cleanly. */
export function validateBody(
  body: string,
  params: readonly string[],
  env: FormulaEnv,
): string | null {
  const scope = new Map<string, CellValueThunk>()
  for (const param of params) scope.set(param, () => num(0))
  const result = new BodyParser(body, scope, env, true).parse()
  if (result.kind === 'error') return result.hint ?? result.message
  return null
}

/** Number of header-valid definitions on a block's source (used for the
 * `edi-formula` badge count and the live formula-status rendering). */
export function countDefinitions(source: string): number {
  let count = 0
  for (const rawLine of source.split('\n')) {
    const text = stripComment(rawLine).trim()
    if (!text) continue
    if (!DEF_RE.test(text)) continue
    const paramText = DEF_RE.exec(text)![2]!.trim()
    const params = paramText ? paramText.split(',').map((param) => param.trim()) : []
    if (params.some((param) => !PARAM_RE.test(param))) continue
    if (new Set(params.map(upper)).size !== params.length) continue
    count++
  }
  return count
}

function makeFormulaFunction(def: RawDefinition): FormulaFunction {
  const body = def.body.startsWith('=') ? def.body : `= ${def.body}`
  return {
    name: def.name,
    category: 'custom',
    signature: `${def.name}(${def.params.join(', ')})`,
    summary: `Document definition \`${body}\`.`,
    minArgs: def.params.length,
    maxArgs: def.params.length,
    // Every document definition is lazy: its parameters arrive as thunks, so
    // a body like `IF(c, a, b)` (or one built on the lazy builtins) only
    // forces the branches it actually reads.
    lazy: true,
    call(args, ctx): CellValue {
      const scope = new Map<string, CellValueThunk>()
      def.params.forEach((param, index) => {
        const incoming = args[index]
        const thunk: CellValueThunk =
          typeof incoming === 'function' ? incoming : () => incoming ?? blank()
        scope.set(param, memoize(thunk))
      })
      return evaluateBody(def.body, scope, ctx.env)
    },
  }
}

/** Force a parameter at most once: a body that reads a parameter several
 * times (`D(x) = x + x`) computes its argument a single time no matter how
 * often it is forced, and lazily not at all when the body never reads it. */
function memoize(thunk: CellValueThunk): CellValueThunk {
  let done = false
  let value: CellValue | null = null
  return () => {
    if (!done) {
      value = thunk()
      done = true
    }
    return value as CellValue
  }
}

function evaluateBody(
  body: string,
  scope: ReadonlyMap<string, CellValueThunk>,
  env: FormulaEnv,
): CellValue {
  try {
    return new BodyParser(body, scope, env).parse()
  } catch {
    return err('#ERROR!')
  }
}

/** Recursive-descent evaluator for a definition body. Mirrors the main
 * formula parser's precedence so `1 + 2 * 3` and `2 ^ 3 ^ 2` mean the same
 * thing in a body as they do in a cell. */
class BodyParser {
  private pos = 0

  constructor(
    private readonly source: string,
    private readonly scope: ReadonlyMap<string, CellValueThunk>,
    private readonly env: FormulaEnv,
    private readonly validateOnly = false,
  ) {}

  parse(): CellValue {
    const result = this.comparison()
    this.skipWs()
    if (this.pos < this.source.length) {
      return err('#ERROR!', 'Unexpected text in a function body')
    }
    return result
  }

  /** Comparison level, mirroring the cell parser so `x > 5` means the same in
   * a body as in a cell. */
  private comparison(): CellValue {
    let left = this.additive()
    for (;;) {
      this.skipWs()
      const op = this.matchComparisonOp()
      if (!op) return left
      const right = this.additive()
      left = this.validateOnly ? this.mergeValidate(left, right) : compareValues(left, right, op)
    }
  }

  /** In validate-only mode an operator folds to a stub unless one of its
   * operands already hit a syntax error — a swallowed error would let
   * `x + (y`-style bodies (and `x +)` tails) pass a "clean" check. */
  private mergeValidate(left: CellValue, right: CellValue): CellValue {
    if (left.kind === 'error') return left
    if (right.kind === 'error') return right
    return num(0)
  }

  private matchComparisonOp(): CompareOp | null {
    if (this.match('<>')) return '<>'
    if (this.match('<=')) return '<='
    if (this.match('>=')) return '>='
    if (this.match('=')) return '='
    if (this.match('<')) return '<'
    if (this.match('>')) return '>'
    return null
  }

  private additive(): CellValue {
    let left = this.multiplicative()
    for (;;) {
      this.skipWs()
      if (this.match('+')) {
        const right = this.multiplicative()
        left = this.validateOnly ? this.mergeValidate(left, right) : add(left, right)
      } else if (this.match('-')) {
        const right = this.multiplicative()
        left = this.validateOnly ? this.mergeValidate(left, right) : sub(left, right)
      } else {
        return left
      }
    }
  }

  private multiplicative(): CellValue {
    let left = this.unary()
    for (;;) {
      this.skipWs()
      if (this.match('*')) {
        const right = this.unary()
        left = this.validateOnly ? this.mergeValidate(left, right) : mul(left, right)
      } else if (this.match('/')) {
        const right = this.unary()
        left = this.validateOnly ? this.mergeValidate(left, right) : div(left, right)
      } else {
        return left
      }
    }
  }

  private unary(): CellValue {
    this.skipWs()
    if (this.match('-')) {
      const operand = this.unary()
      return this.validateOnly ? this.mergeValidate(operand, num(0)) : neg(operand)
    }
    if (this.match('+')) {
      return this.unary()
    }
    return this.power()
  }

  private power(): CellValue {
    const left = this.atom()
    this.skipWs()
    if (this.match('^')) {
      const exponent = this.unary()
      return this.validateOnly ? this.mergeValidate(left, exponent) : pow(left, exponent)
    }
    return left
  }

  private atom(): CellValue {
    this.skipWs()
    if (this.match('(')) {
      const inner = this.comparison()
      this.skipWs()
      return this.match(')') ? inner : err('#ERROR!', 'Missing ")" in a function body')
    }
    const ch = this.peek()
    if (ch === '"') {
      const value = this.readString()
      if (value === null) return err('#ERROR!', 'Unterminated string literal')
      return text(value)
    }
    if (ch !== undefined && (/[0-9]/.test(ch) || ch === '.')) {
      return num(this.readNumber())
    }
    const start = this.pos
    while (this.pos < this.source.length && /[A-Za-z0-9_]/.test(this.source[this.pos]!)) {
      this.pos++
    }
    const ident = this.source.slice(start, this.pos)
    if (!ident) {
      return err('#ERROR!', 'Unexpected character in a function body')
    }
    this.skipWs()
    if (this.peek() === '(') {
      return this.functionCall(ident)
    }
    const upperIdent = ident.toUpperCase()
    if (upperIdent === 'TRUE') return bool(true)
    if (upperIdent === 'FALSE') return bool(false)
    const param = this.scope.get(ident)
    if (param) {
      if (this.validateOnly) return num(0)
      return param()
    }
    return err('#NAME?', `Unknown name "${ident}" in a function body`)
  }

  private functionCall(name: string): CellValue {
    this.match('(')
    this.skipWs()
    // Only lazy functions receive `() => CellValue` thunks; eager ones get the
    // already-evaluated values, so a cell range or comparison is never parsed
    // twice. Arguments are still parsed eagerly (to walk `pos` past them and
    // validate the commas/close) even for lazy calls; the values are dropped.
    const fn = this.env.functions.get(name.toUpperCase())
    const lazy = fn?.lazy === true
    if (this.peek() === ')') {
      this.pos++
      if (this.validateOnly) return this.validateFunction(name, fn)
      return invokeFunction(name, [], this.env)
    }
    const args: CellValue[] = []
    const argThunks: CellValueThunk[] = []
    for (;;) {
      const start = this.pos
      if (this.validateOnly) {
        const value = this.comparison()
        if (value.kind === 'error') return value
      } else {
        const value = this.comparison()
        if (lazy) {
          const slice = this.source.slice(start, this.pos)
          argThunks.push(() => new BodyParser(slice, this.scope, this.env).parse())
        } else {
          args.push(value)
        }
      }
      this.skipWs()
      if (this.match(',')) {
        continue
      }
      if (this.match(')')) break
      return err('#ERROR!', 'Missing ")" in a function body')
    }
    if (this.validateOnly) return this.validateFunction(name, fn)
    if (lazy) return invokeFunction(name, argThunks, this.env)
    return applyFunction(name, args, this.env)
  }

  /** In validate-only mode, a call resolves to a stub once it is known to
   * exist; the arity and the arguments were already syntax-checked above. */
  private validateFunction(name: string, fn: FormulaFunction | undefined): CellValue {
    if (!fn) return err('#NAME?', `Unknown function "${name}" in a function body`)
    return num(0)
  }

  private readNumber(): number {
    const start = this.pos
    while (this.pos < this.source.length && /[0-9.]/.test(this.source[this.pos]!)) {
      this.pos++
    }
    return Number(this.source.slice(start, this.pos))
  }

  /** A doubled `""` inside a literal is an escaped quote; `null` on an
   * unterminated literal. */
  private readString(): string | null {
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

  private match(op: string): boolean {
    if (this.source.startsWith(op, this.pos)) {
      this.pos += op.length
      return true
    }
    return false
  }

  private peek(): string | undefined {
    return this.source[this.pos]
  }

  private skipWs(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos]!)) {
      this.pos++
    }
  }
}
