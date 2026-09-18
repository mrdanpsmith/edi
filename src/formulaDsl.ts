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
  add,
  applyFunction,
  blank,
  div,
  err,
  isBuiltinName,
  mul,
  neg,
  num,
  pow,
  sub,
  type CellValue,
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

function parseSource(
  source: string,
  sourceIndex: number,
): { defs: RawDefinition[]; issues: FormulaDefIssue[] } {
  const defs: RawDefinition[] = []
  const issues: FormulaDefIssue[] = []
  source.split('\n').forEach((rawLine, index) => {
    const line = index + 1
    // `#` starts a comment; the definition language has no string literals.
    const text = rawLine.replace(/#.*$/, '').trim()
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
    for (const match of def.body.matchAll(CALL_RE)) {
      const dep = upper(match[1]!)
      if (names.has(dep)) calls.add(dep)
    }
    deps.set(upper(def.name), calls)
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

function makeFormulaFunction(def: RawDefinition): FormulaFunction {
  const body = def.body.startsWith('=') ? def.body : `= ${def.body}`
  return {
    name: def.name,
    category: 'custom',
    signature: `${def.name}(${def.params.join(', ')})`,
    summary: `Document definition \`${body}\`.`,
    minArgs: def.params.length,
    maxArgs: def.params.length,
    call(args, ctx): CellValue {
      const scope = new Map<string, CellValue>()
      def.params.forEach((param, index) => scope.set(param, args[index] ?? blank()))
      return evaluateBody(def.body, scope, ctx.env)
    },
  }
}

function evaluateBody(
  body: string,
  scope: ReadonlyMap<string, CellValue>,
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
    private readonly scope: ReadonlyMap<string, CellValue>,
    private readonly env: FormulaEnv,
  ) {}

  parse(): CellValue {
    const result = this.additive()
    this.skipWs()
    if (this.pos < this.source.length) {
      return err('#ERROR!', 'Unexpected text in a function body')
    }
    return result
  }

  private additive(): CellValue {
    let left = this.multiplicative()
    for (;;) {
      this.skipWs()
      if (this.match('+')) {
        left = add(left, this.multiplicative())
      } else if (this.match('-')) {
        left = sub(left, this.multiplicative())
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
        left = mul(left, this.unary())
      } else if (this.match('/')) {
        left = div(left, this.unary())
      } else {
        return left
      }
    }
  }

  private unary(): CellValue {
    this.skipWs()
    if (this.match('-')) {
      return neg(this.unary())
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
      return pow(left, this.unary())
    }
    return left
  }

  private atom(): CellValue {
    this.skipWs()
    if (this.match('(')) {
      const inner = this.additive()
      this.skipWs()
      return this.match(')') ? inner : err('#ERROR!', 'Missing ")" in a function body')
    }
    const ch = this.peek()
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
    const param = this.scope.get(ident)
    if (param) return param
    return err('#NAME?', `Unknown name "${ident}" in a function body`)
  }

  private functionCall(name: string): CellValue {
    this.match('(')
    const args: CellValue[] = []
    this.skipWs()
    if (this.peek() === ')') {
      this.pos++
      return applyFunction(name, args, this.env)
    }
    for (;;) {
      args.push(this.additive())
      this.skipWs()
      if (this.match(',')) {
        continue
      }
      if (this.match(')')) {
        return applyFunction(name, args, this.env)
      }
      return err('#ERROR!', 'Missing ")" in a function body')
    }
  }

  private readNumber(): number {
    const start = this.pos
    while (this.pos < this.source.length && /[0-9.]/.test(this.source[this.pos]!)) {
      this.pos++
    }
    return Number(this.source.slice(start, this.pos))
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
