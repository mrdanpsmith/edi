import { Schema } from 'prosemirror-model'
import type { SchemaSpec } from 'prosemirror-model'
import { domTableToPipes } from './spreadsheet-util'

const nodes: SchemaSpec['nodes'] = {
  doc: {
    content: 'block+',
  },

  paragraph: {
    group: 'block',
    content: 'inline*',
    attrs: { _source: { default: false } },
    parseDOM: [{ tag: 'p' }],
    toDOM() {
      return ['p', 0]
    },
  },

  heading: {
    group: 'block',
    content: 'inline*',
    attrs: { level: { default: 1 }, _source: { default: false } },
    parseDOM: [
      { tag: 'h1', attrs: { level: 1 } },
      { tag: 'h2', attrs: { level: 2 } },
      { tag: 'h3', attrs: { level: 3 } },
      { tag: 'h4', attrs: { level: 4 } },
      { tag: 'h5', attrs: { level: 5 } },
      { tag: 'h6', attrs: { level: 6 } },
    ],
    toDOM(node) {
      return [`h${node.attrs.level as number}`, 0]
    },
  },

  blockquote: {
    group: 'block',
    content: 'block+',
    attrs: { _source: { default: false } },
    parseDOM: [{ tag: 'blockquote' }],
    toDOM() {
      return ['blockquote', 0]
    },
  },

  bullet_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { _source: { default: false } },
    parseDOM: [{ tag: 'ul' }],
    toDOM() {
      return ['ul', 0]
    },
  },

  ordered_list: {
    group: 'block',
    content: 'list_item+',
    attrs: { order: { default: 1 }, _source: { default: false } },
    parseDOM: [{
      tag: 'ol',
      getAttrs(dom: HTMLElement) {
        const start = dom.getAttribute('start')
        return { order: start ? Number(start) : 1 }
      },
    }],
    toDOM(node) {
      const order = node.attrs.order as number
      return order === 1 ? ['ol', 0] : ['ol', { start: order }, 0]
    },
  },

  list_item: {
    content: 'block+',
    attrs: { checked: { default: null } },
    parseDOM: [{
      tag: 'li',
      getAttrs(dom: HTMLElement) {
        const checked = dom.getAttribute('data-checked')
        return { checked: checked !== null ? checked === 'true' : null }
      },
    }],
    toDOM(node) {
      const checked = node.attrs.checked as boolean | null
      if (checked !== null) {
        return [
          'li', { 'data-checked': String(checked) },
          ['input', { type: 'checkbox', 'data-task-check': '', ...(checked ? { checked: true } : {}) }],
          ['div', 0],
        ]
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
    parseDOM: [{
      tag: 'pre',
      preserveWhitespace: 'full',
      getAttrs(dom: HTMLElement) {
        const code = dom.querySelector('code')
        const lang = code?.className?.match(/language-(\S+)/)?.[1] ?? ''
        return { language: lang }
      },
    }],
    toDOM(node) {
      const lang = node.attrs.language as string
      return ['pre', ['code', { class: lang ? `language-${lang}` : '' }, 0]]
    },
  },

  horizontal_rule: {
    group: 'block',
    atom: true,
    attrs: { _source: { default: false } },
    parseDOM: [{ tag: 'hr' }],
    toDOM() {
      return ['hr']
    },
  },

  table: {
    group: 'block',
    marks: '',
    code: true,
    atom: true,
    attrs: { value: { default: '' }, _source: { default: false }, _plain: { default: true }, _resolved: { default: false } },
    parseDOM: [
      {
        tag: 'table',
        getAttrs(dom: HTMLElement) {
          return { value: domTableToPipes(dom as HTMLTableElement) }
        },
      },
      {
        tag: 'div[data-edi-table]',
        getAttrs(dom: HTMLElement) {
          // toDOM writes the raw pipe-table text into the element (mermaid
          // pattern), so a copy/paste round trip preserves the cell markup.
          return { value: dom.textContent ?? '' }
        },
      },
    ],
    toDOM(node) {
      return ['div', { 'data-edi-table': '' }, node.attrs.value as string]
    },
  },

  hard_break: {
    inline: true,
    group: 'inline',
    atom: true,
    parseDOM: [{ tag: 'br' }],
    toDOM() {
      return ['br']
    },
  },

  image: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
      src: { default: '' },
      alt: { default: '' },
    },
    parseDOM: [{
      tag: 'img',
      getAttrs(dom: HTMLElement) {
        return { src: dom.getAttribute('src') ?? '', alt: dom.getAttribute('alt') ?? '' }
      },
    }],
    toDOM(node) {
      return ['img', { src: node.attrs.src as string, alt: node.attrs.alt as string }]
    },
  },

  masked_field: {
    inline: true,
    atom: true,
    group: 'inline',
    attrs: {
      content: { default: '' },
      label: { default: '' },
    },
    parseDOM: [{
      tag: 'span[data-masked-field]',
      getAttrs(dom: HTMLElement) {
        return {
          content: dom.getAttribute('data-content') ?? '',
          label: dom.getAttribute('data-label') ?? '',
        }
      },
    }],
    toDOM(node) {
      const label = node.attrs.label as string
      const text = label ? `•••••••••••• (${label})` : '••••••••••••'
      return ['span', {
        'data-masked-field': 'true',
        'data-content': node.attrs.content as string,
        'data-label': label,
      }, text]
    },
  },

  mermaid_block: {
    group: 'block',
    marks: '',
    code: true,
    atom: true,
    attrs: { value: { default: '' }, _source: { default: false } },
    parseDOM: [{
      tag: '[data-mermaid-block]',
      getAttrs(dom: HTMLElement) {
        return { value: dom.textContent ?? '' }
      },
    }],
    toDOM(node) {
      return ['div', { 'data-mermaid-block': '', style: 'white-space:pre' }, node.attrs.value as string]
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
    parseDOM: [{
      tag: '[data-source-block]',
      getAttrs(dom: HTMLElement) {
        return { markdown: dom.textContent ?? '' }
      },
    }],
    toDOM(node) {
      return ['div', { 'data-source-block': '' }, node.attrs.markdown as string]
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
    attrs: { href: { default: '' }, title: { default: null } },
    parseDOM: [
      {
        tag: 'a',
        getAttrs(dom: HTMLElement) {
          const href = dom.getAttribute('href') ?? ''
          // toDOM always writes title = href for the hover tooltip; ignore
          // that synthetic value so a copy/paste round trip never bakes a
          // spurious `title="<url>"` into the mark (and thus saved Markdown).
          const title = dom.getAttribute('title')
          return { href, title: title && title !== href ? title : null }
        },
      },
    ],
    toDOM(mark) {
      const attrs: Record<string, string> = {
        href: mark.attrs.href as string,
        // Native browser tooltip on hover: show the real destination.
        title: mark.attrs.href as string,
      }
      return ['a', attrs, 0]
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
