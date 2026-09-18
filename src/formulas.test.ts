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
