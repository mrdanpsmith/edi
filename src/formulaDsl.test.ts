import { describe, expect, it } from 'vitest'

import {
  applyFunction,
  blank,
  bool,
  buildFunctionMap,
  err,
  num,
  setValue,
  text,
  type CellValue,
  type FormulaEnv,
  type FormulaFunction,
} from './formulas'
import { buildDocumentFunctions } from './formulaDsl'

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
})
