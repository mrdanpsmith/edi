import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkDeflist from 'remark-deflist'
import type { Node as ProseNode, Schema, Mark } from 'prosemirror-model'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'
import { remarkPlugin as mermaidRemarkPlugin } from './node/mermaid'
import { shebangFromFenceInfo } from './exec'

export interface BlockOffset {
  id: string
  start: number
  end: number
  nodePos: number
}

let blockIdCounter = 0
function nextBlockId(): string {
  return `block-${++blockIdCounter}`
}

function createProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDeflist as never)
    .use(remarkStringify)
    .use(highlight.remarkPlugin)
    .use(subscript.remarkPlugin)
    .use(superscript.remarkPlugin)
    .use(mermaidRemarkPlugin)
}

const MARK_TYPES = new Set([
  'strong',
  'emphasis',
  'em',
  'code',
  'strikethrough',
  'delete',
  'link',
  'highlight',
  'sub',
  'sup',
])

// remark/mdast names some emphasis nodes differently from their ProseMirror
// mark type: italics are `emphasis` (not `em`) and GFM strikethrough is
// `delete` (not `strikethrough`).
const MARK_TYPE_ALIASES: Record<string, string> = {
  emphasis: 'em',
  delete: 'strikethrough',
}

function isMarkType(type: string): boolean {
  return MARK_TYPES.has(type)
}

// --- Parse: MDAST → ProseMirror ---

interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
  depth?: number
  ordered?: boolean | null
  start?: number | null
  lang?: string | null
  meta?: string | null
  url?: string
  title?: string | null
  alt?: string
  src?: string
  // custom types
  shebang?: string
  // GFM table
  align?: (string | null)[]
  // GFM task list
  checked?: boolean | null
}

function mdastToProse(node: MdastNode, schema: Schema): ProseNode {
  switch (node.type) {
    case 'root': {
      const children = (node.children ?? []).map((c) => mdastToProse(c, schema))
      if (children.length === 0) children.push(schema.node('paragraph'))
      return schema.node('doc', {}, children)
    }

    case 'paragraph':
      return schema.node('paragraph', {}, parseInline(node.children ?? [], schema))

    case 'heading':
      return schema.node('heading', { level: node.depth ?? 1 }, parseInline(node.children ?? [], schema))

    case 'blockquote': {
      const children = (node.children ?? []).map((c) => mdastToProse(c, schema))
      return schema.node('blockquote', {}, children)
    }

    case 'list': {
      const type = node.ordered ? 'ordered_list' : 'bullet_list'
      const attrs: Record<string, unknown> = {}
      if (node.ordered && node.start != null && node.start !== 1) {
        attrs.order = node.start
      }
      const children = (node.children ?? []).map((c) => mdastToProse(c, schema))
      return schema.node(type, attrs, children)
    }

    case 'listItem': {
      const children = (node.children ?? []).map((c) => mdastToProse(c, schema))
      const attrs: Record<string, unknown> = {}
      if (node.checked != null) attrs.checked = node.checked
      return schema.node('list_item', attrs, children)
    }

    case 'code': {
      const lang = node.lang ?? ''
      if (lang === 'mermaid') {
        return schema.node('mermaid_block', { value: node.value ?? '' })
      }
      const value = node.value ?? ''
      const infoShebang = shebangFromFenceInfo(lang, node.meta ?? '')
      if (infoShebang) {
        // Normalize an info-string shebang (```#!cmd) into the content as the
        // first line so a runnable block is just a code_block whose first line
        // starts with `#!`.
        const firstLine = value.split('\n', 1)[0] ?? ''
        const content = firstLine.startsWith('#!') ? value : infoShebang + '\n' + value
        return schema.node('code_block', { language: '' }, [schema.text(content)])
      }
      return schema.node('code_block', { language: lang }, [schema.text(value)])
    }

    case 'thematicBreak':
      return schema.node('horizontal_rule')

    case 'table': {
      const children = (node.children ?? []).map((c) => mdastToProse(c, schema))
      return schema.node('table', {}, children)
    }

    case 'tableRow': {
      const children = (node.children ?? []).map((c) => mdastToProse(c, schema))
      return schema.node('table_row', {}, children)
    }

    case 'tableCell': {
      const content = parseTableCellContent(node.children ?? [], schema)
      return schema.node('table_cell', {}, content)
    }

    case 'tableHeader': {
      const content = parseTableCellContent(node.children ?? [], schema)
      return schema.node('table_header', {}, content)
    }

    case 'html':
      return schema.node('paragraph', {}, [schema.text(node.value ?? '')])

    case 'break':
      return schema.node('hard_break')

    case 'image':
      // mdast exposes the image destination on `url`, not `src`.
      return schema.node('image', { src: node.url ?? node.src ?? '', alt: node.alt ?? '' })

    case 'mermaid_block':
      return schema.node('mermaid_block', { value: node.value ?? '' })

    case 'descriptionlist': {
      const children = (node.children ?? []).map((c) => mdastToProse(c, schema))
      return schema.node('descriptionlist', {}, children)
    }

    case 'descriptionterm':
      return schema.node('descriptionterm', {}, parseInline(node.children ?? [], schema))

    case 'descriptiondetails': {
      const children = (node.children ?? []).map((c) => mdastToProse(c, schema))
      return schema.node('descriptiondetails', {}, children)
    }

    default: {
      const text = node.value ?? ''
      if (text) return schema.node('paragraph', {}, [schema.text(text)])
      return schema.node('paragraph')
    }
  }
}

function parseInline(
  children: MdastNode[],
  schema: Schema,
  marks: Mark[] = [],
): ProseNode[] {
  const result: ProseNode[] = []
  for (const child of children) {
    if (child.type === 'text') {
      result.push(schema.text(child.value ?? '', marks))
    } else if (child.type === 'inlineCode') {
      const codeMark = schema.marks.code.create()
      result.push(schema.text(child.value ?? '', [...marks, codeMark]))
    } else if (child.type === 'break') {
      result.push(schema.node('hard_break', {}, marks.length ? undefined : undefined))
    } else if (child.type === 'image') {
      // mdast exposes the image destination on `url`, not `src`.
      result.push(schema.node('image', { src: child.url ?? child.src ?? '', alt: child.alt ?? '' }))
    } else if (isMarkType(child.type)) {
      const markType = schema.marks[MARK_TYPE_ALIASES[child.type] ?? child.type]
      if (markType) {
        const markAttrs: Record<string, unknown> = {}
        if (child.type === 'link') {
          // mdast exposes the destination on `url`, not `href`.
          if (child.url != null) markAttrs.href = child.url
          if (child.title != null) markAttrs.title = child.title
        }
        const mark = markType.create(markAttrs)
        const inner = parseInline(child.children ?? [], schema, [...marks, mark])
        result.push(...inner)
      } else if (child.children) {
        result.push(...parseInline(child.children, schema, marks))
      }
    } else if (child.children) {
      result.push(...parseInline(child.children, schema, marks))
    }
  }
  return result
}

function parseBlockContent(children: MdastNode[], schema: Schema): ProseNode[] {
  return children.map((c) => mdastToProse(c, schema))
}

const INLINE_TYPES = new Set([
  'text', 'inlineCode', 'strong', 'em', 'strikethrough', 'link',
  'image', 'break', 'highlight', 'sub', 'sup',
])

function isInlineOnly(children: MdastNode[]): boolean {
  return children.length > 0 && children.every((c) => INLINE_TYPES.has(c.type))
}

function parseTableCellContent(children: MdastNode[], schema: Schema): ProseNode[] {
  if (children.length === 0) {
    return [schema.node('paragraph')]
  }
  if (isInlineOnly(children)) {
    return [schema.node('paragraph', {}, parseInline(children, schema))]
  }
  return parseBlockContent(children, schema)
}

// --- Serialize: ProseMirror → markdown ---

function collectChildren(node: ProseNode): ProseNode[] {
  const children: ProseNode[] = []
  node.forEach((child) => children.push(child))
  return children
}

function serializeNode(node: ProseNode, indent = ''): string {
  switch (node.type.name) {
    case 'doc':
      return collectChildren(node).map((c) => serializeNode(c)).join('\n\n') + '\n'

    case 'paragraph':
      return indent + serializeContent(node)

    case 'heading': {
      const level = node.attrs.level as number
      return indent + '#'.repeat(level) + ' ' + serializeContent(node)
    }

    case 'blockquote': {
      const inner = collectChildren(node).map((c) => serializeNode(c)).join('\n\n')
      return inner
        .split('\n')
        .map((line: string) => (line ? '> ' + line : '>'))
        .join('\n')
    }

    case 'bullet_list':
      return serializeList(node, false, indent)

    case 'ordered_list':
      return serializeList(node, true, indent)

    case 'list_item':
      return serializeListItem(node, indent)

    case 'code_block': {
      const lang = (node.attrs.language as string) ?? ''
      const content = node.textContent
      // A runnable block just has its shebang as the first content line; the
      // info string must stay empty so it round-trips as a bare fence.
      const language = lang.startsWith('#!') ? '' : lang
      return indent + '```' + language + '\n' + content + '\n' + indent + '```'
    }

    case 'horizontal_rule':
      return indent + '---'

    case 'hard_break':
      return '  \n'

    case 'image':
      return `![${node.attrs.alt as string}](${node.attrs.src as string})`

    case 'mermaid_block': {
      const val = (node.attrs.value as string) ?? ''
      return indent + '```mermaid\n' + val + '\n' + indent + '```'
    }

    case 'table':
      return serializeTable(node, indent)

    case 'descriptionlist':
      return serializeDefList(node, indent)

    case 'descriptionterm':
      return serializeContent(node)

    case 'descriptiondetails': {
      const inner = collectChildren(node).map((c) => serializeNode(c, indent)).join('\n\n')
      return inner
        .split('\n')
        .map((line: string) => (line ? '    ' + line : ''))
        .join('\n')
    }

    case 'text':
      return applyMarks(node.text ?? '', node.marks ?? [])

    case 'inline':
      return applyMarks(node.text ?? '', node.marks ?? [])

    default:
      return node.textContent
  }
}

function serializeContent(node: ProseNode): string {
  const parts: string[] = []
  node.content.forEach((child) => {
    if (child.isText) {
      parts.push(applyMarks(child.text ?? '', child.marks ?? []))
    } else {
      parts.push(serializeNode(child))
    }
  })
  return parts.join('')
}

function applyMarks(text: string, marks: readonly Mark[]): string {
  for (const mark of marks) {
    switch (mark.type.name) {
      case 'strong':
        text = '**' + text + '**'
        break
      case 'em':
        text = '*' + text + '*'
        break
      case 'code':
        text = '`' + text + '`'
        break
      case 'strikethrough':
        text = '~~' + text + '~~'
        break
      case 'link': {
        const title = mark.attrs.title != null && mark.attrs.title !== ''
          ? ` "${mark.attrs.title}"`
          : ''
        text = '[' + text + '](' + (mark.attrs.href as string) + title + ')'
        break
      }
      case 'highlight':
        text = '==' + text + '=='
        break
      case 'sub':
        text = '~' + text + '~'
        break
      case 'sup':
        text = '^' + text + '^'
        break
    }
  }
  return text
}

function serializeList(node: ProseNode, ordered: boolean, indent: string): string {
  const items: string[] = []
  let counter = ordered ? ((node.attrs.order as number) ?? 1) : 0
  node.content.forEach((child) => {
    if (child.type.name === 'list_item') {
      let bullet: string
      if (ordered) {
        bullet = `${counter}.`
      } else {
        const checked = child.attrs.checked as boolean | null
        bullet = checked !== null ? (checked ? '- [x]' : '- [ ]') : '-'
      }
      items.push(serializeListItemContent(child, bullet, indent))
      counter++
    }
  })
  return items.join('\n')
}

function serializeListItem(node: ProseNode, indent: string): string {
  return serializeListItemContent(node, '-', indent)
}

function serializeListItemContent(node: ProseNode, bullet: string, indent: string): string {
  const lines: string[] = []
  const contentIndent = indent + ' '.repeat(bullet.length + 1)
  node.content.forEach((child, _, i) => {
    if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') {
      lines.push(serializeNode(child, contentIndent))
    } else {
      const content = serializeNode(child)
      if (i === 0) {
        lines.push(indent + bullet + ' ' + content)
      } else {
        lines.push(contentIndent + content)
      }
    }
  })
  return lines.join('\n')
}

function serializeTable(node: ProseNode, indent: string): string {
  const rows: string[] = []
  const colCount = (() => {
    let max = 0
    node.content.forEach((row) => {
      let count = 0
      row.content.forEach(() => count++)
      if (count > max) max = count
    })
    return max
  })()

  let isFirstRow = true
  node.content.forEach((row) => {
    const cells: string[] = []
    row.content.forEach((cell) => {
      cells.push(serializeContent(cell).replace(/\|/g, '\\|'))
    })
    while (cells.length < colCount) cells.push('')
    rows.push('| ' + cells.join(' | ') + ' |')

    if (isFirstRow) {
      rows.push('| ' + cells.map(() => '---').join(' | ') + ' |')
      isFirstRow = false
    }
  })

  return rows.map((r) => indent + r).join('\n')
}

function serializeDefList(node: ProseNode, indent: string): string {
  const parts: string[] = []
  let currentTerm = ''
  node.content.forEach((child) => {
    if (child.type.name === 'descriptionterm') {
      currentTerm = serializeContent(child)
    } else if (child.type.name === 'descriptiondetails') {
      const details = collectChildren(child).map((c) => serializeNode(c, indent)).join('\n\n')
      const indented = details
        .split('\n')
        .map((line: string) => (line ? '    ' + line : ''))
        .join('\n')
      parts.push(currentTerm + '\n' + ':   ' + indented.trim())
      currentTerm = ''
    }
  })
  return parts.join('\n\n')
}

// --- Public API ---

export function markdownToProse(markdown: string, mdSchema: Schema): ProseNode {
  const processor = createProcessor()
  const tree = processor.parse(markdown) as MdastNode
  const doc = mdastToProse(tree, mdSchema)
  if (doc.childCount === 0) {
    return mdSchema.node('doc', {}, [mdSchema.node('paragraph')])
  }
  return doc
}

export function proseToMarkdown(doc: ProseNode): string {
  return serializeNode(doc)
}

export function serializeBlock(node: ProseNode): string {
  return serializeNode(node)
}

export function extractBlockMarkdown(
  doc: ProseNode,
  blockOffsets: BlockOffset[],
  blockId: string,
): string {
  const offset = blockOffsets.find((o) => o.id === blockId)
  if (!offset) return ''
  const node = doc.resolve(offset.nodePos).node()
  return serializeNode(node)
}

export function buildBlockOffsets(doc: ProseNode): BlockOffset[] {
  const offsets: BlockOffset[] = []
  let pos = 1
  doc.forEach((node) => {
    const globalPos = pos
    offsets.push({
      id: nextBlockId(),
      start: 0,
      end: 0,
      nodePos: globalPos,
    })
    pos += node.nodeSize
  })
  return offsets
}
