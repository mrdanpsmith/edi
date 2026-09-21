import { describe, expect, it } from 'vitest'

import {
  applyFunction,
  blank,
  bool,
  buildFunctionMap,
  dateSerial,
  dateToSerial,
  err,
  num,
  setValue,
  text,
  toText,
  type CellValue,
  type FormulaEnv,
  type FormulaFunction,
} from './formulas'
import { buildDocumentFunctions, countDefinitions, validateBody } from './formulaDsl'

function envFor(functions: readonly FormulaFunction[]): FormulaEnv {
  return { functions: buildFunctionMap(functions) }
}

function call(fn: FormulaFunction, args: CellValue[], env: FormulaEnv): CellValue {
  return fn.call(args, { env })
}

function byName(functions: readonly FormulaFunction[], name: string): FormulaFunction {
  const fn = functions.find((f) => f.name === name)
  if (!fn) throw new Error(`missing function ${name}`)
  return fn
}

describe('buildDocumentFunctions', () => {
  it('compiles a definition and evaluates its parameters', () => {
    const { functions, issues } = buildDocumentFunctions(['MYAVG(a, b) = (a + b) / 2'])
    expect(issues).toEqual([])
    const fn = byName(functions, 'MYAVG')
    expect(fn.category).toBe('custom')
    expect(fn.signature).toBe('MYAVG(a, b)')
    expect(call(fn, [num(2), num(4)], envFor(functions))).toEqual(num(3))
  })

  it('passes ranges through to builtins', () => {
    const { functions } = buildDocumentFunctions(['TOTAL(a) = SUM(a)'])
    const fn = byName(functions, 'TOTAL')
    const range = setValue([num(1), num(2), num(3), blank()])
    expect(call(fn, [range], envFor(functions))).toEqual(num(6))
  })

  it('lets definitions call one another', () => {
    const { functions, issues } = buildDocumentFunctions([
      'INC(x) = x + 1\nDOUBLE(x) = INC(x) * 2',
    ])
    expect(issues).toEqual([])
    expect(call(byName(functions, 'DOUBLE'), [num(3)], envFor(functions))).toEqual(num(8))
  })

  it('respects precedence and unary minus in bodies', () => {
    const { functions } = buildDocumentFunctions(['F(a) = -a + 2 * 3 ^ 2'])
    expect(call(byName(functions, 'F'), [num(1)], envFor(functions))).toEqual(num(17))
  })

  it('calls builtins case-insensitively like a cell formula', () => {
    const { functions } = buildDocumentFunctions(['R(a) = round(a, 2)'])
    expect(call(byName(functions, 'R'), [num(1.2345)], envFor(functions))).toEqual(num(1.23))
  })

  it('treats a missing argument as blank', () => {
    const { functions } = buildDocumentFunctions(['F(a, b) = a + b'])
    expect(call(byName(functions, 'F'), [num(5)], envFor(functions))).toEqual(num(5))
  })

  it('ignores comments and blank lines', () => {
    const { functions, issues } = buildDocumentFunctions([
      '# a comment\n\nF(a) = a * 2 # trailing\n',
    ])
    expect(issues).toEqual([])
    expect(call(byName(functions, 'F'), [num(4)], envFor(functions))).toEqual(num(8))
  })

  it('rejects a definition that collides with a builtin', () => {
    const { functions, issues } = buildDocumentFunctions(['SUM(a) = a'])
    expect(functions).toEqual([])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toMatch(/built-in/)
  })

  it('rejects a duplicate name and keeps the first definition', () => {
    const { functions, issues } = buildDocumentFunctions(['F(x) = x + 1\nF(x) = x + 2'])
    expect(functions.map((f) => f.name)).toEqual(['F'])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.line).toBe(2)
    expect(call(byName(functions, 'F'), [num(1)], envFor(functions))).toEqual(num(2))
  })

  it('rejects a cycle, and anything depending on it', () => {
    const { functions, issues } = buildDocumentFunctions([
      'A(x) = B(x)\nB(x) = A(x)\nC(x) = A(x)\nD(x) = x',
    ])
    expect(functions.map((f) => f.name)).toEqual(['D'])
    expect(issues.map((i) => i.name).sort()).toEqual(['A', 'B', 'C'])
    for (const issue of issues) expect(issue.message).toMatch(/circular/)
  })

  it('rejects direct self-reference', () => {
    const { functions, issues } = buildDocumentFunctions(['A(x) = A(x)'])
    expect(functions).toEqual([])
    expect(issues[0]!.message).toMatch(/circular/)
  })

  it('reports malformed and invalid-parameter lines', () => {
    const { issues } = buildDocumentFunctions(['not a definition', 'F(1x) = 2', 'G(a, a) = a'])
    expect(issues).toHaveLength(3)
    expect(issues.map((i) => i.message)).toEqual([
      'Expected "NAME(params) = expression"',
      'Invalid parameter name',
      'Duplicate parameter name',
    ])
  })

  it('surfaces unknown names and bad syntax as cell errors at call time', () => {
    const { functions } = buildDocumentFunctions(['F(x) = nope + 1', 'G(x) = (x + 1'])
    const env = envFor(functions)
    expect(call(byName(functions, 'F'), [num(1)], env)).toEqual(
      err('#NAME?', 'Unknown name "nope" in a function body'),
    )
    expect(call(byName(functions, 'G'), [num(1)], env)).toEqual(
      err('#ERROR!', 'Missing ")" in a function body'),
    )
  })

  it('tracks the source block index on issues', () => {
    const { issues } = buildDocumentFunctions(['SUM(a) = a', 'F(a) = a'])
    expect(issues[0]!.sourceIndex).toBe(0)
    expect(issues[0]!.line).toBe(1)
  })

  it('keeps `#` and `@` inside string literals while stripping class comment lines', () => {
    const { functions, issues } = buildDocumentFunctions([
      'HASHTAG(x) = "a#b"',
      'AT(x) = "@SUM(x)"',
      'SPACES(x) = x   # trailing comment to drop',
    ])
    expect(issues).toEqual([])
    expect(byName(functions, 'HASHTAG')).toBeDefined()
    expect(call(byName(functions, 'HASHTAG'), [num(0)], envFor(functions))).toEqual(text('a#b'))
    expect(call(byName(functions, 'AT'), [num(1)], envFor(functions))).toEqual(text('@SUM(x)'))
    expect(call(byName(functions, 'SPACES'), [num(3)], envFor(functions))).toEqual(num(3))
  })

  it('the dependency scan ignores function-like text inside string literals', () => {
    // Both bodies are one literal `"…"`; without stripping, `A` would look like
    // it calls SUM and fail to compile.
    const { functions, issues } = buildDocumentFunctions(['A(x) = "SUM("', 'B(x) = "A(x)"'])
    expect(issues).toEqual([])
    expect(functions.map((f) => f.name)).toEqual(['A', 'B'])
    expect(call(byName(functions, 'B'), [num(0)], envFor(functions))).toEqual(text('A(x)'))
  })

  it('supports comparisons, string literals, and TRUE/FALSE in bodies', () => {
    const { functions } = buildDocumentFunctions([
      'F(x) = x > 5',
      'G(x) = x = "done"',
      'H(x) = x = 2', // numeric coercion: =H(2) is TRUE
      'I(x) = (x = TRUE) * 1', // boolean to number via arithmetic
    ])
    expect(call(byName(functions, 'F'), [num(10)], envFor(functions))).toEqual(bool(true))
    expect(call(byName(functions, 'F'), [num(5)], envFor(functions))).toEqual(bool(false))
    expect(call(byName(functions, 'G'), [text('done')], envFor(functions))).toEqual(bool(true))
    expect(call(byName(functions, 'H'), [num(2)], envFor(functions))).toEqual(bool(true))
    expect(call(byName(functions, 'I'), [bool(true)], envFor(functions))).toEqual(num(1))
  })

  it('builds document definitions on the lazy builtins', () => {
    const { functions, issues } = buildDocumentFunctions([
      'MYIF(c, a, b) = IF(c, a, b)',
      'MYCHECK(c) = IF(ISERROR(c), "bad", "ok")',
    ])
    expect(issues).toEqual([])
    const env = envFor(functions)
    expect(applyFunction('MYIF', [bool(true), num(1), err('#VALUE!')], env)).toEqual(num(1))
    expect(applyFunction('MYIF', [bool(false), err('#VALUE!'), num(2)], env)).toEqual(num(2))
    expect(applyFunction('MYCHECK', [err('#REF!')], env)).toEqual(text('bad'))
    expect(applyFunction('MYCHECK', [num(5)], env)).toEqual(text('ok'))
  })

  it('never forces a parameter the body does not read', () => {
    const { functions } = buildDocumentFunctions(['IGNORE(a, b) = b'])
    const env = envFor(functions)
    expect(applyFunction('IGNORE', [err('#VALUE!'), num(5)], env)).toEqual(num(5))
  })

  it('computes a multi-read parameter once and lazily', () => {
    const { functions } = buildDocumentFunctions(['DUP(x) = x + x'])
    const env = envFor(functions)
    expect(applyFunction('DUP', [num(21)], env)).toEqual(num(42))
    expect(applyFunction('DUP', [err('#VALUE!')], env)).toEqual(err('#VALUE!'))
  })

  it('lets a lazy document definition guard another call', () => {
    const { functions } = buildDocumentFunctions([
      'SAFE(c, a, b) = IF(c, a, b)',
      'COMBINED(x) = SAFE(x > 0, x * 2, 1 / 0)',
    ])
    const env = envFor(functions)
    expect(applyFunction('COMBINED', [num(3)], env)).toEqual(num(6))
    expect(applyFunction('COMBINED', [num(0)], env)).toMatchObject({
      kind: 'error',
      message: '#DIV/0!',
    })
  })

  it('calls the text builtins from a definition body', () => {
    const { functions } = buildDocumentFunctions([
      'LABEL(n) = CONCAT("Item ", n)',
      'CODE(name) = UPPER(LEFT(name, 3))',
      'JOINED(a, b) = TEXTJOIN("-", TRUE, a, b)',
    ])
    const env = envFor(functions)
    expect(applyFunction('LABEL', [num(4)], env)).toEqual(text('Item 4'))
    expect(applyFunction('CODE', [text('widget')], env)).toEqual(text('WID'))
    expect(applyFunction('JOINED', [text('x'), blank()], env)).toEqual(text('x'))
  })

  it('calls the math, aggregate, and criteria builtins from a definition body', () => {
    const { functions } = buildDocumentFunctions([
      'DISCOUNT(x) = ROUNDUP(x * 0.125, 2)',
      'SPREAD(xs) = LARGE(xs, 2) - SMALL(xs, 2)',
      'BIG_ONLY(xs) = SUMIF(xs, ">100")',
    ])
    const env = envFor(functions)
    expect(applyFunction('DISCOUNT', [num(10)], env)).toEqual(num(1.25))
    expect(applyFunction('SPREAD', [setValue([num(5), num(1), num(9), num(3)])], env)).toEqual(num(2))
    expect(applyFunction('BIG_ONLY', [setValue([num(50), num(150), num(90)])], env)).toEqual(num(150))
  })

  it('calls the date builtins from a definition body', () => {
    const { functions } = buildDocumentFunctions([
      'ANNIVERSARY(y, m) = DATE(y, m, 1)',
      'QUARTER(d) = MONTH(d)',
      'WEEKNUM(d) = WEEKDAY(d, 2)',
    ])
    const env = envFor(functions)
    const anniversary = applyFunction('ANNIVERSARY', [num(2025), num(1)], env)
    expect(anniversary).toEqual(dateSerial(dateToSerial(new Date(2025, 0, 1))))
    expect(toText(anniversary)).toBe('2025-01-01')
    expect(applyFunction('QUARTER', [anniversary], env)).toEqual(num(1))
    expect(applyFunction('WEEKNUM', [anniversary], env)).toEqual(num(3))
  })

  it('calls the lookup builtins from a definition body (ranges keep their shape)', () => {
    const { functions } = buildDocumentFunctions([
      'COL2(xs, rownum) = INDEX(xs, rownum, 2)',
      'POS(xs, x) = MATCH(x, xs, 0)',
    ])
    const env = envFor(functions)
    const table = setValue(
      [text('Apples'), num(10), text('Pears'), num(20), text('Oranges'), num(30)],
      3,
      2,
    )
    expect(applyFunction('COL2', [table, num(2)], env)).toEqual(num(20))
    expect(applyFunction('POS', [setValue([text('Apples'), text('Pears')], 2, 1), text('Pears')], env)).toEqual(num(2))
  })

  it('calls the capstone builtins from a definition body', () => {
    const { functions } = buildDocumentFunctions([
      'LABEL(n) = CHOOSE(n, "low", "mid", "high")',
      'PRICE(xs, ys, x) = XLOOKUP(x, xs, ys, "n/a")',
    ])
    const env = envFor(functions)
    expect(applyFunction('LABEL', [num(3)], env)).toEqual(text('high'))
    const keys = setValue([text('a'), text('b'), text('c')], 3, 1)
    const vals = setValue([num(10), num(20), num(30)], 3, 1)
    expect(applyFunction('PRICE', [keys, vals, text('b')], env)).toEqual(num(20))
    expect(applyFunction('PRICE', [keys, vals, text('z')], env)).toEqual(text('n/a'))
  })

  it('lazy definitions pass memoized parameters to CHOOSE', () => {
    const { functions } = buildDocumentFunctions([
      'PICK(n, a, b) = CHOOSE(n, a, b)',
    ])
    const env = envFor(functions)
    expect(applyFunction('PICK', [num(1), text('first'), err('#DIV/0!')], env)).toEqual(
      text('first'),
    )
  })
})

describe('body validation (parse-only, no evaluation)', () => {
  function messageFor(source: string): string | null {
    const { issues } = buildDocumentFunctions([source])
    return issues.length > 0 ? issues[0]!.message : null
  }

  it('accepts a well-formed body', () => {
    expect(messageFor('GREET(name) = CONCAT("Hello ", name, "!")')).toBeNull()
  })

  it('does not flag an evaluation hazard like `x / 0`', () => {
    // The divisor is a parameter and valid at runtime; a parse-only check must
    // not report it. (A literal `1 / 0` would be constant-folded at runtime,
    // but static checking has no way to know and must stay silent too.)
    expect(messageFor('D(x) = x / 0')).toBeNull()
  })

  it('resolves a call into another document definition', () => {
    expect(messageFor('RATE(amount) = amount * 0.2\nTAX(amount) = RATE(amount)')).toBeNull()
  })

  it('flags an unterminated string literal', () => {
    expect(messageFor('GREET(name) = CONCAT("Hello, ')).toMatch(/Unterminated string literal/)
  })

  it('flags a missing closing parenthesis', () => {
    expect(messageFor('PART(a, b) = CONCAT(a, b')).toMatch(/Missing "\)"/)
  })

  it('flags an unknown function name in a body', () => {
    expect(messageFor('ROUNDOF(x) = ROUNDU(x, 2)')).toMatch(/Unknown function "ROUNDU"/)
  })

  it('flags an unknown name (not call) in a body', () => {
    expect(messageFor('F(x) = y + 1')).toMatch(/Unknown name "y"/)
  })

  it('flags trailing text after a complete expression', () => {
    expect(messageFor('F(x) = x ,')).toMatch(/Unexpected text/)
  })

  it('does not validate a definition rejected for another reason', () => {
    // The builtin collision is reported once; body validation is not run on it.
    const { issues } = buildDocumentFunctions(['SUM(a) = ROUNDU(a, 2)'])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toMatch(/built-in/)
  })

  it('reports the body issue on the definition line', () => {
    const { issues } = buildDocumentFunctions(['OK(x) = x\nBAD(x) = (x + 1'])
    const bad = issues.find((issue) => issue.name === 'BAD')
    expect(bad?.line).toBe(2)
    expect(bad?.sourceIndex).toBe(0)
  })

  it('keeps invalid definitions callable so cells still fold their error', () => {
    const { functions } = buildDocumentFunctions(['F(x) = (x + 1'])
    expect(functions.map((f) => f.name)).toEqual(['F'])
  })

  it('validateBody returns a message or null for a single body', () => {
    const env = envFor([])
    expect(validateBody('a + 1', ['a'], env)).toBeNull()
    expect(validateBody('a +', ['a'], env)).toMatch(/Unexpected/)
    expect(validateBody('b * 2', ['a'], env)).toMatch(/Unknown name "b"/)
  })
})

describe('countDefinitions', () => {
  it('counts header-valid definitions and skips comments and blanks', () => {
    expect(
      countDefinitions('# a comment\n\nF(a) = a + 1\nG(b) = b # trailing\nnot a def\n'),
    ).toBe(2)
  })

  it('excludes lines with invalid parameters', () => {
    expect(countDefinitions('F(1x) = 2\nF(a, a) = a\nF(x) = x')).toBe(1)
  })
})
