import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bindFragmentDialog,
  deleteFragment,
  listFragments,
  saveFragment,
} from './fragments'

describe('fragment storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts empty', () => {
    expect(listFragments()).toEqual([])
  })

  it('saves, persists, and sorts fragments by name', () => {
    saveFragment('beta', 'two')
    saveFragment('alpha', 'one')
    saveFragment('beta', 'updated')
    expect(listFragments()).toEqual([
      { name: 'alpha', content: 'one' },
      { name: 'beta', content: 'updated' },
    ])
    expect(localStorage.getItem('edi.fragments')).toBeTruthy()
  })

  it('deletes fragments', () => {
    saveFragment('alpha', 'one')
    saveFragment('beta', 'two')
    deleteFragment('alpha')
    expect(listFragments()).toEqual([{ name: 'beta', content: 'two' }])
  })

  it('ignores malformed stored data', () => {
    localStorage.setItem('edi.fragments', '{not json')
    expect(listFragments()).toEqual([])
    localStorage.setItem('edi.fragments', JSON.stringify([{ name: 'ok' }]))
    expect(listFragments()).toEqual([])
  })
})

describe('bindFragmentDialog', () => {
  function setup() {
    document.body.innerHTML = `
      <dialog id="fragments-dialog">
        <div class="dialog-header">
          <button id="fragments-close" type="button">×</button>
        </div>
        <div class="dialog-body">
          <div class="fragment-save">
            <input id="fragment-name" type="text" />
            <button id="fragment-save" type="button">Save selection</button>
          </div>
          <ul id="fragment-list"></ul>
          <p id="fragment-empty" hidden></p>
        </div>
      </dialog>
    `
    const dialog = document.querySelector<HTMLDialogElement>('#fragments-dialog')!
    dialog.showModal = () => dialog.setAttribute('open', '')
    dialog.close = () => dialog.removeAttribute('open')
    const onInsert = vi.fn()
    const onSaveSelection = vi.fn()
    const api = bindFragmentDialog(dialog, { onInsert, onSaveSelection })
    return { dialog, onInsert, onSaveSelection, api }
  }

  it('renders saved fragments', () => {
    saveFragment('alpha', 'hello world')
    const { dialog, api } = setup()
    api.open()
    const list = dialog.querySelector('#fragment-list')!
    expect(list.querySelectorAll('.fragment-item')).toHaveLength(1)
    expect(list.textContent).toContain('alpha')
    expect(list.textContent).toContain('hello world')
  })

  it('inserts a fragment on click', () => {
    saveFragment('alpha', 'hello')
    const { dialog, onInsert, api } = setup()
    api.open()
    const insert = dialog.querySelector<HTMLButtonElement>('.fragment-insert')!
    insert.click()
    expect(onInsert).toHaveBeenCalledWith('alpha')
  })

  it('deletes a fragment on click', () => {
    saveFragment('alpha', 'hello')
    const { dialog, api } = setup()
    api.open()
    const remove = dialog.querySelector<HTMLButtonElement>('.fragment-delete')!
    remove.click()
    expect(listFragments()).toEqual([])
    expect(dialog.querySelectorAll('.fragment-item')).toHaveLength(0)
  })

  it('saves a new fragment from the name input', () => {
    const { dialog, onSaveSelection } = setup()
    const input = dialog.querySelector<HTMLInputElement>('#fragment-name')!
    input.value = '  my-fragment  '
    const save = dialog.querySelector<HTMLButtonElement>('#fragment-save')!
    save.click()
    expect(onSaveSelection).toHaveBeenCalledWith('my-fragment')
  })

  it('ignores empty names', () => {
    const { dialog, onSaveSelection } = setup()
    const save = dialog.querySelector<HTMLButtonElement>('#fragment-save')!
    save.click()
    expect(onSaveSelection).not.toHaveBeenCalled()
  })

  it('suggests an unused fragment name', () => {
    saveFragment('fragment-1', 'one')
    const { api } = setup()
    api.open()
    const input = document.querySelector<HTMLInputElement>('#fragment-name')!
    expect(input.value).toBe('fragment-2')
  })
})
