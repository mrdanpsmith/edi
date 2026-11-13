import { afterEach, describe, expect, it, vi } from 'vitest'
import { openHistoryDialog, renderDiff } from './historyDialog'
import type { HistoryList, HistoryVersion } from './files'

afterEach(() => {
  document.body.innerHTML = ''
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const versions: HistoryVersion[] = [
  { id: 'b'.repeat(40), time: 1_700_000_100, message: 'Saved' },
  { id: 'a'.repeat(40), time: 1_700_000_000, message: 'Renamed from old.md' },
]

const plain = (list: HistoryVersion[]): HistoryList => ({ versions: list, git: null })

function open(texts: Record<string, string>, current = 'now\n') {
  const read = vi.fn(async (version: HistoryVersion) => texts[version.id]!)
  const promise = openHistoryDialog({
    name: 'notes.md',
    current,
    list: async () => plain(versions),
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

  it('Clear History… clears through the caller and shows the fresh history', async () => {
    let versionsNow = versions
    const clear = vi.fn(async () => {
      versionsNow = [{ id: 'c'.repeat(40), time: 1_700_000_200, message: 'History cleared' }]
      return true
    })
    openHistoryDialog({
      name: 'notes.md',
      current: 'now\n',
      list: async () => plain(versionsNow),
      read: async () => 'now\n',
      clear,
    })
    await flush()
    expect(items()).toHaveLength(2)
    document.querySelector<HTMLButtonElement>('.edi-history-clear')!.click()
    await flush()
    await flush()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(items().map((item) => item.querySelector('.edi-history-message')!.textContent)).toEqual([
      'History cleared',
    ])
  })

  it('keeps the history when the caller declines to clear it', async () => {
    const list = vi.fn(async () => plain(versions))
    openHistoryDialog({ name: 'n.md', current: '', list, read: async () => '', clear: async () => false })
    await flush()
    document.querySelector<HTMLButtonElement>('.edi-history-clear')!.click()
    await flush()
    expect(list).toHaveBeenCalledTimes(1)
    expect(items()).toHaveLength(2)
  })

  it('says so when there are no versions', async () => {
    openHistoryDialog({ name: 'n.md', current: '', list: async () => plain([]), read: vi.fn() })
    await flush()
    expect(document.querySelector('.edi-history-empty')!.textContent).toContain('No saved versions')
  })
})

describe('a git-tracked document', () => {
  const id = (c: string) => c.repeat(40)
  const tracked: HistoryVersion[] = [
    { id: id('e'), time: 500, message: 'Saved', source: 'edi', section: 'uncommitted' },
    { id: id('2'), time: 400, message: 'Second commit', source: 'git', short: '2222222', author: 'Ada' },
    { id: id('d'), time: 350, message: 'Saved', source: 'edi', section: 'between', group: id('1') },
    { id: id('c'), time: 300, message: 'Changed outside Edi', source: 'edi', section: 'between', group: id('1') },
    { id: id('1'), time: 200, message: 'Add notes', source: 'git', short: '1111111', author: 'Ada' },
    { id: id('b'), time: 100, message: 'Opened in Edi', source: 'edi', section: 'beforeGit' },
  ]

  const rows = () =>
    [...document.querySelector('.edi-history-list')!.children].map((row) =>
      row.classList.contains('edi-history-item')
        ? row.querySelector('.edi-history-message')!.textContent
        : row.classList.contains('edi-history-folded')
          ? `[${row.children.length} folded]`
          : row.textContent,
    )

  it('groups Edi snapshots by where they fall among the commits', async () => {
    openHistoryDialog({
      name: 'n.md',
      current: '',
      list: async () => ({ versions: tracked, git: { complete: true, walked: 9 } }),
      read: async () => 'x',
    })
    await flush()
    expect(rows()).toEqual([
      'Not committed',
      'Saved',
      'Second commit',
      '2 Edi snapshots',
      '[2 folded]',
      'Add notes',
      'Before git',
      'Opened in Edi',
    ])
    const commit = document.querySelector('.edi-history-commit')!
    expect(commit.querySelector('.edi-history-commit-id')!.textContent).toBe('2222222 · Ada')
    expect(document.querySelector('.edi-history-searched')).toBeNull()
  })

  it('opens the folded snapshots, and reads a commit from git', async () => {
    const read = vi.fn(async (version: HistoryVersion) => version.message)
    openHistoryDialog({
      name: 'n.md',
      current: '',
      list: async () => ({ versions: tracked, git: { complete: true, walked: 9 } }),
      read,
    })
    await flush()
    const folded = document.querySelector<HTMLElement>('.edi-history-folded')!
    const toggle = document.querySelector<HTMLButtonElement>('.edi-history-fold-toggle')!
    expect(folded.hidden).toBe(true)
    toggle.click()
    expect(folded.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    document.querySelector<HTMLButtonElement>('.edi-history-commit')!.click()
    await flush()
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ id: id('2'), source: 'git' }))
  })

  it('says the search stopped, rather than that there is nothing, when it found no commit', async () => {
    openHistoryDialog({
      name: 'n.md',
      current: '',
      list: async () => ({ versions: [], git: { complete: false, walked: 4475 } }),
      read: async () => 'x',
    })
    await flush()
    expect(document.querySelector('.edi-history-empty')!.textContent).toContain(
      `most recent ${(4475).toLocaleString()} commits searched`,
    )
  })

  it('says how far it searched when the walk stopped early', async () => {
    openHistoryDialog({
      name: 'n.md',
      current: '',
      list: async () => ({ versions: tracked.slice(0, 2), git: { complete: false, walked: 1200 } }),
      read: async () => 'x',
    })
    await flush()
    expect(document.querySelector('.edi-history-searched')!.textContent).toBe(
      `Searched the most recent ${(1200).toLocaleString()} commits`,
    )
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
