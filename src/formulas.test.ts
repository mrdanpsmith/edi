import { describe, expect, it } from 'vitest'

import {
  BUILTIN_ENV,
  applyFunction,
  blank,
  bool,
  compareValues,
  dateToSerial,
  dateSerial,
  err,
  formatDate,
  formatNumber,
  invokeFunction,
  num,
  serialToDate,
  setValue,
  text,
  toNumber,
  toText,
  type CellValue,
} from './formulas'

describe('value model', () => {
  it('stores text payloads', () => {
    expect(text('hello')).toEqual({ kind: 'text', value: 'hello' })
    expect(toText(text('hello'))).toBe('hello')
    expect(toText(blank())).toBe('')
  })

  it('coerces the four kinds to numbers Excel-style', () => {
    expect(toNumber(num(5))).toBe(5)
    expect(toNumber(text('5'))).toBe(5)
    expect(toNumber(text('abc'))).toBeNull()
    expect(toNumber(bool(true))).toBe(1)
    expect(toNumber(bool(false))).toBe(0)
    expect(toNumber(blank())).toBe(0)
    expect(toNumber(dateSerial(45292))).toBe(45292)
  })

  it('round-trips true/false and dates through toText', () => {
    expect(toText(bool(true))).toBe('TRUE')
    expect(toText(bool(false))).toBe('FALSE')
    expect(toText(dateSerial(45292))).toBe('2024-01-01')
    expect(toText(dateSerial(45292.606215))).toBe('2024-01-01 14:32:57')
  })

  it('comparison follows Excel: numbers sort before text, numeric text coerces', () => {
    expect(compareValues(num(5), text('a'), '<')).toEqual(bool(true))
    expect(compareValues(num(5), text('a'), '>')).toEqual(bool(false))
    expect(compareValues(text('a'), num(5), '>')).toEqual(bool(true))
    expect(compareValues(num(10), text('2'), '=')).toEqual(bool(false))
    expect(compareValues(text('2'), num(2), '=')).toEqual(bool(true))
    expect(compareValues(num(2), num(2), '<=')).toEqual(bool(true))
    expect(compareValues(text('b'), text('a'), '>=')).toEqual(bool(true))
  })

  it('returns errors when a comparison gets bad operands', () => {
    expect(compareValues(setValue([]), num(1), '<')).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
    expect(compareValues(num(1), err('#REF!'), '=')).toEqual(err('#REF!'))
  })
})

describe('date serials', () => {

  it('round-trips a local date through serial and back', () => {
    const date = new Date(2000, 0, 1, 2, 3, 4)
    const serial = dateToSerial(date)
    expect(serialToDate(serial).getTime()).toBe(date.getTime())
  })

  it('formats an integral serial as a bare date', () => {
    expect(formatDate(0)).toBe('1899-12-30')
    expect(formatDate(25569)).toBe('1970-01-01')
    expect(formatDate(45292)).toBe('2024-01-01')
  })

  it('appends a local time when the serial carries a fractional part', () => {
    expect(formatDate(45292 + 14 / 24 + 32 / 1440 + 5 / 86400)).toBe('2024-01-01 14:32:05')
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

describe('logical builtins', () => {
  const env = BUILTIN_ENV

  it('IF picks one branch and never forces the other', () => {
    expect(applyFunction('IF', [bool(true), num(1), err('#VALUE!')], env)).toEqual(num(1))
    expect(applyFunction('IF', [bool(false), err('#VALUE!'), num(2)], env)).toEqual(num(2))
    expect(applyFunction('IF', [num(2), num(1), num(2)], env)).toEqual(num(1))
    expect(applyFunction('IF', [num(0), num(1), num(2)], env)).toEqual(num(2))
    expect(applyFunction('IF', [blank(), num(1), num(2)], env)).toEqual(num(2))
    expect(applyFunction('IF', [text('hello'), num(1), num(2)], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
  })

  it('IF propagates an error in its condition', () => {
    expect(applyFunction('IF', [err('#REF!'), num(1), num(2)], env)).toEqual(err('#REF!'))
  })

  it('IF is genuinely lazy through invokeFunction', () => {
    const bomb = (): CellValue => {
      throw new Error('an unselected branch was evaluated')
    }
    expect(invokeFunction('IF', [() => bool(true), () => num(1), bomb], env)).toEqual(num(1))
    expect(invokeFunction('IF', [() => bool(false), bomb, () => num(2)], env)).toEqual(num(2))
  })

  it('IFERROR returns the value, or the fallback only when it errors', () => {
    expect(applyFunction('IFERROR', [num(7), text('oops')], env)).toEqual(num(7))
    expect(applyFunction('IFERROR', [err('#DIV/0!'), text('oops')], env)).toEqual(text('oops'))
    expect(applyFunction('IFERROR', [text('ok'), blank()], env)).toEqual(text('ok'))
  })

  it('IFS returns the value after the first TRUE condition', () => {
    expect(
      applyFunction('IFS', [bool(false), num(1), bool(true), num(2), bool(true), num(3)], env),
    ).toEqual(num(2))
    expect(applyFunction('IFS', [num(1), num(2)], env)).toEqual(num(2))
    expect(applyFunction('IFS', [bool(true), text('a')], env)).toEqual(text('a'))
  })

  it('IFS reports #N/A! when no condition matches', () => {
    expect(applyFunction('IFS', [bool(false), num(1), bool(false), num(2)], env)).toMatchObject({
      kind: 'error',
      message: '#N/A!',
    })
    expect(applyFunction('IFS', [err('#REF!'), num(1), bool(true), num(2)], env)).toEqual(
      err('#REF!'),
    )
  })

  it('IFS skips forced work after the match', () => {
    const bomb = (): CellValue => {
      throw new Error('a later branch was evaluated')
    }
    expect(invokeFunction('IFS', [() => bool(true), () => num(7), bomb, () => num(8)], env)).toEqual(
      num(7),
    )
  })

  it('SWITCH matches case-insensitively and supports a default', () => {
    expect(
      applyFunction('SWITCH', [text('red'), text('red'), num(1), text('blue'), num(2)], env),
    ).toEqual(num(1))
    expect(applyFunction('SWITCH', [text('RED'), text('red'), num(1)], env)).toEqual(num(1))
    expect(
      applyFunction(
        'SWITCH',
        [text('x'), text('red'), num(1), text('blue'), num(2), num(9)],
        env,
      ),
    ).toEqual(num(9))
    expect(applyFunction('SWITCH', [text('x'), text('red'), num(1)], env)).toMatchObject({
      kind: 'error',
      message: '#N/A!',
    })
  })

  it('SWITCH coerces numerics and treats blanks as zero', () => {
    expect(applyFunction('SWITCH', [num(5), text('5'), text('five')], env)).toEqual(text('five'))
    expect(applyFunction('SWITCH', [blank(), num(0), text('zero')], env)).toEqual(text('zero'))
    expect(applyFunction('SWITCH', [num(1), text('1'), text('one'), blank(), text('zero')], env)).toEqual(
      text('one'),
    )
  })

  it('SWITCH propagates an error target', () => {
    expect(applyFunction('SWITCH', [err('#VALUE!'), num(1), num(2)], env)).toEqual(err('#VALUE!'))
  })

  it('AND, OR, and NOT reduce their conditions', () => {
    expect(applyFunction('AND', [bool(true), num(2)], env)).toEqual(bool(true))
    expect(applyFunction('AND', [bool(true), num(0)], env)).toEqual(bool(false))
    expect(applyFunction('OR', [bool(false), num(0), num(3)], env)).toEqual(bool(true))
    expect(applyFunction('OR', [bool(false), num(0)], env)).toEqual(bool(false))
    expect(applyFunction('NOT', [bool(true)], env)).toEqual(bool(false))
    expect(applyFunction('NOT', [num(0)], env)).toEqual(bool(true))
    expect(applyFunction('NOT', [blank()], env)).toEqual(bool(true))
  })

  it('AND and OR surface a #VALUE! on uninferable text', () => {
    expect(applyFunction('AND', [bool(true), text('apples')], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
  })

  it('the IS helpers check value kinds', () => {
    expect(applyFunction('ISERROR', [err('#VALUE!')], env)).toEqual(bool(true))
    expect(applyFunction('ISERROR', [num(1)], env)).toEqual(bool(false))
    expect(applyFunction('ISNUMBER', [num(1)], env)).toEqual(bool(true))
    expect(applyFunction('ISNUMBER', [dateSerial(45292)], env)).toEqual(bool(true))
    expect(applyFunction('ISNUMBER', [text('5')], env)).toEqual(bool(false))
    expect(applyFunction('ISNUMBER', [bool(true)], env)).toEqual(bool(false))
    expect(applyFunction('ISTEXT', [text('hi')], env)).toEqual(bool(true))
    expect(applyFunction('ISTEXT', [num(3)], env)).toEqual(bool(false))
    expect(applyFunction('ISBLANK', [blank()], env)).toEqual(bool(true))
    expect(applyFunction('ISBLANK', [num(4)], env)).toEqual(bool(false))
  })
})

describe('text builtins', () => {
  const env = BUILTIN_ENV

  it('CONCAT joins display forms, coercing numbers and booleans', () => {
    expect(applyFunction('CONCAT', [text('a'), num(1), bool(true), blank()], env)).toEqual(
      text('a1TRUE'),
    )
    expect(applyFunction('CONCAT', [num(45292)], env)).toEqual(text('45292'))
    expect(applyFunction('CONCAT', [text(''), text('x')], env)).toEqual(text('x'))
    expect(applyFunction('CONCAT', [dateSerial(45292), text(':'), num(5)], env)).toEqual(
      text('2024-01-01:5'),
    )
  })

  it('CONCAT flattens range values in row-major order', () => {
    expect(
      applyFunction('CONCAT', [setValue([num(1), blank(), text('c'), num(40)])], env),
    ).toEqual(text('1c40'))
  })

  it('CONCATENATE is the same function', () => {
    expect(applyFunction('CONCATENATE', [text('un'), text('do')], env)).toEqual(text('undo'))
  })

  it('CONCAT propagates an error anywhere in its arguments', () => {
    expect(applyFunction('CONCAT', [text('a'), err('#REF!'), text('b')], env)).toEqual(err('#REF!'))
    expect(
      applyFunction('CONCAT', [setValue([num(1), err('#DIV/0!'), num(3)])], env),
    ).toEqual(err('#DIV/0!'))
  })

  it('TEXTJOIN skips empty cells and values when ignoreEmpty is TRUE', () => {
    expect(
      applyFunction('TEXTJOIN', [text(','), bool(true), text('a'), text(''), text('b')], env),
    ).toEqual(text('a,b'))
    expect(
      applyFunction('TEXTJOIN', [text(', '), bool(true), num(1), blank(), text('c')], env),
    ).toEqual(text('1, c'))
  })

  it('TEXTJOIN keeps placeholder holes when ignoreEmpty is FALSE', () => {
    expect(
      applyFunction('TEXTJOIN', [text('-'), bool(false), text('a'), blank(), text('b')], env),
    ).toEqual(text('a--b'))
  })

  it('TEXTJOIN flattens ranges and requires a real ignoreEmpty flag', () => {
    expect(
      applyFunction('TEXTJOIN', [text('-'), bool(true), setValue([num(1), blank(), text('c')])], env),
    ).toEqual(text('1-c'))
    expect(
      applyFunction('TEXTJOIN', [text('-'), text('apples'), text('x')], env),
    ).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
  })

  it('LEN counts characters of the display form', () => {
    expect(applyFunction('LEN', [text('hello')], env)).toEqual(num(5))
    expect(applyFunction('LEN', [blank()], env)).toEqual(num(0))
    expect(applyFunction('LEN', [text('')], env)).toEqual(num(0))
    expect(applyFunction('LEN', [num(1234)], env)).toEqual(num(4))
    expect(applyFunction('LEN', [bool(true)], env)).toEqual(num(4)) // "TRUE"
  })

  it('UPPER and LOWER case-shift text and numbers', () => {
    expect(applyFunction('UPPER', [text('Hello')], env)).toEqual(text('HELLO'))
    expect(applyFunction('LOWER', [text('Hello')], env)).toEqual(text('hello'))
    expect(applyFunction('UPPER', [num(123)], env)).toEqual(text('123'))
  })

  it('TRIM trims the ends and collapses inner whitespace runs', () => {
    expect(applyFunction('TRIM', [text('  a   b  ')], env)).toEqual(text('a b'))
    expect(applyFunction('TRIM', [text('')], env)).toEqual(text(''))
  })

  it('LEFT defaults to one character and slices beyond the end safely', () => {
    expect(applyFunction('LEFT', [text('hello')], env)).toEqual(text('h'))
    expect(applyFunction('LEFT', [text('hello'), num(2)], env)).toEqual(text('he'))
    expect(applyFunction('LEFT', [text('hello'), num(0)], env)).toEqual(text(''))
    expect(applyFunction('LEFT', [text('hello'), num(99)], env)).toEqual(text('hello'))
    expect(applyFunction('LEFT', [num(12345), num(2)], env)).toEqual(text('12'))
    expect(applyFunction('LEFT', [text('hello'), num(-1)], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
  })

  it('RIGHT defaults to one character and handles a zero count', () => {
    expect(applyFunction('RIGHT', [text('hello')], env)).toEqual(text('o'))
    expect(applyFunction('RIGHT', [text('hello'), num(2)], env)).toEqual(text('lo'))
    expect(applyFunction('RIGHT', [text('hello'), num(0)], env)).toEqual(text(''))
    expect(applyFunction('RIGHT', [text('hello'), num(99)], env)).toEqual(text('hello'))
  })

  it('MID is 1-based and clamps out-of-range starts and lengths to Excel behavior', () => {
    expect(applyFunction('MID', [text('hello'), num(2), num(3)], env)).toEqual(text('ell'))
    expect(applyFunction('MID', [text('hello'), num(1), num(99)], env)).toEqual(text('hello'))
    expect(applyFunction('MID', [text('hello'), num(6), num(1)], env)).toEqual(text(''))
    expect(applyFunction('MID', [text('hello'), num(3), num(0)], env)).toEqual(text(''))
    expect(applyFunction('MID', [text('hello'), num(0), num(2)], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
    expect(applyFunction('MID', [text('hello'), num(2), num(-1)], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
  })

  it('REPT repeats, empties on zero, and caps its result like Excel', () => {
    expect(applyFunction('REPT', [text('ab'), num(3)], env)).toEqual(text('ababab'))
    expect(applyFunction('REPT', [text('a'), num(0)], env)).toEqual(text(''))
    expect(applyFunction('REPT', [text('a'), num(-1)], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
    expect(applyFunction('REPT', [text('ab'), num(20000)], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
  })

  it('SUBSTITUTE replaces all occurrences by default', () => {
    expect(
      applyFunction('SUBSTITUTE', [text('a-b-c'), text('-'), text('/')], env),
    ).toEqual(text('a/b/c'))
    expect(
      applyFunction('SUBSTITUTE', [text('a-b-c'), text('-'), text('')], env),
    ).toEqual(text('abc'))
  })

  it('SUBSTITUTE replaces a single 1-based instance and is case-sensitive', () => {
    expect(
      applyFunction('SUBSTITUTE', [text('a-b-b'), text('b'), text('X'), num(2)], env),
    ).toEqual(text('a-b-X'))
    expect(
      applyFunction('SUBSTITUTE', [text('a-B-b'), text('b'), text('X'), num(1)], env),
    ).toEqual(text('a-B-X'))
  })

  it('SUBSTITUTE leaves the text alone for a bad instance or empty needle', () => {
    expect(applyFunction('SUBSTITUTE', [text('abc'), text('b'), text('X'), num(9)], env)).toEqual(
      text('abc'),
    )
    expect(applyFunction('SUBSTITUTE', [text('abc'), text('b'), text('X'), num(0)], env)).toEqual(
      text('aXc'),
    )
    expect(applyFunction('SUBSTITUTE', [text('abc'), text(''), text('X')], env)).toEqual(text('abc'))
  })

  it('EXACT compares display forms case-sensitively, blanks equal empty strings', () => {
    expect(applyFunction('EXACT', [text('abc'), text('abc')], env)).toEqual(bool(true))
    expect(applyFunction('EXACT', [text('abc'), text('ABC')], env)).toEqual(bool(false))
    expect(applyFunction('EXACT', [num(5), text('5')], env)).toEqual(bool(true))
    expect(applyFunction('EXACT', [blank(), text('')], env)).toEqual(bool(true))
  })

  it('EXACT flattens a range into its concatenated text', () => {
    expect(
      applyFunction('EXACT', [setValue([text('a'), num(1)]), text('a1')], env),
    ).toEqual(bool(true))
  })

  it('VALUE coerces numbers, numeric text, booleans, and dates', () => {
    expect(applyFunction('VALUE', [num(5)], env)).toEqual(num(5))
    expect(applyFunction('VALUE', [text('42')], env)).toEqual(num(42))
    expect(applyFunction('VALUE', [text(' 7.5 ')], env)).toEqual(num(7.5))
    expect(applyFunction('VALUE', [bool(true)], env)).toEqual(num(1))
    expect(applyFunction('VALUE', [bool(false)], env)).toEqual(num(0))
    expect(applyFunction('VALUE', [dateSerial(45292)], env)).toEqual(num(45292))
    expect(applyFunction('VALUE', [blank()], env)).toEqual(num(0))
  })

  it('VALUE errors on text it cannot parse, including an empty string', () => {
    expect(applyFunction('VALUE', [text('abc')], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
    expect(applyFunction('VALUE', [text('')], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
    expect(applyFunction('VALUE', [setValue([num(1)])], env)).toMatchObject({
      kind: 'error',
      message: '#VALUE!',
    })
  })
})

describe('math builtins', () => {
  const env = BUILTIN_ENV

  it('MOD follows the divisor sign like Excel, and guards zero', () => {
    expect(applyFunction('MOD', [num(3), num(2)], env)).toEqual(num(1))
    expect(applyFunction('MOD', [num(-3), num(2)], env)).toEqual(num(1))
    expect(applyFunction('MOD', [num(3), num(-2)], env)).toEqual(num(-1))
    expect(applyFunction('MOD', [num(-3), num(-2)], env)).toEqual(num(-1))
    expect(applyFunction('MOD', [text('5'), num(3)], env)).toEqual(num(2))
    expect(applyFunction('MOD', [num(3), num(0)], env)).toMatchObject({ message: '#DIV/0!' })
  })

  it('INT floors and TRUNC cuts toward zero, honoring digits', () => {
    expect(applyFunction('INT', [num(3.7)], env)).toEqual(num(3))
    expect(applyFunction('INT', [num(-3.7)], env)).toEqual(num(-4))
    expect(applyFunction('TRUNC', [num(3.7)], env)).toEqual(num(3))
    expect(applyFunction('TRUNC', [num(-3.7)], env)).toEqual(num(-3))
    expect(applyFunction('TRUNC', [num(1.2345), num(2)], env)).toEqual(num(1.23))
    expect(applyFunction('TRUNC', [num(1234.5), num(-2)], env)).toEqual(num(1200))
  })

  it('CEILING and FLOOR round on a significance and reject opposite signs', () => {
    expect(applyFunction('CEILING', [num(4.3)], env)).toEqual(num(5))
    expect(applyFunction('CEILING', [num(4.3), num(2)], env)).toEqual(num(6))
    expect(applyFunction('CEILING', [num(-4.3), num(-2)], env)).toEqual(num(-6))
    expect(applyFunction('CEILING', [num(4.3), num(0)], env)).toEqual(num(0))
    expect(applyFunction('FLOOR', [num(4.3)], env)).toEqual(num(4))
    expect(applyFunction('FLOOR', [num(4.3), num(2)], env)).toEqual(num(4))
    expect(applyFunction('FLOOR', [num(-4.3), num(-2)], env)).toEqual(num(-4))
    expect(applyFunction('CEILING', [num(4.3), num(-2)], env)).toMatchObject({ message: '#NUM!' })
    expect(applyFunction('FLOOR', [num(-4.3), num(2)], env)).toMatchObject({ message: '#NUM!' })
  })

  it('ROUNDUP and ROUNDDOWN round away from and toward zero', () => {
    expect(applyFunction('ROUNDUP', [num(3.2), num(0)], env)).toEqual(num(4))
    expect(applyFunction('ROUNDUP', [num(-3.2), num(0)], env)).toEqual(num(-4))
    expect(applyFunction('ROUNDUP', [num(3.14159), num(3)], env)).toEqual(num(3.142))
    expect(applyFunction('ROUNDDOWN', [num(3.9), num(0)], env)).toEqual(num(3))
    expect(applyFunction('ROUNDDOWN', [num(-3.9), num(0)], env)).toEqual(num(-3))
    expect(applyFunction('ROUNDDOWN', [num(3.14159), num(3)], env)).toEqual(num(3.141))
  })

  it('SIGN, POWER, and EXP compute directly', () => {
    expect(applyFunction('SIGN', [num(7)], env)).toEqual(num(1))
    expect(applyFunction('SIGN', [num(-7)], env)).toEqual(num(-1))
    expect(applyFunction('SIGN', [num(0)], env)).toEqual(num(0))
    expect(applyFunction('POWER', [num(2), num(10)], env)).toEqual(num(1024))
    expect(applyFunction('EXP', [num(1)], env)).toEqual(num(Math.E))
  })

  it('LN, LOG, and LOG10 compute and guard their domain', () => {
    expect(applyFunction('LN', [num(Math.E)], env)).toEqual(num(1))
    expect(applyFunction('LOG', [num(8), num(2)], env)).toEqual(num(3))
    expect(applyFunction('LOG', [num(100)], env)).toEqual(num(2))
    expect(applyFunction('LOG10', [num(1000)], env)).toEqual(num(3))
    expect(applyFunction('LN', [num(0)], env)).toMatchObject({ message: '#NUM!' })
    expect(applyFunction('LN', [num(-1)], env)).toMatchObject({ message: '#NUM!' })
    expect(applyFunction('LOG', [num(8), num(1)], env)).toMatchObject({ message: '#DIV/0!' })
  })

  it('PI, RAND, and RANDBETWEEN produce the expected shapes', () => {
    expect(applyFunction('PI', [], env)).toEqual(num(Math.PI))
    const rand = applyFunction('RAND', [], env)
    expect(rand.kind).toBe('number')
    expect((rand as { value: number }).value).toBeGreaterThanOrEqual(0)
    expect((rand as { value: number }).value).toBeLessThan(1)
    const roll = applyFunction('RANDBETWEEN', [num(1), num(6)], env)
    expect(roll.kind).toBe('number')
    expect((roll as { value: number }).value).toBeGreaterThanOrEqual(1)
    expect((roll as { value: number }).value).toBeLessThanOrEqual(6)
    expect(applyFunction('RANDBETWEEN', [num(6), num(1)], env)).toMatchObject({ message: '#NUM!' })
  })
})

describe('aggregate builtins', () => {
  const env = BUILTIN_ENV

  it('MEDIAN sorts and picks the middle, averaging an even count', () => {
    expect(applyFunction('MEDIAN', [setValue([num(3), num(1), num(2)])], env)).toEqual(num(2))
    expect(applyFunction('MEDIAN', [setValue([num(3), num(1), num(2), num(4)])], env)).toEqual(
      num(2.5),
    )
    expect(applyFunction('MEDIAN', [num(5), setValue([num(1), num(3)])], env)).toEqual(num(3))
    expect(applyFunction('MEDIAN', [blank()], env)).toEqual(num(0))
  })

  it('COUNTA counts every non-blank value, including errors', () => {
    expect(applyFunction('COUNTA', [text('a'), num(1), bool(true), blank()], env)).toEqual(num(3))
    expect(
      applyFunction('COUNTA', [setValue([num(1), text(''), blank(), err('#VALUE!')])], env),
    ).toEqual(num(3))
  })

  it('COUNTBLANK counts blanks and empty strings', () => {
    expect(
      applyFunction('COUNTBLANK', [setValue([num(1), blank(), text(''), text('x')])], env),
    ).toEqual(num(2))
    expect(applyFunction('COUNTBLANK', [blank()], env)).toEqual(num(1))
  })

  it('LARGE and SMALL pick ordinal values and error on bad ranks', () => {
    const range = setValue([num(3), num(9), num(4), num(1)])
    expect(applyFunction('LARGE', [range, num(1)], env)).toEqual(num(9))
    expect(applyFunction('LARGE', [range, num(3)], env)).toEqual(num(3))
    expect(applyFunction('SMALL', [range, num(1)], env)).toEqual(num(1))
    expect(applyFunction('SMALL', [range, num(4)], env)).toEqual(num(9))
    expect(applyFunction('LARGE', [range, num(0)], env)).toMatchObject({ message: '#NUM!' })
    expect(applyFunction('LARGE', [range, num(5)], env)).toMatchObject({ message: '#NUM!' })
    expect(applyFunction('LARGE', [setValue([text('a'), blank()]), num(1)], env)).toMatchObject({
      message: '#NUM!',
    })
  })
})

describe('criteria builtins (SUMIF/COUNTIF/AVERAGEIF)', () => {
  const env = BUILTIN_ENV

  it('SUMIF sums the cells meeting operator-prefixed criteria', () => {
    const range = setValue([num(1), num(5), num(9), num(2)])
    expect(applyFunction('SUMIF', [range, text('>4')], env)).toEqual(num(14))
    expect(applyFunction('SUMIF', [range, text('>=5')], env)).toEqual(num(14))
    expect(applyFunction('SUMIF', [range, text('<=5')], env)).toEqual(num(8))
    expect(applyFunction('SUMIF', [range, text('<>5')], env)).toEqual(num(12))
  })

  it('SUMIF sums a separate sum range (same shape) positionally', () => {
    const range = setValue([num(1), num(5), num(9)])
    const sums = setValue([num(10), num(20), num(30)])
    expect(applyFunction('SUMIF', [range, text('>4'), sums], env)).toEqual(num(50))
  })

  it('SUMIF with no match sums to zero', () => {
    expect(applyFunction('SUMIF', [setValue([num(1), num(2)]), text('>9')], env)).toEqual(num(0))
  })

  it('COUNTIF matches text case-insensitively and skips errors', () => {
    const range = setValue([text('Apples'), text('apples'), text('Pears'), blank()])
    expect(applyFunction('COUNTIF', [range, text('apples')], env)).toEqual(num(2))
    const mixed = setValue([text('Apples'), text('Pears'), num(2)])
    expect(applyFunction('COUNTIF', [mixed, text('<>Apples')], env)).toEqual(num(2))
    expect(applyFunction('COUNTIF', [setValue([err('#VALUE!'), num(2)]), text('>0')], env)).toEqual(
      num(1),
    )
  })

  it('AVERAGEIF averages the matching cells and errors when none match', () => {
    const range = setValue([num(1), num(5), num(9)])
    expect(applyFunction('AVERAGEIF', [range, text('>2')], env)).toEqual(num(7))
    expect(applyFunction('AVERAGEIF', [range, text('>9')], env)).toMatchObject({
      message: '#DIV/0!',
    })
  })

  it('a dangling criteria operator is a #VALUE! error', () => {
    expect(applyFunction('SUMIF', [setValue([num(1)]), text('>')], env)).toMatchObject({
      message: '#VALUE!',
    })
  })
})

describe('date/time builtins', () => {
  const env = BUILTIN_ENV

  function display(result: CellValue): string {
    return toText(result)
  }

  it('DATE builds dates and normalizes month/day overflow', () => {
    expect(display(applyFunction('DATE', [num(2024), num(2), num(29)], env))).toBe('2024-02-29')
    expect(display(applyFunction('DATE', [num(2023), num(2), num(29)], env))).toBe('2023-03-01')
    expect(display(applyFunction('DATE', [num(2024), num(13), num(1)], env))).toBe('2025-01-01')
    expect(display(applyFunction('DATE', [num(2024), num(0), num(5)], env))).toBe('2023-12-05')
    expect(display(applyFunction('DATE', [num(1900), num(1), num(0)], env))).toBe('1899-12-31')
  })

  it('DATE maps years 0–1899 by +1900, like Excel', () => {
    expect(display(applyFunction('DATE', [num(0), num(1), num(1)], env))).toBe('1900-01-01')
    expect(display(applyFunction('DATE', [num(100), num(5), num(6)], env))).toBe('2000-05-06')
    expect(display(applyFunction('DATE', [num(1899), num(12), num(31)], env))).toBe('3799-12-31')
    expect(applyFunction('DATE', [num(-1), num(1), num(1)], env)).toMatchObject({ message: '#NUM!' })
    expect(applyFunction('DATE', [num(10000), num(1), num(1)], env)).toMatchObject({
      message: '#NUM!',
    })
  })

  it('YEAR, MONTH, and DAY extract from a date or a plain serial', () => {
    const d = applyFunction('DATE', [num(2024), num(6), num(15)], env)
    expect(applyFunction('YEAR', [d], env)).toEqual(num(2024))
    expect(applyFunction('MONTH', [d], env)).toEqual(num(6))
    expect(applyFunction('DAY', [d], env)).toEqual(num(15))
    expect(applyFunction('DAY', [num(0)], env)).toEqual(num(30))
    expect(applyFunction('YEAR', [num(0)], env)).toEqual(num(1899))
    expect(applyFunction('MONTH', [num(45292)], env)).toEqual(num(1))
  })

  it('HOUR, MINUTE, and SECOND read the time-of-day fraction', () => {
    expect(applyFunction('HOUR', [num(0.5)], env)).toEqual(num(12))
    expect(applyFunction('MINUTE', [num(0.5)], env)).toEqual(num(0))
    expect(applyFunction('HOUR', [num(0.25)], env)).toEqual(num(6))
    expect(applyFunction('SECOND', [num(0.0002)], env)).toEqual(num(17))
    const noon = dateSerial(dateToSerial(new Date(2024, 5, 15, 14, 30, 5)))
    expect(applyFunction('HOUR', [noon], env)).toEqual(num(14))
    expect(applyFunction('MINUTE', [noon], env)).toEqual(num(30))
    expect(applyFunction('SECOND', [noon], env)).toEqual(num(5))
  })

  it('WEEKDAY supports the three Excel type schemes', () => {
    const monday = applyFunction('DATE', [num(2024), num(1), num(1)], env)
    expect(applyFunction('WEEKDAY', [monday], env)).toEqual(num(2))
    expect(applyFunction('WEEKDAY', [monday, num(2)], env)).toEqual(num(1))
    expect(applyFunction('WEEKDAY', [monday, num(3)], env)).toEqual(num(0))
    expect(applyFunction('WEEKDAY', [num(0)], env)).toEqual(num(7))
    expect(applyFunction('WEEKDAY', [monday, num(7)], env)).toMatchObject({ message: '#NUM!' })
  })

  it('DAYS differences serials and truncates toward zero', () => {
    const mar1 = applyFunction('DATE', [num(2024), num(3), num(1)], env)
    const feb1 = applyFunction('DATE', [num(2024), num(2), num(1)], env)
    expect(applyFunction('DAYS', [mar1, feb1], env)).toEqual(num(29))
    expect(applyFunction('DAYS', [num(5), num(6)], env)).toEqual(num(-1))
    expect(applyFunction('DAYS', [num(0.75), num(0)], env)).toEqual(num(0))
  })

  it('EDATE steps whole calendar months, clamping the day to the month end', () => {
    const jan31 = applyFunction('DATE', [num(2024), num(1), num(31)], env)
    expect(display(applyFunction('EDATE', [jan31, num(1)], env))).toBe('2024-02-29')
    const jan31_23 = applyFunction('DATE', [num(2023), num(1), num(31)], env)
    expect(display(applyFunction('EDATE', [jan31_23, num(1)], env))).toBe('2023-02-28')
    expect(display(applyFunction('EDATE', [jan31, num(-1)], env))).toBe('2023-12-31')
    expect(display(applyFunction('EDATE', [jan31, num(14)], env))).toBe('2025-03-31')
  })

  it('EOMONTH lands on the last day of the target month', () => {
    const d = applyFunction('DATE', [num(2024), num(1), num(15)], env)
    expect(display(applyFunction('EOMONTH', [d, num(0)], env))).toBe('2024-01-31')
    expect(display(applyFunction('EOMONTH', [d, num(1)], env))).toBe('2024-02-29')
    expect(display(applyFunction('EOMONTH', [d, num(-1)], env))).toBe('2023-12-31')
  })

  it('TODAY and NOW read the injected clock', () => {
    const clock = { ...BUILTIN_ENV, now: () => new Date(2024, 5, 15, 14, 30, 5) }
    expect(display(applyFunction('TODAY', [], clock))).toBe('2024-06-15')
    expect(display(applyFunction('NOW', [], clock))).toBe('2024-06-15 14:30:05')
  })

  it('a non-numeric serial argument is a #VALUE! error', () => {
    expect(applyFunction('YEAR', [text('abc')], env)).toMatchObject({ message: '#VALUE!' })
    expect(applyFunction('EDATE', [text('abc'), num(1)], env)).toMatchObject({ message: '#VALUE!' })
  })
})

describe('lookup builtins', () => {
  const env = BUILTIN_ENV

  const grid = setValue(
    [text('Apples'), num(10), text('Pears'), num(20), text('Oranges'), num(30)],
    3,
    2,
  )
  const numbers = setValue([num(1), text('x'), num(3), text('y'), num(5), text('z')], 3, 2)

  it('INDEX reads a 1-based row and column, defaulting omitted ones to 1', () => {
    expect(applyFunction('INDEX', [grid, num(2), num(2)], env)).toEqual(num(20))
    expect(applyFunction('INDEX', [grid, num(3), num(1)], env)).toEqual(text('Oranges'))
    expect(applyFunction('INDEX', [grid, num(2)], env)).toEqual(text('Pears'))
    expect(applyFunction('INDEX', [setValue([num(1), num(2), num(3)], 3, 1), num(3)], env)).toEqual(
      num(3),
    )
    expect(
      applyFunction('INDEX', [setValue([num(10), num(20), num(30)], 1, 3), num(2)], env),
    ).toEqual(num(20))
    expect(applyFunction('INDEX', [num(5), num(1), num(1)], env)).toEqual(num(5))
  })

  it('INDEX errors on positions outside the range', () => {
    expect(applyFunction('INDEX', [grid, num(4), num(2)], env)).toMatchObject({ message: '#REF!' })
    expect(applyFunction('INDEX', [grid, num(2), num(3)], env)).toMatchObject({ message: '#REF!' })
    expect(applyFunction('INDEX', [grid, num(0), num(1)], env)).toMatchObject({ message: '#VALUE!' })
    expect(applyFunction('INDEX', [grid, num(-1), num(1)], env)).toMatchObject({ message: '#VALUE!' })
  })

  it('MATCH finds an exact position, case-insensitively', () => {
    expect(applyFunction('MATCH', [text('Pears'), setValue([text('Apples'), text('Pears')], 2, 1), num(0)], env)).toEqual(num(2))
    expect(applyFunction('MATCH', [text('apples'), setValue([text('Apples'), text('Pears')], 2, 1), num(0)], env)).toEqual(num(1))
    expect(applyFunction('MATCH', [num(4), setValue([num(3), num(9), num(4)], 3, 1), num(0)], env)).toEqual(num(3))
    expect(applyFunction('MATCH', [num(20), setValue([num(10), num(20), num(30)], 1, 3), num(0)], env)).toEqual(num(2))
  })

  it('MATCH approximates largest ≤ by default and smallest ≥ with -1', () => {
    expect(applyFunction('MATCH', [num(4), setValue([num(1), num(3), num(5)], 3, 1)], env)).toEqual(num(2))
    expect(applyFunction('MATCH', [num(2), setValue([num(5), num(3), num(1)], 3, 1), num(-1)], env)).toEqual(num(2))
    expect(
      applyFunction('MATCH', [num(4), setValue([num(2), num(4), num(4), num(6)], 4, 1), num(1)], env),
    ).toEqual(num(3))
  })

  it('MATCH errors when nothing matches or the array is not a vector', () => {
    expect(applyFunction('MATCH', [text('x'), setValue([text('a'), text('b')], 2, 1), num(0)], env)).toMatchObject({ message: '#N/A!' })
    expect(applyFunction('MATCH', [num(0), setValue([num(1), num(2)], 2, 1)], env)).toMatchObject({ message: '#N/A!' })
    expect(applyFunction('MATCH', [num(1), setValue([num(1), num(2), num(3), num(4)], 2, 2)], env)).toMatchObject({ message: '#N/A!' })
    expect(applyFunction('MATCH', [num(1), setValue([num(1), num(2)], 2, 1), num(2)], env)).toMatchObject({ message: '#N/A!' })
  })

  it('VLOOKUP exact-matches the first column and returns the indexed column', () => {
    expect(applyFunction('VLOOKUP', [text('Pears'), grid, num(2), bool(false)], env)).toEqual(num(20))
    expect(applyFunction('VLOOKUP', [text('pears'), grid, num(2), bool(false)], env)).toEqual(num(20))
    expect(
      applyFunction('VLOOKUP', [text('Orapes'), grid, num(2), bool(true)], env),
    ).toEqual(num(30))
  })

  it('VLOOKUP approximate-matches the largest value ≤ the lookup', () => {
    expect(applyFunction('VLOOKUP', [num(4), numbers, num(2)], env)).toEqual(text('y'))
    expect(applyFunction('VLOOKUP', [num(1), numbers, num(2)], env)).toEqual(text('x'))
    expect(applyFunction('VLOOKUP', [num(0), numbers, num(2)], env)).toMatchObject({ message: '#N/A!' })
    expect(applyFunction('VLOOKUP', [num(4), numbers, num(2), num(0)], env)).toMatchObject({ message: '#N/A!' })
  })

  it('VLOOKUP guards the index and the range_lookup argument', () => {
    expect(applyFunction('VLOOKUP', [text('Apples'), grid, num(3), bool(false)], env)).toMatchObject({ message: '#REF!' })
    expect(applyFunction('VLOOKUP', [text('Apples'), grid, num(0), bool(false)], env)).toMatchObject({ message: '#VALUE!' })
    expect(
      applyFunction('VLOOKUP', [num(4), numbers, num(2), text('0')], env),
    ).toMatchObject({ message: '#N/A!' })
    expect(applyFunction('VLOOKUP', [num(4), numbers, num(2), text('bogus')], env)).toMatchObject({
      message: '#VALUE!',
    })
  })

  it('HLOOKUP matches the first row and drops down the indexed row', () => {
    const table = setValue([num(10), num(20), num(30), text('a'), text('b'), text('c')], 2, 3)
    expect(applyFunction('HLOOKUP', [num(20), table, num(2), bool(false)], env)).toEqual(text('b'))
    expect(applyFunction('HLOOKUP', [num(25), table, num(2)], env)).toEqual(text('b'))
    expect(applyFunction('HLOOKUP', [num(25), table, num(3), bool(false)], env)).toMatchObject({
      message: '#REF!',
    })
  })
})
