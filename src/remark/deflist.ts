import { $nodeSchema, $remark } from '@milkdown/utils'
import remarkDeflist from 'remark-deflist'

export const remarkDeflistPlugin = $remark('remarkDeflist', () => remarkDeflist as never)

export const descriptionListSchema = $nodeSchema('descriptionlist', () => ({
  content: '(descriptionterm descriptiondetails*)+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dl' }],
  toDOM: () => ['dl', 0],
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === 'descriptionlist',
    runner: (state, node, type) => {
      state.openNode(type)
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'descriptionlist',
    runner: (state, node) => {
      state.openNode(node.type.name)
      state.next(node.content)
      state.closeNode()
    },
  },
}))

export const descriptionTermSchema = $nodeSchema('descriptionterm', () => ({
  content: 'inline*',
  group: '',
  parseDOM: [{ tag: 'dt' }],
  toDOM: () => ['dt', 0],
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === 'descriptionterm',
    runner: (state, node, type) => {
      state.openNode(type)
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'descriptionterm',
    runner: (state, node) => {
      state.openNode(node.type.name)
      state.next(node.content)
      state.closeNode()
    },
  },
}))

export const descriptionDetailsSchema = $nodeSchema('descriptiondetails', () => ({
  content: 'block+',
  group: '',
  parseDOM: [{ tag: 'dd' }],
  toDOM: () => ['dd', 0],
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === 'descriptiondetails',
    runner: (state, node, type) => {
      state.openNode(type)
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'descriptiondetails',
    runner: (state, node) => {
      state.openNode('descriptiondetails')
      state.next(node.content)
      state.closeNode()
    },
  },
}))
