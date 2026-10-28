import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  document.title = ''
})

describe('main module', () => {
  it('has no boot side effects on import', async () => {
    vi.resetModules()
    await import('./main')
    expect(document.title).toBe('')
    expect(document.querySelector<HTMLElement>('#app')?.dataset.view).toBeUndefined()
    expect(document.querySelector('#tabbar')).toBeNull()
  })
})
