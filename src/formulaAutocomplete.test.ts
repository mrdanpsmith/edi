import { afterEach, describe, expect, it } from 'vitest'

import { BUILTIN_FORMULAS, type FormulaFunction } from './formulas'
import { FormulaAutocomplete, functionToken, matchFunctions } from './formulaAutocomplete'

afterEach(() => {
  document.body.textContent = ''
})

function makeFunction(name: string): FormulaFunction {
  return {
    name,
    category: 'math',
    signature: `${name}(number)`,
    summary: `${name} description`,
    minArgs: 0,
    maxArgs: 1,
    call: () => ({ kind: 'number', value: 0 }),
  }
}

describe('functionToken', () => {
  it('returns the identifier at the caret', () => {
    expect(functionToken('=SUM', 4)).toEqual({ text: 'SUM', start: 1, end: 4 })
  })

  it('finds an identifier after an opening paren or comma', () => {
    expect(functionToken('=SUM(A', 6)).toEqual({ text: 'A', start: 5, end: 6 })
    expect(functionToken('=SUM(A1,B', 9)).toEqual({ text: 'B', start: 8, end: 9 })
  })

  it('returns null until a character follows =, ( or ,', () => {
    expect(functionToken('=', 1)).toBeNull()
    expect(functionToken('=SUM(', 5)).toBeNull()
    expect(functionToken('=SUM(A1,', 8)).toBeNull()
  })

  it('returns null when the identifier is attached to a number', () => {
    expect(functionToken('=2X', 3)).toBeNull()
    expect(functionToken('=1.5R', 6)).toBeNull()
    expect(functionToken('=SUM(B2)+S', 10)).toEqual({ text: 'S', start: 9, end: 10 })
  })
})

describe('matchFunctions', () => {
  it('matches by prefix, case-insensitively', () => {
    const names = matchFunctions(BUILTIN_FORMULAS, 'su').map((fn) => fn.name)
    expect(names).toContain('SUM')
  })

  it('matches aliases', () => {
    const names = matchFunctions(BUILTIN_FORMULAS, 'AVG').map((fn) => fn.name)
    expect(names).toContain('AVERAGE')
  })

  it('matches anywhere in the name', () => {
    const names = matchFunctions(BUILTIN_FORMULAS, 'UM').map((fn) => fn.name)
    expect(names).toContain('SUM')
  })

  it('matches anywhere in the description', () => {
    const names = matchFunctions(BUILTIN_FORMULAS, 'mean').map((fn) => fn.name)
    expect(names).toContain('AVERAGE')
  })

  it('ranks name matches ahead of description-only matches', () => {
    const names = matchFunctions(BUILTIN_FORMULAS, 's').map((fn) => fn.name)
    expect(names.indexOf('SUM')).toBeLessThan(names.indexOf('MIN'))
  })

  it('returns nothing when there are no hits', () => {
    expect(matchFunctions(BUILTIN_FORMULAS, 'zzz')).toEqual([])
  })
})

describe('FormulaAutocomplete', () => {
  function makeInput(value: string, caret = value.length): HTMLInputElement {
    const input = document.createElement('input')
    input.value = value
    document.body.appendChild(input)
    input.setSelectionRange(caret, caret)
    return input
  }

  function makeAutocomplete(functions = BUILTIN_FORMULAS): FormulaAutocomplete {
    return new FormulaAutocomplete(() => functions)
  }

  function itemNames(): string[] {
    return [...document.querySelectorAll('.ss-ac-item-name')].map((el) => el.textContent ?? '')
  }

  function selectedName(): string | null {
    return document.querySelector('.ss-ac-item.is-selected .ss-ac-item-name')?.textContent ?? null
  }

  it('requires a character after = before showing suggestions', () => {
    const empty = makeInput('=')
    makeAutocomplete().refresh(empty)
    expect(document.querySelector('.ss-ac-list')).toBeNull()

    const typing = makeInput('=S')
    makeAutocomplete().refresh(typing)
    expect(document.querySelector('.ss-ac-list')).not.toBeNull()
  })

  it('lists bare names and expands only the selected row', () => {
    const input = makeInput('=S')
    makeAutocomplete().refresh(input)
    const items = document.querySelectorAll('.ss-ac-item')
    expect(items.length).toBeGreaterThan(1)
    expect(itemNames()[0]).toBe('SUM')
    expect(items[0]!.classList.contains('is-selected')).toBe(true)
    expect(items[0]!.querySelector('.ss-ac-item-detail')).not.toBeNull()
    expect(items[1]!.querySelector('.ss-ac-item-detail')).toBeNull()
    expect(document.querySelector('.ss-ac-item-detail .ss-ac-item-summary')!.textContent).toContain(
      'Adds numbers',
    )
  })

  it('caps the list at ten suggestions', () => {
    const many = Array.from({ length: 15 }, (_, i) => makeFunction(`F${i}`))
    const input = makeInput('=F')
    makeAutocomplete(many).refresh(input)
    expect(document.querySelectorAll('.ss-ac-item')).toHaveLength(10)
  })

  it('inserts the selected function on Enter and closes', () => {
    const input = makeInput('=SU')
    const ac = makeAutocomplete()
    ac.refresh(input)
    expect(ac.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
    expect(input.value).toBe('=SUM()')
    expect(input.selectionStart).toBe(5)
    expect(document.querySelector('.ss-ac-list')).toBeNull()
  })

  it('cycles the selection with the arrow keys', () => {
    const input = makeInput('=S')
    const ac = makeAutocomplete()
    ac.refresh(input)
    expect(selectedName()).toBe('SUM')
    ac.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(selectedName()).toBe('SMALL')
    ac.handleKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    expect(selectedName()).toBe('SUM')
  })

  it('selects on hover and accepts on click', () => {
    const input = makeInput('=S')
    makeAutocomplete().refresh(input)
    const second = document.querySelector<HTMLElement>('.ss-ac-item[data-index="1"]')!
    second.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(selectedName()).toBe('SMALL')
    document
      .querySelector<HTMLElement>('.ss-ac-item[data-index="1"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(input.value).toBe('=SMALL()')
  })

  it('dismisses via the close button without inserting', () => {
    const input = makeInput('=SU')
    makeAutocomplete().refresh(input)
    document
      .querySelector('.ss-ac-close')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.ss-ac-list')).toBeNull()
    expect(input.value).toBe('=SU')
  })

  it('closes on Escape without consuming the key', () => {
    const input = makeInput('=SU')
    const ac = makeAutocomplete()
    ac.refresh(input)
    expect(ac.handleKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
    expect(document.querySelector('.ss-ac-list')).toBeNull()
  })

  it('closes when the formula is deleted', () => {
    const input = makeInput('=SU')
    const ac = makeAutocomplete()
    ac.refresh(input)
    input.value = ''
    ac.refresh(input)
    expect(document.querySelector('.ss-ac-list')).toBeNull()
  })
})
