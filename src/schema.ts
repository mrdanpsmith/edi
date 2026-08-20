import { Schema } from 'prosemirror-model'
import type { SchemaSpec } from 'prosemirror-model'

const nodes: SchemaSpec['nodes'] = {
  doc: {
    content: 'block+',
  },

  paragraph: {
    group: 'block',
    content: 'inline*',
    attrs: { _source: { default: false } },
    toDOM() {
      return ['p', 0]
    },
  },

  heading: {
    group: 'block',
    content: 'inline*',
    attrs: { level: { default: 1 }, _source: { default: false } },
    toDOM(node) {
      return [`h${node.attrs.level as number}`, 0]
    },
  },

  blockquote: {
    group: 'block',
    content: 'block+',
    attrs: { _source: { default: false } },
    toDOM() {
      return ['blockquote', 0]
    },
  },

  bullet_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { _source: { default: false } },
    toDOM() {
      return ['ul', 0]
    },
  },

  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { order: { default: 1 }, _source: { default: false } },
    toDOM(node) {
      const order = node.attrs.order as number
      return order === 1 ? ['ol', 0] : ['ol', { start: order }, 0]
    },
  },

  list_item: {
    content: 'block+',
    attrs: { checked: { default: null } },
    toDOM(node) {
      const checked = node.attrs.checked as boolean | null
      if (checked !== null) {
        return ['li', { 'data-checked': String(checked) }, 0]
      }
      return ['li', 0]
    },
  },

  code_block: {
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    attrs: { language: { default: '' }, _source: { default: false } },
    toDOM(node) {
      const lang = node.attrs.language as string
      return ['pre', ['code', { class: lang ? `language-${lang}` : '' }, 0]]
    },
  },

  horizontal_rule: {
    group: 'block',
    atom: true,
    attrs: { _source: { default: false } },
    toDOM() {
      return ['hr']
    },
  },

  table: {
    group: 'block',
    content: 'table_row+',
    attrs: { _source: { default: false } },
    toDOM() {
      return ['table', 0]
    },
  },

  table_row: {
    content: '(table_cell | table_header)+',
    toDOM() {
      return ['tr', 0]
    },
  },

  table_cell: {
    content: 'block+',
    toDOM() {
      return ['td', 0]
    },
  },

  table_header: {
    content: 'block+',
    toDOM() {
      return ['th', 0]
    },
  },

  hard_break: {
    inline: true,
    group: 'inline',
    atom: true,
    toDOM() {
      return ['br']
    },
  },

  image: {
    inline: true,
    atom: true,
    attrs: {
      src: { default: '' },
      alt: { default: '' },
    },
    toDOM(node) {
      return ['img', { src: node.attrs.src as string, alt: node.attrs.alt as string }]
    },
  },

  mermaid_block: {
    group: 'block',
    marks: '',
    code: true,
    atom: true,
    attrs: { value: { default: '' }, _source: { default: false } },
    toDOM() {
      return ['div', { 'data-mermaid-block': '', style: 'white-space:pre' }]
    },
  },

  exec_block: {
    group: 'block',
    marks: '',
    code: true,
    attrs: {
      shebang: { default: '' },
      value: { default: '' },
      _source: { default: false },
    },
    toDOM() {
      return ['div', { 'data-exec-block': '' }, ['div', { class: 'exec-source' }, ['code', 0]]]
    },
  },

  source_block: {
    group: 'block',
    marks: '',
    code: true,
    atom: true,
    attrs: {
      markdown: { default: '' },
    },
    toDOM() {
      return ['div', { 'data-source-block': '' }]
    },
  },

  descriptionlist: {
    group: 'block',
    content: '(descriptionterm descriptiondetails*)+',
    defining: true,
    attrs: { _source: { default: false } },
    toDOM() {
      return ['dl', 0]
    },
  },

  descriptionterm: {
    content: 'inline*',
    group: '',
    toDOM() {
      return ['dt', 0]
    },
  },

  descriptiondetails: {
    content: 'block+',
    group: '',
    toDOM() {
      return ['dd', 0]
    },
  },

  text: {
    inline: true,
    group: 'inline',
  },
}

const marks: SchemaSpec['marks'] = {
  strong: {
    parseDOM: [{ tag: 'strong' }],
    toDOM() {
      return ['strong', 0]
    },
  },

  em: {
    parseDOM: [{ tag: 'em' }],
    toDOM() {
      return ['em', 0]
    },
  },

  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM() {
      return ['code', 0]
    },
  },

  strikethrough: {
    parseDOM: [{ tag: 'del' }],
    toDOM() {
      return ['del', 0]
    },
  },

  link: {
    attrs: { href: { default: '' } },
    parseDOM: [
      {
        tag: 'a',
        getAttrs(dom: HTMLElement) {
          return { href: dom.getAttribute('href') ?? '' }
        },
      },
    ],
    toDOM(mark) {
      return ['a', { href: mark.attrs.href as string }, 0]
    },
  },

  highlight: {
    parseDOM: [{ tag: 'mark' }],
    toDOM() {
      return ['mark', 0]
    },
  },

  sub: {
    parseDOM: [{ tag: 'sub' }],
    toDOM() {
      return ['sub', 0]
    },
  },

  sup: {
    parseDOM: [{ tag: 'sup' }],
    toDOM() {
      return ['sup', 0]
    },
  },
}

export const schema = new Schema({ nodes, marks } as SchemaSpec)
