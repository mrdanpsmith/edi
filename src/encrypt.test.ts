import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { createBlockEditor, type BlockEditor } from './editor'
import { decryptField, encryptField } from './crypto'
import { promptForEncrypt } from './crypto-dialog'
import { showError } from './bridge'
import { NESTED_BLOCK_REFUSAL, encryptBlockAt, encryptSelection, encryptTarget } from './encrypt'
import { markdownToProse } from './markdown'
import { schema } from './schema'

vi.mock('./crypto-dialog', () => ({
  promptForPassword: vi.fn(),
  promptForNewPassword: vi.fn(),
  promptForEncrypt: vi.fn(),
}))
vi.mock('./bridge', () => ({
  confirmAction: vi.fn(),
  showError: vi.fn(),
}))

const BLOCK = { kind: 'block', label: '' } as const

let editor: BlockEditor | null = null

function open(markdown: string, options: Parameters<typeof createBlockEditor>[2] = {}): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  editor = createBlockEditor(host, markdown, options)
  return editor.getView()
}

function select(view: EditorView, from: string, to: string): void {
  const text = (needle: string, end: boolean): number => {
    let found = -1
    view.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text!.includes(needle)) {
        found = pos + node.text!.indexOf(needle) + (end ? needle.length : 0)
      }
    })
    return found
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, text(from, false), text(to, true))))
}

function encryptedBlocks(view: EditorView): { label: string; content: string }[] {
  const found: { label: string; content: string }[] = []
  view.state.doc.descendants((node) => {
    if (node.type.name === 'encrypted_block') found.push(node.attrs as { label: string; content: string })
  })
  return found
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(promptForEncrypt).mockReset()
  vi.mocked(showError).mockReset()
  vi.mocked(promptForEncrypt).mockImplementation(async ({ kind, initialValue }) => ({
    label: '', value: kind === 'field' ? (initialValue || 'typed') : '', password: 'pw', lockImmediately: true,
  }))
})

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('encryptTarget', () => {
  it('makes a field of an empty selection and of a range within one line', () => {
    const view = open('store pw-secret now\n\nnext')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(encryptTarget(view)).toMatchObject({ kind: 'field', value: '' })
    select(view, 'pw-secret', 'pw-secret')
    expect(encryptTarget(view)).toMatchObject({ kind: 'field', value: 'pw-secret' })
  })

  it('makes a block, keeping the field, of a one-line range that already holds a field', async () => {
    const view = open('this is a behavioral test\n\nafter')
    select(view, 'behavioral', 'behavioral')
    await encryptSelection(view)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.child(0).nodeSize - 1)))
    expect(encryptTarget(view)).toEqual({ kind: 'block', from: 0, to: view.state.doc.child(0).nodeSize })
    await encryptSelection(view)
    const inner = await decryptField(encryptedBlocks(view)[0]!.content, 'pw', BLOCK)
    expect(inner).toMatch(/^this is a !masked\[[^\]]+\] test$/)
  })

  it('makes a block of every top-level block a multi-block selection touches', () => {
    const view = open('one\n\ntwo two\n\nthree\n\nfour')
    select(view, 'wo two', 'thr')
    const second = view.state.doc.child(0).nodeSize
    const fourth = second + view.state.doc.child(1).nodeSize + view.state.doc.child(2).nodeSize
    expect(encryptTarget(view)).toEqual({ kind: 'block', from: second, to: fourth })
  })

  it('leaves out a block the selection only reaches the start of', () => {
    const view = open('one\n\ntwo\n\nthree')
    const startOfThree = view.state.doc.child(0).nodeSize + view.state.doc.child(1).nodeSize + 1
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, startOfThree)))
    expect(encryptTarget(view)).toEqual({ kind: 'block', from: 0, to: startOfThree - 1 })
  })

  it('makes a block of a selected block node and of a range inside a code block', () => {
    const view = open('```\ncode here\n```\n\nafter')
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)))
    expect(encryptTarget(view)).toMatchObject({ kind: 'block', from: 0 })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 5)))
    expect(encryptTarget(view)).toMatchObject({ kind: 'block', from: 0 })
  })

  it('refuses a block over a selection that already holds an encrypted block', async () => {
    const envelope = await encryptField('inner', 'pw', BLOCK)
    const view = open('before\n\n```encrypted\n' + envelope + '\n```\n\nafter')
    select(view, 'before', 'after')
    expect(encryptTarget(view)).toEqual({ kind: 'refused', reason: NESTED_BLOCK_REFUSAL })
  })
})

describe('encryptSelection', () => {
  it('replaces a one-line selection with a field holding it', async () => {
    const view = open('store pw-secret now')
    select(view, 'pw-secret', 'pw-secret')
    expect(await encryptSelection(view)).toBe(true)
    expect(promptForEncrypt).toHaveBeenCalledWith({ kind: 'field', initialValue: 'pw-secret' })
    expect(view.state.doc.textContent).toBe('store  now')
    let field: { content: string } | null = null
    view.state.doc.descendants((node) => {
      if (node.type.name === 'masked_field') field = node.attrs as { content: string }
    })
    expect(await decryptField(field!.content, 'pw', { kind: 'field', label: '' })).toBe('pw-secret')
  })

  it('encrypts the whole of a multi-block selection into one block', async () => {
    const view = open('keep\n\nfirst **bold**\n\n- alpha\n- beta\n\nkeep too')
    select(view, 'first', 'beta')
    expect(await encryptSelection(view)).toBe(true)
    expect(promptForEncrypt).toHaveBeenCalledWith({ kind: 'block' })
    expect(view.state.doc.childCount).toBe(3)
    const [block] = encryptedBlocks(view)
    expect(await decryptField(block!.content, 'pw', BLOCK)).toBe('first **bold**\n\n- alpha\n- beta')
    expect(view.state.doc.child(0).textContent).toBe('keep')
    expect(view.state.doc.child(2).textContent).toBe('keep too')
  })

  it('says why and opens no dialog when the result would nest', async () => {
    const envelope = await encryptField('inner', 'pw', BLOCK)
    const view = open('before\n\n```encrypted\n' + envelope + '\n```\n\nafter')
    select(view, 'before', 'after')
    expect(await encryptSelection(view)).toBe(false)
    expect(showError).toHaveBeenCalledWith(NESTED_BLOCK_REFUSAL)
    expect(promptForEncrypt).not.toHaveBeenCalled()
  })

  it('changes nothing when the dialog is cancelled', async () => {
    vi.mocked(promptForEncrypt).mockResolvedValue(null)
    const view = open('one\n\ntwo')
    select(view, 'one', 'two')
    const before = view.state.doc
    expect(await encryptSelection(view)).toBe(false)
    expect(view.state.doc.eq(before)).toBe(true)
  })
})

describe('labels survive a save and reload', () => {
  // A version 2 envelope is bound to its label as saved, so a label that came back
  // different from the file would lock the secret for good.
  it.each(['Prod "east" keys', 'a `tick` and {braces} [x]', '  spaced  '])('a block labelled %j', async (label) => {
    vi.mocked(promptForEncrypt).mockResolvedValue({ label, value: '', password: 'pw', lockImmediately: true })
    const view = open('one\n\ntwo')
    select(view, 'one', 'two')
    await encryptSelection(view)
    const reloaded = markdownToProse(editor!.getMarkdown(), schema)
    let attrs: { label: string; content: string } | null = null
    reloaded.descendants((node) => {
      if (node.type.name === 'encrypted_block') attrs = node.attrs as { label: string; content: string }
    })
    expect(await decryptField(attrs!.content, 'pw', { kind: 'block', label: attrs!.label })).toBe('one\n\ntwo')
  })

  it.each(['Prod "east"', 'a `tick` (x)'])('a field labelled %j', async (label) => {
    vi.mocked(promptForEncrypt).mockResolvedValue({ label, value: 'v', password: 'pw', lockImmediately: true })
    const view = open('x')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    await encryptSelection(view)
    const reloaded = markdownToProse(editor!.getMarkdown(), schema)
    let attrs: { label: string; content: string } | null = null
    reloaded.descendants((node) => {
      if (node.type.name === 'masked_field') attrs = node.attrs as { label: string; content: string }
    })
    expect(attrs!.label).toBe(label)
    expect(await decryptField(attrs!.content, 'pw', { kind: 'field', label: attrs!.label })).toBe('v')
  })
})

describe('encryptBlockAt', () => {
  it('encrypts the block it was asked about', async () => {
    const view = open('one\n\ntwo')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    const second = view.state.doc.child(0).nodeSize
    expect(await encryptBlockAt(view, second)).toBe(true)
    expect(view.state.doc.child(0).textContent).toBe('one')
    expect(await decryptField(encryptedBlocks(view)[0]!.content, 'pw', BLOCK)).toBe('two')
  })

  it('widens to the selection when the selection reaches into that block', async () => {
    const view = open('one\n\ntwo\n\nthree')
    select(view, 'one', 'two')
    expect(await encryptBlockAt(view, 0)).toBe(true)
    expect(await decryptField(encryptedBlocks(view)[0]!.content, 'pw', BLOCK)).toBe('one\n\ntwo')
    expect(view.state.doc.child(1).textContent).toBe('three')
  })
})

describe('inside an open encrypted block', () => {
  it('refuses to make a block, and still makes a field', async () => {
    const outer = document.createElement('div')
    outer.className = 'encrypted-block-reveal'
    document.body.appendChild(outer)
    editor = createBlockEditor(outer, 'one\n\ntwo', { insideEncryptedBlock: true })
    const view = editor.getView()
    select(view, 'one', 'two')
    expect(encryptTarget(view)).toEqual({ kind: 'refused', reason: NESTED_BLOCK_REFUSAL })
    select(view, 'one', 'one')
    expect(encryptTarget(view)).toMatchObject({ kind: 'field' })
  })

  it('refuses a change that would add an encrypted block, and keeps one already there', async () => {
    const envelope = await encryptField('inner', 'pw', BLOCK)
    const view = open('```encrypted\n' + envelope + '\n```\n\ntext', { insideEncryptedBlock: true })
    expect(encryptedBlocks(view)).toHaveLength(1)
    const pasted = markdownToProse('```encrypted\n' + envelope + '\n```', schema).content
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, pasted))
    expect(encryptedBlocks(view)).toHaveLength(1)
    view.dispatch(view.state.tr.insertText('more ', view.state.doc.content.size - 1))
    expect(view.state.doc.textContent).toContain('more')
  })
})
