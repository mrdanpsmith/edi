import remarkDeflist from 'remark-deflist'

export const remarkPlugin = remarkDeflist as never

export const descriptionListNode = {
  content: '(descriptionterm descriptiondetails*)+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dl' }],
  toDOM() {
    return ['dl', 0]
  },
}

export const descriptionTermNode = {
  content: 'inline*',
  group: '',
  parseDOM: [{ tag: 'dt' }],
  toDOM() {
    return ['dt', 0]
  },
}

export const descriptionDetailsNode = {
  content: 'block+',
  group: '',
  parseDOM: [{ tag: 'dd' }],
  toDOM() {
    return ['dd', 0]
  },
}
