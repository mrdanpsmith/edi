import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import type { Fragment, Node as ProseNode, Schema, Mark } from 'prosemirror-model'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'
import { MERMAID_TYPE, remarkPlugin as mermaidRemarkPlugin } from './remark/mermaid'
import {
  remarkPlugin as maskedFieldRemarkPlugin,
  maskedFieldToMarkdown,
} from './node/masked'
import { shebangFromFenceInfo } from './exec'
import { BUILTIN_ENV, type FormulaEnv } from './formulas'
import { headingSlug } from './schema'
import {
  formatTableCarrier,
  hydrateResolvedTable,
  parseTableCarrier,
  resolveTableValue,
  tableToPipes,
  type TableAlign,
} from './spreadsheet-util'

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

/** Extract the cell grid and delimiter-row alignment from a mdast table. */
function tableRowsAndAlign(
  node: MdastNode,
  schema: Schema,
): { rows: string[][]; align: TableAlign[] } {
  const rows = (node.children ?? []).map((row) =>
    (row.children ?? []).map((cell) =>
      serializeCellText(cell.children ?? [], schema),
    ),
  )
  const align = (node.align ?? []).map((value) =>
    value === 'left' || value === 'center' || value === 'right' ? value : 'none',
  )
  return { rows, align }
}

/** Map mdast children to prose nodes, folding any table's immediately
 * following carrier comment back into that table's formulas. */
function mapChildrenWithCarriers(children: MdastNode[], schema: Schema): ProseNode[] {
  const out: ProseNode[] = []
  let i = 0
  while (i < children.length) {
    const child = children[i]!
    if (child.type === 'table') {
      const next = children[i + 1]
      const carrier = next?.type === 'html' ? parseTableCarrier(next.value ?? '') : null
      if (carrier !== null) {
        const { rows, align } = tableRowsAndAlign(child, schema)
        out.push(
          schema.node('table', {
            value: hydrateResolvedTable(rows, align, carrier),
            _resolved: true,
          }),
        )
        i += 2
        continue
      }
    }
    out.push(mdastToProse(child, schema))
    i++
  }
  return out
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
      const children = mapChildrenWithCarriers(node.children ?? [], schema)
      if (children.length === 0) children.push(schema.node('paragraph'))
      return schema.node('doc', {}, children)
    }

    case 'paragraph':
      return schema.node('paragraph', {}, parseInline(node.children ?? [], schema))

    case 'heading': {
      const attrs: Record<string, unknown> = { level: node.depth ?? 1 }
      const children = parseInline(node.children ?? [], schema)
      // Pandoc-style explicit id: {#custom-id} at the end of the heading text.
      const last = children[children.length - 1]
      if (last && last.isText) {
        const match = /\s*\{#([^{}\s]+)\}\s*$/.exec(last.text ?? '')
        if (match) {
          attrs.id = match[1]
          const trimmed = (last.text ?? '').slice(0, match.index).replace(/\s+$/, '')
          if (trimmed === '' && children.length === 1) {
            // The id marker was the only "text"; keep an empty inline
            // (headings require inline* content anyway).
            children.pop()
          } else {
            children[children.length - 1] = schema.text(trimmed, last.marks)
          }
        }
      }
      return schema.node('heading', attrs, children)
    }

    case 'blockquote': {
      const children = mapChildrenWithCarriers(node.children ?? [], schema)
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
      const children = mapChildrenWithCarriers(node.children ?? [], schema)
      const attrs: Record<string, unknown> = {}
      if (node.checked != null) attrs.checked = node.checked
      // GFM only reads a checkbox as a task marker when the item has *inline*
      // content after it, so a task item whose first block is a block of its own
      // — a code fence, a table — has no GFM spelling: written `- [x]` it reads
      // back as the literal text `[x]` in a plain bullet, which puts our own
      // output into the reader's file as words. That exact shape, a first
      // paragraph that is nothing but the checkbox token, is what
      // `serializeListItemContent` writes, so it is read back as the task it came
      // from. The trade is that a bullet whose whole text *is* `[x]` is read as a
      // task item — which is the reading GFM declines, since a marker with no
      // content after it is not one. Words after it (`- [x] noted`) stay text.
      if (attrs.checked == null && children.length > 0) {
        const first = children[0]!
        const only = first.type.name === 'paragraph' && first.childCount === 1 ? first.firstChild : null
        const token = only?.isText ? only.text : null
        if (token != null && /^\[[ xX]\]$/.test(token)) {
          attrs.checked = token !== '[ ]'
          children.shift()
        }
      }
      // An item can be empty in the source — a bare `-` on its own line is a
      // list item, and so is a step whose text has all been deleted — while
      // `list_item` is `block+`. An empty fragment is not a legal one, so
      // `schema.node` throws and takes the **whole document** down with it: one
      // empty bullet anywhere in a file and the file will not open at all. An
      // empty paragraph is what an empty item means, and it is what the editor
      // puts its caret in.
      if (children.length === 0) children.push(schema.node('paragraph'))
      return schema.node('list_item', attrs, children)
    }

    case 'code': {
      const lang = node.lang ?? ''
      if (lang === 'mermaid') {
        return schema.node(MERMAID_TYPE, { value: node.value ?? '' })
      }
      if (lang === 'encrypted') {
        const info: Record<string, string> = {}
        for (const match of (node.meta ?? '').matchAll(/(\w+)="([^"]*)"/g)) {
          info[match[1]!] = match[2]!
        }
        return schema.node('encrypted_block', {
          type: info['type'] ?? '',
          label: info['label'] ?? '',
          content: node.value ?? '',
        })
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
      // When the table carries a resolving comment, that comment restores any
      // formulas the cells were resolved from.
      const { rows, align } = tableRowsAndAlign(node, schema)
      return schema.node('table', { value: tableToPipes(rows, align) })
    }

    case 'html':
      return schema.node('paragraph', {}, [schema.text(node.value ?? '')])

    case 'break':
      return schema.node('hard_break')

    case 'image':
      // mdast exposes the image destination on `url`, not `src`.
      return schema.node('image', { src: node.url ?? node.src ?? '', alt: node.alt ?? '' })

    case MERMAID_TYPE:
      return schema.node(MERMAID_TYPE, { value: node.value ?? '' })

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

/**
 * Prefix every line of a serialized block with `indent`.
 *
 * **A block is indented in every line, not only the first, and that is what a
 * list needs to survive a save.** A list item's children live inside it, so a
 * line of one of them that starts in column 0 has left the item: the closing
 * fence of a code block written at column 0 ends the *list*, not the block, and
 * the next parse reads the code as prose and the rest of the item as a document
 * of its own. An empty line is left empty — indenting it would add trailing
 * spaces to a line that means to hold nothing, which is how a blank line inside
 * a fenced block grows whitespace nothing will ever read.
 */
function indentLines(text: string, indent: string): string {
  if (!indent) return text
  return text
    .split('\n')
    .map((line) => (line ? indent + line : line))
    .join('\n')
}

/** A fenced block: fence, content, fence — with the content indented as well. */
function fencedBlock(content: string, info: string, indent: string): string {
  const fence = codeFence(content)
  const lines = [`${fence}${info}`, ...content.split('\n'), fence]
  return indentLines(lines.join('\n'), indent)
}

function serializeNode(node: ProseNode, indent = '', env: FormulaEnv = BUILTIN_ENV): string {
  switch (node.type.name) {
    case 'doc':
      return collectChildren(node).map((c) => serializeNode(c, '', env)).join('\n\n') + '\n'

    case 'paragraph': {
      // A hard break inside the paragraph starts a new line, and a new line
      // inside a list item has to carry the item's own indent to stay in it.
      return indentLines(serializeContent(node), indent)
    }

    case 'heading': {
      const level = node.attrs.level as number
      // An explicit id that matches the text's natural slug is implicit: it
      // may have been re-derived from the DOM id on a clipboard round-trip and
      // does not need to be written out.
      const explicitId = node.attrs.id as string | null | undefined
      const suffix = explicitId && explicitId !== headingSlug(node.textContent) ? ` {#${explicitId}}` : ''
      return indentLines('#'.repeat(level) + ' ' + serializeContent(node) + suffix, indent)
    }

    case 'blockquote': {
      const inner = collectChildren(node).map((c) => serializeNode(c, '', env)).join('\n\n')
      return indentLines(
        inner
          .split('\n')
          .map((line: string) => (line ? '> ' + line : '>'))
          .join('\n'),
        indent,
      )
    }

    case 'bullet_list':
      return serializeList(node, false, indent, env)

    case 'ordered_list':
      return serializeList(node, true, indent, env)

    case 'list_item':
      return serializeListItem(node, indent, env)

    case 'encrypted_block': {
      const content = node.attrs.content as string
      const typeAttr = node.attrs.type ? ` type="${node.attrs.type as string}"` : ''
      const labelAttr = node.attrs.label ? ` label="${(node.attrs.label as string).replace(/"/g, '')}"` : ''
      return fencedBlock(content, `encrypted${typeAttr}${labelAttr}`, indent)
    }

    case 'code_block': {
      const lang = (node.attrs.language as string) ?? ''
      // A runnable block just has its shebang as the first content line; the
      // info string must stay empty so it round-trips as a bare fence.
      const language = lang.startsWith('#!') ? '' : lang
      // Match the fence to the content so embedded fences (e.g. a ```example```
      // shown inside a ```markdown fence) survive a save/reload round-trip.
      return fencedBlock(node.textContent, language, indent)
    }

    case 'horizontal_rule':
      return indent + '---'

    case 'hard_break':
      return '  \n'

    case 'image':
      return `![${node.attrs.alt as string}](${node.attrs.src as string})`

    case 'masked_field':
      return maskedFieldToMarkdown(node.attrs.content as string, node.attrs.label as string)

    case MERMAID_TYPE: {
      const val = (node.attrs.value as string) ?? ''
      return fencedBlock(val, 'mermaid', indent)
    }

    case 'table': {
      const val = (node.attrs.value as string) ?? ''
      if (!val) return ''
      let text = val
      if (node.attrs._resolved) {
        const { pipes, formulas } = resolveTableValue(val, env)
        text =
          Object.keys(formulas).length === 0
            ? pipes
            : `${pipes}\n\n${formatTableCarrier(formulas)}`
      }
      return indentLines(text, indent)
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

function serializeList(node: ProseNode, ordered: boolean, indent: string, env: FormulaEnv): string {
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
      items.push(serializeListItemContent(child, bullet, indent, env))
      counter++
    }
  })
  return items.join('\n')
}

function serializeListItem(node: ProseNode, indent: string, env: FormulaEnv): string {
  return serializeListItemContent(node, '-', indent, env)
}

/**
 * A list item's bullet, split into the part that says where the item's content
 * begins and the part written in front of that content.
 *
 * **These are not the same string, and the difference is a task item.** `- [x]`
 * is a two-column marker (`- `) with `[x]` written as the item's own first
 * words, so the content of `- [ ] Step:` starts at column 2 — not at column 6.
 * Measuring the content indent off the whole bullet put every one of the item's
 * other blocks four columns too far in, and four columns past the content start
 * is exactly what turns a *fenced* code block into an **indented** one: the
 * opening ``` stopped being a fence, landed in the item's prose, and the block
 * came back from the next parse as an indented code block holding the fence text.
 */
function listBulletParts(bullet: string): { marker: string; prefix: string } {
  return { marker: /^-\s+\[[ xX]\]/.test(bullet) ? '-' : bullet, prefix: bullet }
}

/** Put `text`'s first line on the item's bullet line, keeping every other line. */
function firstLineOnto(text: string, bulletLine: string, contentIndent: string): string {
  const nl = text.indexOf('\n')
  const first = nl === -1 ? text : text.slice(0, nl)
  const rest = nl === -1 ? '' : text.slice(nl)
  const body = first.startsWith(contentIndent) ? first.slice(contentIndent.length) : first
  return (body ? bulletLine + body : bulletLine.trimEnd()) + rest
}

/**
 * Blocks whose markdown can begin on the item's own marker line.
 *
 * Only the ones that start with their content's own syntax can: a fence, a table
 * and a list all have to open on a line of their own, and a fenced block whose
 * ``` shares a line with `- ` is not a fence at all — it is a backtick run inside
 * the item's paragraph, which is where the block's own text used to end up when
 * the item began with one. Those get the marker line to themselves.
 */
const OPENS_ON_THE_MARKER_LINE = new Set(['paragraph', 'heading', 'blockquote'])

function serializeListItemContent(
  node: ProseNode,
  bullet: string,
  indent: string,
  env: FormulaEnv,
): string {
  const { marker, prefix } = listBulletParts(bullet)
  const contentIndent = indent + ' '.repeat(marker.length + 1)
  const parts: string[] = []
  node.content.forEach((child) => {
    const content = serializeNode(child, contentIndent, env)
    if (content === '') return
    if (parts.length > 0) {
      // A blank line between blocks: without it two paragraphs are read as one
      // long one. It is the one place a list needs a blank line of its own.
      parts.push('\n\n', content)
      return
    }
    // The item's own line. A block that cannot open on it gets the marker to
    // itself, and **no blank line** under it: a blank line there ends the item,
    // and everything below it is read as the document rather than as the item.
    parts.push(
      OPENS_ON_THE_MARKER_LINE.has(child.type.name)
        ? firstLineOnto(content, indent + prefix + ' ', contentIndent)
        : indent + prefix + '\n' + content,
    )
  })
  // An item whose blocks all serialize to nothing is still an item: written as
  // the empty string it is a line of the file with no marker on it, and a list
  // item that is written nowhere is one the next parse does not have back.
  return parts.length === 0 ? indent + prefix : parts.join('')
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

export function proseToMarkdown(doc: ProseNode, env: FormulaEnv = BUILTIN_ENV): string {
  return serializeNode(doc, '', env)
}

export function serializeBlock(node: ProseNode, env: FormulaEnv = BUILTIN_ENV): string {
  return serializeNode(node, '', env)
}

/**
 * Markdown for the content of a selection (`view.state.selection.content()`),
 * so "Copy as Markdown" copies exactly the selected blocks/inlines. The slice's
 * fragment is wrapped in a throwaway doc and serialized with the same path the
 * document itself saves through.
 */
export function sliceMarkdown(
  content: Fragment,
  mdSchema: Schema,
  env: FormulaEnv = BUILTIN_ENV,
): string {
  const doc = mdSchema.nodes.doc.create(null, content)
  return serializeNode(doc, '', env).trim()
}

export function extractBlockMarkdown(
  doc: ProseNode,
  blockOffsets: BlockOffset[],
  blockId: string,
  env: FormulaEnv = BUILTIN_ENV,
): string {
  const offset = blockOffsets.find((o) => o.id === blockId)
  if (!offset) return ''
  const node = doc.resolve(offset.nodePos).node()
  return serializeNode(node, '', env)
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
