import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import type { Node as ProseNode, Schema, Mark } from 'prosemirror-model'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'
import { remarkPlugin as mermaidRemarkPlugin } from './node/mermaid'
import {
  remarkPlugin as maskedFieldRemarkPlugin,
  maskedFieldToMarkdown,
} from './node/masked'
import { shebangFromFenceInfo } from './exec'
import { tableToPipes } from './spreadsheet-util'

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
    .use(remarkStringify)
    .use(highlight.remarkPlugin)
    .use(subscript.remarkPlugin)
    .use(superscript.remarkPlugin)
    .use(mermaidRemarkPlugin)
    .use(maskedFieldRemarkPlugin)
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

// A closing fence must have at least as many backticks as the opener, and a
// content line can't be the closing fence while it also appears inside the
// block only if it holds more backticks than the opener. So an opening fence
// length of (longest backtick run in the content) + 1 — minimum 3 — always
// round-trips in CommonMark.
function codeFence(content: string): string {
  let maxRun = 0
  const re = /`+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    if (match[0].length > maxRun) maxRun = match[0].length
  }
  return '`'.repeat(Math.max(3, maxRun + 1))
}

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
  content?: string
  label?: string
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
        return schema.node('code_block', { language: '' }, content ? [schema.text(content)] : [])
      }
      // An empty fence (``` + `` with nothing between) yields empty content;
      // schema.text('') is invalid, so emit the block without children instead
      // of crashing the whole parse.
      return schema.node('code_block', { language: lang }, value ? [schema.text(value)] : [])
    }

    case 'thematicBreak':
      return schema.node('horizontal_rule')

    case 'table': {
      // GFM: the first row is the header. The whole grid becomes the atom's
      // `value` as normalized pipe-table markdown; each cell holds its inline
      // markdown text (the strong/code/etc. marks survive the round trip).
      const rows = (node.children ?? []).map((row) =>
        (row.children ?? []).map((cell) =>
          serializeCellText(cell.children ?? [], schema),
        ),
      )
      return schema.node('table', { value: tableToPipes(rows) })
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

    case 'masked_field':
      return schema.node('masked_field', {
        content: node.content ?? '',
        label: node.label ?? '',
      })

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
    } else if (child.type === 'masked_field') {
      result.push(schema.node('masked_field', { content: child.content ?? '', label: child.label ?? '' }))
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

function serializeCellText(children: MdastNode[], schema: Schema): string {
  const para = schema.node('paragraph', {}, parseInline(children, schema))
  return serializeContent(para)
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
      // Match the fence to the content so embedded fences (e.g. a ```example```
      // shown inside a ```markdown fence) survive a save/reload round-trip.
      const fence = codeFence(content)
      return indent + fence + language + '\n' + content + '\n' + indent + fence
    }

    case 'horizontal_rule':
      return indent + '---'

    case 'hard_break':
      return '  \n'

    case 'image':
      return `![${node.attrs.alt as string}](${node.attrs.src as string})`

    case 'masked_field':
      return maskedFieldToMarkdown(node.attrs.content as string, node.attrs.label as string)

    case 'mermaid_block': {
      const val = (node.attrs.value as string) ?? ''
      const fence = codeFence(val)
      return indent + fence + 'mermaid\n' + val + '\n' + indent + fence
    }

    case 'table': {
      const val = (node.attrs.value as string) ?? ''
      if (!val) return ''
      return val
        .split('\n')
        .map((line) => indent + line)
        .join('\n')
    }

    case 'text':
      return serializeInlineAtom(node.text ?? '', node.marks ?? [])

    case 'inline':
      return serializeInlineAtom(node.text ?? '', node.marks ?? [])

    default:
      return node.textContent
  }
}

function serializeContent(node: ProseNode): string {
  // Inline content is a run of ProseMirror text nodes whose marks can overlap
  // (e.g. `**`code` words**` = [strong, code] then [strong]). Wrapping each
  // text node independently would emit a fresh `**` per node (`**`code`****
  // words**`). Instead stream the run: keep the marks shared by adjacent nodes
  // open across the boundary and only open/close the delimiters that differ.
  const out: string[] = []
  const stack: Mark[] = []

  const syncTo = (target: readonly Mark[]) => {
    // Close open marks (innermost first) that the target atom doesn't carry.
    while (stack.length && !target.some((m) => m.eq(stack[stack.length - 1]))) {
      out.push(markCloseDelimiter(stack.pop()!))
    }
    // Open marks the target carries that aren't open yet, in canonical
    // outer→inner order.
    for (const m of orderedMarks(target)) {
      if (!stack.some((s) => s.eq(m))) {
        out.push(markOpenDelimiter(m))
        stack.push(m)
      }
    }
  }

  node.content.forEach((child) => {
    if (child.isText) {
      syncTo(child.marks ?? [])
      out.push(child.text ?? '')
    } else {
      // Inline non-text nodes (image, hard break, masked field) are serialized
      // standalone; don't wrap them in the surrounding marks.
      syncTo([])
      out.push(serializeNode(child))
    }
  })
  syncTo([])
  return out.join('')
}

// Code is always emitted innermost: a Markdown code span is literal, so
// `` `**x**` `` would swallow the asterisks as plain text. The given marks are
// already rank-sorted (outer→inner) by ProseMirror; links nest fine around
// other emphasis because their `[..](href)` delimiters wrap the whole run.
function orderedMarks(marks: readonly Mark[]): readonly Mark[] {
  const code = marks.find((m) => m.type.name === 'code')
  if (!code) return [...marks]
  return [...marks.filter((m) => m.type.name !== 'code'), code]
}

function markOpenDelimiter(mark: Mark): string {
  switch (mark.type.name) {
    case 'strong':
      return '**'
    case 'em':
      return '*'
    case 'code':
      return '`'
    case 'strikethrough':
      return '~~'
    case 'link':
      return '['
    case 'highlight':
      return '=='
    case 'sub':
      return '~'
    case 'sup':
      return '^'
    default:
      return ''
  }
}

function markCloseDelimiter(mark: Mark): string {
  if (mark.type.name === 'link') {
    const title =
      mark.attrs.title != null && mark.attrs.title !== ''
        ? ` "${mark.attrs.title}"`
        : ''
    return '](' + (mark.attrs.href as string) + title + ')'
  }
  return markOpenDelimiter(mark)
}

function serializeInlineAtom(text: string, marks: readonly Mark[]): string {
  const ordered = orderedMarks(marks)
  let out = ''
  for (const mark of ordered) out += markOpenDelimiter(mark)
  out += text
  for (let i = ordered.length - 1; i >= 0; i--) out += markCloseDelimiter(ordered[i])
  return out
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
