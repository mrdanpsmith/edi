import { afterEach, describe, expect, it, vi } from 'vitest'
import { openHistoryDialog, renderDiff } from './historyDialog'
import type { HistoryVersion } from './files'

afterEach(() => {
  document.body.innerHTML = ''
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const versions: HistoryVersion[] = [
  { id: 'b'.repeat(40), time: 1_700_000_100, message: 'Saved' },
  { id: 'a'.repeat(40), time: 1_700_000_000, message: 'Renamed from old.md' },
]

function open(texts: Record<string, string>, current = 'now\n') {
  const read = vi.fn(async (id: string) => texts[id]!)
  const promise = openHistoryDialog({
    name: 'notes.md',
    current,
    list: async () => versions,
    read,
  })
  return { promise, read }
}

const restoreButton = () => document.querySelector<HTMLButtonElement>('.toolbar-primary')!
const items = () => [...document.querySelectorAll<HTMLButtonElement>('.edi-history-item')]

describe('openHistoryDialog', () => {
  it('lists the versions newest first and shows the newest against the document', async () => {
    open({ ['b'.repeat(40)]: 'then\n', ['a'.repeat(40)]: 'first\n' })
    await flush()
    expect(document.querySelector('.edi-dialog-title')!.textContent).toBe('Version History — notes.md')
    expect(items().map((item) => item.querySelector('.edi-history-message')!.textContent)).toEqual([
      'Saved',
      'Renamed from old.md',
    ])
    expect(items()[0]!.getAttribute('aria-selected')).toBe('true')
    // The version's own lines are the added ones: the diff runs from the
    // document now to the version, which is what Restore would do.
    expect(document.querySelector('.edi-history-added')!.textContent).toBe('+ then')
    expect(document.querySelector('.edi-history-removed')!.textContent).toBe('− now')
  })

  it('shows a heading the old version lacked as missing from it, not added', async () => {
    open({ ['b'.repeat(40)]: 'Body.\n', ['a'.repeat(40)]: 'Body.\n' }, '# Title\n\nBody.\n')
    await flush()
    const removed = [...document.querySelectorAll('.edi-history-removed')].map((line) => line.textContent)
    expect(removed).toContain('− # Title')
    expect(document.querySelector('.edi-history-added')).toBeNull()
  })

  it('resolves with the selected version on Restore', async () => {
    const { promise } = open({ ['b'.repeat(40)]: 'then\n', ['a'.repeat(40)]: 'first\n' })
    await flush()
    items()[1]!.click()
    await flush()
    expect(restoreButton().disabled).toBe(false)
    restoreButton().click()
    await expect(promise).resolves.toBe('first\n')
    expect(document.querySelector('.edi-dialog-overlay')).toBeNull()
  })

  it('cannot restore a version that is the document as it is', async () => {
    open({ ['b'.repeat(40)]: 'now\n', ['a'.repeat(40)]: 'first\n' })
    await flush()
    expect(restoreButton().disabled).toBe(true)
    expect(document.querySelector('.edi-history-empty')!.textContent).toContain('same as the document')
  })

  it('resolves null on Close and on Escape', async () => {
    const first = open({ ['b'.repeat(40)]: 'then\n' })
    await flush()
    document.querySelector<HTMLButtonElement>('.edi-dialog-actions .toolbar-btn')!.click()
    await expect(first.promise).resolves.toBeNull()

    const second = open({ ['b'.repeat(40)]: 'then\n' })
    await flush()
    document
      .querySelector('.edi-history-dialog')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(second.promise).resolves.toBeNull()
  })

  it('says so when there are no versions', async () => {
    openHistoryDialog({ name: 'n.md', current: '', list: async () => [], read: vi.fn() })
    await flush()
    expect(document.querySelector('.edi-history-empty')!.textContent).toContain('No saved versions')
  })
})

describe('renderDiff', () => {
  it('folds long unchanged runs, keeping context around a change', () => {
    const target = document.createElement('div')
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const after = [...lines.slice(0, 10), 'inserted', ...lines.slice(10)]
    renderDiff(target, `${lines.join('\n')}\n`, `${after.join('\n')}\n`)
    expect(target.querySelectorAll('.edi-history-added')).toHaveLength(1)
    const folds = [...target.querySelectorAll('.edi-history-fold')].map((fold) => fold.textContent)
    expect(folds).toEqual(['… 7 unchanged lines', '… 7 unchanged lines'])
  })
})
