import { describe, expect, it } from 'vitest'

import {
  blank,
  bool,
  compareValues,
  dateToSerial,
  dateSerial,
  err,
  formatDate,
  formatNumber,
  num,
  serialToDate,
  setValue,
  text,
  toNumber,
  toText,
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
