import { describe, expect, it } from 'vitest'
import { fillValues, remapFormulaRefs, shiftFormulaRefs } from './series'

describe('fillValues numeric', () => {
  it('duplicates a single value', () => {
    expect(fillValues(['5'], 3)).toEqual(['5', '5', '5'])
  })

  it('extends an integer arithmetic progression', () => {
    expect(fillValues(['1', '2'], 3)).toEqual(['3', '4', '5'])
    expect(fillValues(['1', '3'], 3)).toEqual(['5', '7', '9'])
    expect(fillValues(['10', '20', '30'], 2)).toEqual(['40', '50'])
  })

  it('extends a decreasing progression', () => {
    expect(fillValues(['5', '3'], 3)).toEqual(['1', '-1', '-3'])
  })

  it('extends decimal progressions with matching precision', () => {
    expect(fillValues(['1.5', '2.5'], 2)).toEqual(['3.5', '4.5'])
    expect(fillValues(['1', '1.5'], 3)).toEqual(['2.0', '2.5', '3.0'])
  })

  it('duplicates when the numbers do not move', () => {
    expect(fillValues(['1', '1'], 2)).toEqual(['1', '1'])
  })
})

describe('fillValues embedded numbers', () => {
  it('extends a number in a text pattern', () => {
    expect(fillValues(['Q1', 'Q2'], 3)).toEqual(['Q3', 'Q4', 'Q5'])
    expect(fillValues(['Item 3', 'Item 4'], 2)).toEqual(['Item 5', 'Item 6'])
    expect(fillValues(['1.', '2.'], 2)).toEqual(['3.', '4.'])
  })

  it('preserves zero-padding', () => {
    expect(fillValues(['v01', 'v02'], 2)).toEqual(['v03', 'v04'])
  })
})

describe('fillValues names and cycles', () => {
  it('continues month names cyclically', () => {
    expect(fillValues(['Jan', 'Feb'], 3)).toEqual(['Mar', 'Apr', 'May'])
    expect(fillValues(['November', 'December'], 2)).toEqual(['January', 'February'])
  })

  it('continues weekday names cyclically', () => {
    expect(fillValues(['Mon', 'Tue'], 3)).toEqual(['Wed', 'Thu', 'Fri'])
  })

  it('repeats a text sequence', () => {
    expect(fillValues(['Red', 'Green'], 4)).toEqual(['Red', 'Green', 'Red', 'Green'])
    expect(fillValues(['Red', 'Green', 'Blue'], 2)).toEqual(['Red', 'Green'])
  })
})

describe('shiftFormulaRefs', () => {
  it('moves relative references by the drag delta', () => {
    expect(shiftFormulaRefs('=A1*2', 1, 0)).toBe('=A2*2')
    expect(shiftFormulaRefs('=SUM(B2:C2)', 1, 0)).toBe('=SUM(B3:C3)')
    expect(shiftFormulaRefs('=B1+1', 0, 2)).toBe('=D1+1')
  })

  it('does not move $-fixed references', () => {
    expect(shiftFormulaRefs('=$A$1+B1', 2, 3)).toBe('=$A$1+E3')
    expect(shiftFormulaRefs('=A$1+$B1', 2, 3)).toBe('=D$1+$B3')
  })

  it('clamps at row/column 1', () => {
    expect(shiftFormulaRefs('=B2', -3, -5)).toBe('=A1')
  })

  it('never treats function names as references', () => {
    expect(shiftFormulaRefs('=ROUND(A1,2)', 1, 0)).toBe('=ROUND(A2,2)')
    expect(shiftFormulaRefs('=SUM(A1:A2)', 0, 1)).toBe('=SUM(B1:B2)')
  })
})

describe('remapFormulaRefs', () => {
  it('moves only references that point inside the cut range', () => {
    const src = { r1: 1, c1: 1, r2: 2, c2: 1 }
    expect(remapFormulaRefs('=A1+B1', src, 0, 2)).toBe('=C1+B1')
    expect(remapFormulaRefs('=SUM(A1:A2)', src, 3, 0)).toBe('=SUM(A4:A5)')
  })

  it('preserves $ markers because the referenced cell itself moved', () => {
    const src = { r1: 1, c1: 1, r2: 1, c2: 1 }
    expect(remapFormulaRefs('=$A$1+B2', src, 1, 1)).toBe('=$B$2+B2')
  })

  it('leaves references outside the range and function names alone', () => {
    const src = { r1: 5, c1: 5, r2: 6, c2: 5 }
    expect(remapFormulaRefs('=SUM(A1:A2)+ROUND(E5,2)', src, 1, 1)).toBe('=SUM(A1:A2)+ROUND(F6,2)')
  })
})