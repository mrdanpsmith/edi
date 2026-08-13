const FRAGMENTS_KEY = 'edi.fragments'

export interface Fragment {
  name: string
  content: string
}

export interface FragmentCallbacks {
  onInsert(name: string): void
  onSaveSelection(name: string): void
}

export function listFragments(): Fragment[] {
  const raw = localStorage.getItem(FRAGMENTS_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .filter(
        (entry): entry is Fragment =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Fragment).name === 'string' &&
          typeof (entry as Fragment).content === 'string',
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function saveFragment(name: string, content: string): Fragment[] {
  const fragments = listFragments().filter((fragment) => fragment.name !== name)
  fragments.push({ name, content })
  fragments.sort((a, b) => a.name.localeCompare(b.name))
  localStorage.setItem(FRAGMENTS_KEY, JSON.stringify(fragments))
  return fragments
}

export function deleteFragment(name: string): Fragment[] {
  const fragments = listFragments().filter((fragment) => fragment.name !== name)
  localStorage.setItem(FRAGMENTS_KEY, JSON.stringify(fragments))
  return fragments
}

export function bindFragmentDialog(
  dialog: HTMLDialogElement,
  callbacks: FragmentCallbacks,
): { open(): void } {
  const list = dialog.querySelector<HTMLUListElement>('#fragment-list')
  const empty = dialog.querySelector<HTMLElement>('#fragment-empty')
  const nameInput = dialog.querySelector<HTMLInputElement>('#fragment-name')
  const saveButton = dialog.querySelector<HTMLButtonElement>('#fragment-save')
  const closeButton = dialog.querySelector<HTMLButtonElement>('#fragments-close')

  function refresh(): void {
    const fragments = listFragments()
    if (!list || !empty) {
      return
    }
    empty.hidden = fragments.length > 0
    list.replaceChildren(
      ...fragments.map((fragment) => {
        const li = document.createElement('li')
        li.className = 'fragment-item'

        const name = document.createElement('span')
        name.className = 'fragment-name'
        name.textContent = fragment.name

        const preview = document.createElement('code')
        preview.className = 'fragment-preview'
        preview.textContent = fragment.content.split('\n')[0]!

        const insert = document.createElement('button')
        insert.type = 'button'
        insert.className = 'fragment-insert'
        insert.textContent = 'Insert'
        insert.addEventListener('click', () => {
          callbacks.onInsert(fragment.name)
          dialog.close()
        })

        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'fragment-delete'
        remove.textContent = 'Delete'
        remove.addEventListener('click', () => {
          deleteFragment(fragment.name)
          refresh()
        })

        li.append(name, preview, insert, remove)
        return li
      }),
    )
  }

  function suggestedName(): string {
    const existing = new Set(listFragments().map((fragment) => fragment.name))
    let index = existing.size + 1
    while (existing.has(`fragment-${index}`)) {
      index++
    }
    return `fragment-${index}`
  }

  saveButton?.addEventListener('click', () => {
    if (!nameInput) {
      return
    }
    const name = nameInput.value.trim()
    if (!name) {
      nameInput.focus()
      return
    }
    callbacks.onSaveSelection(name)
    nameInput.value = ''
    refresh()
  })

  closeButton?.addEventListener('click', () => {
    dialog.close()
  })

  return {
    open() {
      if (nameInput) {
        nameInput.value = suggestedName()
        nameInput.focus()
      }
      refresh()
      dialog.showModal()
    },
  }
}
