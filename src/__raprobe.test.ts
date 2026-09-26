import { expect, it } from 'vitest'

it('has rAF in vitest jsdom env', () => {
  expect(typeof requestAnimationFrame).toBe('function')
})