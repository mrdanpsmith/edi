/**
 * Formula function registry — the single source of truth for what the
 * spreadsheet parser can call.
 *
 * `spreadsheet.ts` evaluates through a `FormulaEnv` (built from this registry,
 * plus any document-local definitions), and `series.ts` derives its "this token
 * is a function name, not a cell reference" set from `BUILTIN_FUNCTION_NAMES`,
 * so adding or renaming a builtin cannot drift between the evaluator, the
 * reference-shifting code, and the generated documentation.
 */

/** A value flowing through the evaluator. `set` is a range's flattened cells;
 * `error` carries the short Excel-style code in `message` and an optional
 * human-readable `hint` for tooltips. */
export type CellValue =
  | { kind: 'number'; value: number }
  | { kind: 'blank' }
  | { kind: 'text' }
  | { kind: 'set'; items: CellValue[] }
  | { kind: 'error'; message: string; hint?: string }

export type ErrorCell = Extract<CellValue, { kind: 'error' }>

export type FormulaCategory = 'aggregate' | 'math' | 'custom'

/** The set of callable functions available to one evaluation. Builtins are
 * always present; document definitions add to (but never override) them. */
export interface FormulaEnv {
  readonly functions: ReadonlyMap<string, FormulaFunction>
}

export interface EvalContext {
  readonly env: FormulaEnv
}

export interface FormulaFunction {
  /** Canonical (display) name. */
  readonly name: string
  readonly aliases?: readonly string[]
  readonly category: FormulaCategory
  /** Human-readable call form, e.g. `ROUND(number, digits)`. */
  readonly signature: string
  readonly summary: string
  readonly example?: string
  /** Documented arity. Evaluation stays lenient for builtins so existing
   * formulas that pass extra or no arguments keep their old behavior. */
  readonly minArgs: number
  readonly maxArgs: number
  call(args: readonly CellValue[], ctx: EvalContext): CellValue
}

// --- Value constructors and coercion -------------------------------------

export function num(value: number): CellValue {
  return { kind: 'number', value }
}

export function blank(): CellValue {
  return { kind: 'blank' }
}

export function text(): CellValue {
  return { kind: 'text' }
}

export function setValue(items: CellValue[]): CellValue {
  return { kind: 'set', items }
}

export function err(message: string, hint?: string): ErrorCell {
  return hint === undefined ? { kind: 'error', message } : { kind: 'error', message, hint }
}

export function toNumber(value: CellValue): number | null {
  if (value.kind === 'number') {
    return value.value
  }
  if (value.kind === 'blank') {
    return 0
  }
  return null
}

/**
 * Flatten the numeric values of aggregate arguments, descending into `set`
 * (range) values. Text and blank values are skipped; an error propagates as
 * the error value itself.
 */
export function collectNumbers(args: readonly CellValue[]): number[] | ErrorCell {
  const out: number[] = []
  for (const arg of args) {
    if (arg.kind === 'error') {
      return arg
    }
    if (arg.kind === 'number') {
      out.push(arg.value)
      continue
    }
    if (arg.kind === 'set') {
      for (const item of arg.items) {
        if (item.kind === 'error') {
          return item
        }
        if (item.kind === 'number') {
          out.push(item.value)
        }
      }
    }
  }
  return out
}

// --- Arithmetic on evaluated values --------------------------------------

function binary(
  left: CellValue,
  right: CellValue,
  op: (a: number, b: number) => number,
  divZero = false,
): CellValue {
  if (left.kind === 'error') {
    return left
  }
  if (right.kind === 'error') {
    return right
  }
  if (left.kind === 'set' || right.kind === 'set') {
    return err('#VALUE!')
  }
  const a = toNumber(left)
  const b = toNumber(right)
  if (a === null || b === null) {
    return err('#VALUE!')
  }
  if (divZero && b === 0) {
    return err('#DIV/0!', 'Division by zero')
  }
  const result = op(a, b)
  return Number.isFinite(result) ? num(result) : err('#VALUE!')
}

export const add = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a + b)
export const sub = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a - b)
export const mul = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a * b)
export const div = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a / b, true)
export const pow = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a ** b)

export function neg(value: CellValue): CellValue {
  if (value.kind === 'error') {
    return value
  }
  const n = toNumber(value)
  if (n === null) {
    return err('#VALUE!')
  }
  return num(-n)
}

// --- Builtin call bodies --------------------------------------------------

function sumCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.reduce((a, b) => a + b, 0))
}

function averageCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  if (values.length === 0) return err('#DIV/0!', 'No numbers to average')
  return num(values.reduce((a, b) => a + b, 0) / values.length)
}

function minCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.length === 0 ? 0 : Math.min(...values))
}

function maxCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.length === 0 ? 0 : Math.max(...values))
}

function countCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.length)
}

function productCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.reduce((a, b) => a * b, 1))
}

/** Read the single numeric first argument shared by the unary math builtins. */
function firstNumber(args: readonly CellValue[]): number | ErrorCell {
  const first = args[0]
  if (!first) return err('#VALUE!', 'Expected a number')
  if (first.kind === 'error') return first
  const value = toNumber(first)
  if (value === null) return err('#VALUE!', 'Expected a number')
  return value
}

function absCall(args: readonly CellValue[]): CellValue {
  const value = firstNumber(args)
  if (typeof value !== 'number') return value
  return num(Math.abs(value))
}

function sqrtCall(args: readonly CellValue[]): CellValue {
  const value = firstNumber(args)
  if (typeof value !== 'number') return value
  if (value < 0) return err('#VALUE!', 'Square root of a negative number')
  return num(Math.sqrt(value))
}

function roundCall(args: readonly CellValue[]): CellValue {
  const value = firstNumber(args)
  if (typeof value !== 'number') return value
  const digits = args.length > 1 ? (toNumber(args[1]!) ?? 0) : 0
  const factor = 10 ** digits
  return num((Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor)
}

// --- Builtin registry -----------------------------------------------------

export const BUILTIN_FORMULAS: readonly FormulaFunction[] = [
  {
    name: 'SUM',
    category: 'aggregate',
    signature: 'SUM(number, …)',
    summary: 'Adds numbers, cell references, and ranges.',
    example: '=SUM(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: sumCall,
  },
  {
    name: 'AVERAGE',
    aliases: ['AVG'],
    category: 'aggregate',
    signature: 'AVERAGE(number, …)',
    summary: 'Arithmetic mean of the numbers and ranges.',
    example: '=AVERAGE(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: averageCall,
  },
  {
    name: 'MIN',
    category: 'aggregate',
    signature: 'MIN(number, …)',
    summary: 'Smallest of the numbers and ranges (0 when none).',
    example: '=MIN(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: minCall,
  },
  {
    name: 'MAX',
    category: 'aggregate',
    signature: 'MAX(number, …)',
    summary: 'Largest of the numbers and ranges (0 when none).',
    example: '=MAX(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: maxCall,
  },
  {
    name: 'COUNT',
    category: 'aggregate',
    signature: 'COUNT(value, …)',
    summary: 'How many numeric values the arguments and ranges hold.',
    example: '=COUNT(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: countCall,
  },
  {
    name: 'PRODUCT',
    category: 'aggregate',
    signature: 'PRODUCT(number, …)',
    summary: 'Multiplies the numbers and ranges together (1 when none).',
    example: '=PRODUCT(B2:B4)',
    minArgs: 0,
    maxArgs: Infinity,
    call: productCall,
  },
  {
    name: 'ABS',
    category: 'math',
    signature: 'ABS(number)',
    summary: 'Absolute value of a number.',
    example: '=ABS(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: absCall,
  },
  {
    name: 'SQRT',
    category: 'math',
    signature: 'SQRT(number)',
    summary: 'Square root of a non-negative number.',
    example: '=SQRT(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: sqrtCall,
  },
  {
    name: 'ROUND',
    category: 'math',
    signature: 'ROUND(number, [digits])',
    summary: 'Rounds a number to the given decimal places (default 0).',
    example: '=ROUND(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: roundCall,
  },
]

/** Every builtin name and alias, uppercase — the canonical "is this token a
 * known function name?" set used by reference shifting and definition
 * validation. */
export const BUILTIN_FUNCTION_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_FORMULAS.flatMap((fn) => [fn.name, ...(fn.aliases ?? [])]).map((name) =>
    name.toUpperCase(),
  ),
)

export function isBuiltinName(name: string): boolean {
  return BUILTIN_FUNCTION_NAMES.has(name.toUpperCase())
}

/**
 * Build the callable lookup: builtins first, then `defs`. A definition whose
 * name or alias is a builtin is ignored, so builtins can never be overridden;
 * document definitions (which are validated before they reach here) take
 * precedence over one another in iteration order.
 */
export function buildFunctionMap(
  defs: Iterable<FormulaFunction> = [],
): Map<string, FormulaFunction> {
  const map = new Map<string, FormulaFunction>()
  for (const fn of BUILTIN_FORMULAS) {
    map.set(fn.name.toUpperCase(), fn)
    for (const alias of fn.aliases ?? []) {
      map.set(alias.toUpperCase(), fn)
    }
  }
  for (const fn of defs) {
    const keys = [fn.name, ...(fn.aliases ?? [])]
    if (keys.some((key) => isBuiltinName(key))) continue
    for (const key of keys) {
      map.set(key.toUpperCase(), fn)
    }
  }
  return map
}

/** The builtins-only environment; the default for every `solve` call. */
export const BUILTIN_ENV: FormulaEnv = { functions: buildFunctionMap() }

/** Resolve and invoke a function by name, case-insensitively. */
export function applyFunction(
  name: string,
  args: readonly CellValue[],
  env: FormulaEnv,
): CellValue {
  const fn = env.functions.get(name.toUpperCase())
  if (!fn) {
    return err('#NAME?', `Unknown function "${name}"`)
  }
  return fn.call(args, { env })
}
