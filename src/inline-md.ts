// Inline markdown model for spreadsheet cells. Cells are inline-only content,
// so every cell is parsed with micromark (the same engine — and plugins —
// as the document parser); the resulting marked runs drive cell formatting
// toggles (bold/italic/strike/code/highlight/sub/sup), cell display (grid +
// plain view), and HTML export from one source of truth. This means combined
// marks (`***bold***`, `` **bold `code`** ``, `==highlight ~~strike~~==`)
// parse, toggle, display and export identically to how the regular editor
// treats overlapping marks.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import type { Content, Root } from 'mdast'
import { highlight } from './remark/highlight'
import { subscript } from './remark/sub'
import { superscript } from './remark/sup'
import { remarkPlugin as maskedFieldRemarkPlugin, maskedFieldToMarkdown } from './node/masked'
import { isMisleadingLink } from './linkSecurity'

export type CellMark = 'strong' | 'em' | 'del' | 'code' | 'highlight' | 'sub' | 'sup'

/**
 * A cell's content split into runs that share the same inline marks. A run is
 * either plain/inline-marked text, or a masked-field pill (whose `text` is
 * empty and `masked` carries the ciphertext + label).
 */
export interface CellSegment {
  text: string
  marks: CellMark[]
  href: string | null
  hrefTitle: string | null
  masked: { content: string; label: string } | null
}

/** The mdast nodes the custom remark plugins inject (masked fields, plus the
 * highlight/subscript/superscript paired delimiters). Not part of the
 * @types/mdast union, so they are added here. */
type CustomInlineNode =
  | { type: 'masked_field'; content?: string; label?: string }
  | { type: 'highlight'; children: Content[] }
  | { type: 'sub'; children: Content[] }
  | { type: 'sup'; children: Content[] }

const MASKED_BULLETS = '••••••••••••'

function plainSegment(text: string): CellSegment {
  return { text, marks: [], href: null, hrefTitle: null, masked: null }
}

let cachedProcessor: ReturnType<typeof buildProcessor> | null = null
function processor(): ReturnType<typeof buildProcessor> {
  if (!cachedProcessor) cachedProcessor = buildProcessor()
  return cachedProcessor
}

function buildProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(highlight.remarkPlugin)
    .use(subscript.remarkPlugin)
    .use(superscript.remarkPlugin)
    .use(maskedFieldRemarkPlugin)
    .use(remarkStringify)
}

/**
 * Parse a cell's raw text into marked runs. The cell is inline-only: if the
 * source parses as anything other than a single paragraph (heading, list,
 * blockquote, fence…), the whole string is returned as one literal run with no
 * marks.
 */
export function parseCellSegments(raw: string): CellSegment[] {
  const root = processor().parse(raw) as Root
  const first = root.children[0]
  if (root.children.length === 1 && first?.type === 'paragraph') {
    return walkInline(first.children)
  }
  if (raw.trim() === '') return []
  return [plainSegment(raw)]
}

function walkInline(
  children: readonly (Content | CustomInlineNode)[],
  marks: CellMark[] = [],
  href: string | null = null,
  hrefTitle: string | null = null,
): CellSegment[] {
  const out: CellSegment[] = []
  for (const child of children) {
    switch (child.type) {
      case 'text':
      case 'html':
        out.push({
          text: (child as { value?: string }).value ?? '',
          marks: [...marks],
          href,
          hrefTitle,
          masked: null,
        })
        break
      case 'inlineCode':
        out.push({
          text: (child as { value?: string }).value ?? '',
          marks: [...marks, 'code'],
          href,
          hrefTitle,
          masked: null,
        })
        break
      case 'strong':
        out.push(...walkInline(child.children, [...marks, 'strong'], href, hrefTitle))
        break
      case 'emphasis':
        out.push(...walkInline(child.children, [...marks, 'em'], href, hrefTitle))
        break
      case 'delete':
        out.push(...walkInline(child.children, [...marks, 'del'], href, hrefTitle))
        break
      case 'link': {
        const link = child as { url?: string; title?: string; children: Content[] }
        out.push(...walkInline(link.children, marks, link.url ?? null, link.title ?? null))
        break
      }
      case 'highlight':
        out.push(...walkInline(child.children, [...marks, 'highlight'], href, hrefTitle))
        break
      case 'sub':
        out.push(...walkInline(child.children, [...marks, 'sub'], href, hrefTitle))
        break
      case 'sup':
        out.push(...walkInline(child.children, [...marks, 'sup'], href, hrefTitle))
        break
      case 'masked_field':
        out.push({ text: '', marks: [...marks], href, hrefTitle, masked: { content: child.content ?? '', label: child.label ?? '' } })
        break
      default: {
        // Unsupported inline node (image, break, …): keep its literal markdown.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        out.push({ text: processor().stringify(child as any), marks: [...marks], href, hrefTitle, masked: null })
      }
    }
  }
  return out
}

// --- Serialization (runs → markdown) ---------------------------------------

const MARK_OPEN: Record<CellMark, string> = {
  strong: '**',
  em: '*',
  del: '~~',
  code: '`',
  highlight: '==',
  sub: '~',
  sup: '^',
}
const MARK_CLOSE: Record<CellMark, string> = MARK_OPEN

/** Canonical outer→inner ordering (mirrors the document serializer's rank
 * order for strong/em/strike/highlight/sub/sup); code stays innermost, like the
 * document serializer, so `` **`code`** `` survives a round trip. */
function orderedMarks(marks: readonly CellMark[]): CellMark[] {
  const order: CellMark[] = ['strong', 'em', 'del', 'highlight', 'sub', 'sup']
  const list = order.filter((m) => marks.includes(m))
  if (marks.includes('code')) list.push('code')
  return list
}

function serializeSegmentPayload(seg: CellSegment): string {
  return seg.masked ? maskedFieldToMarkdown(seg.masked.content, seg.masked.label) : seg.text
}

/**
 * Serialize marked runs back to markdown by streaming, keeping marks (and a
 * link, outermost) open across run boundaries the same way the document body
 * serializer does (`serializeContent` in markdown.ts). This keeps overlapping
 * marks — `**bold** *italic*` → bold across the board → `***bold** italic*` —
 * unambiguous and round-trippable instead of emitting adjacent delimiter runs
 * like `****`.
 */
export function serializeCellSegments(segs: readonly CellSegment[]): string {
  const out: string[] = []
  const stack: CellMark[] = []
  let openUrl = ''
  let openTitle = ''

  const closeLink = () => {
    if (openUrl === '') return
    const title = openTitle ? ` "${openTitle}"` : ''
    out.push(`](${openUrl}${title})`)
    openUrl = ''
    openTitle = ''
  }

  for (const seg of segs) {
    const target = orderedMarks(seg.marks)
    // Close marks the target doesn't share (innermost first).
    while (stack.length && !target.includes(stack[stack.length - 1]!)) {
      out.push(MARK_CLOSE[stack.pop()!])
    }
    const nextUrl = seg.href ?? ''
    if (nextUrl !== openUrl) {
      closeLink()
      if (nextUrl !== '') {
        openUrl = nextUrl
        openTitle = seg.hrefTitle ?? ''
        out.push('[')
      }
    }
    // Open the target marks that aren't open yet, canonical outer→inner order.
    for (const m of target) {
      if (!stack.includes(m)) {
        out.push(MARK_OPEN[m])
        stack.push(m)
      }
    }
    out.push(serializeSegmentPayload(seg))
  }
  while (stack.length) out.push(MARK_CLOSE[stack.pop()!])
  closeLink()
  return out.join('')
}

// --- HTML rendering (runs → escaped HTML) ----------------------------------

function escapeCellHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

const MARK_TAG: Record<CellMark, string> = {
  strong: 'strong',
  em: 'em',
  del: 'del',
  code: 'code',
  highlight: 'mark',
  sub: 'sub',
  sup: 'sup',
}

/** Coalesce adjacent runs with identical mark/link context and plain text so
 * the rendered HTML carries no redundant `</strong><strong>` boundaries.
 * Masked pills never merge. */
function mergeRuns(segs: readonly CellSegment[]): CellSegment[] {
  const out: CellSegment[] = []
  for (const seg of segs) {
    const prev = out[out.length - 1]
    const same =
      prev &&
      !prev.masked &&
      !seg.masked &&
      prev.marks.length === seg.marks.length &&
      prev.marks.every((m, i) => m === seg.marks[i]) &&
      prev.href === seg.href &&
      prev.hrefTitle === seg.hrefTitle
    if (same) {
      prev!.text += seg.text
    } else {
      out.push(seg)
    }
  }
  return out
}

/** Render one segment's marks and payload (without any link wrapper). */
function renderSegmentBody(seg: CellSegment, nextMasked: () => number): string {
  const marks = orderedMarks(seg.marks)
  let out = ''
  for (const m of marks) out += `<${MARK_TAG[m]}>`
  if (seg.masked) {
    const label = seg.masked.label.replace(/[\\`*_{}[\]]~/g, '').replace(/[&<>"']/g, (char) =>
      escapeCellHtml(char),
    )
    const index = nextMasked()
    const attr = index >= 0 ? ` data-edi-masked="${index}"` : ''
    out += `<span class="masked-field"${attr}>${MASKED_BULLETS}${label ? ` (${label})` : ''}</span>`
  } else {
    out += escapeCellHtml(seg.text)
  }
  for (let i = marks.length - 1; i >= 0; i--) out += `</${MARK_TAG[marks[i]!]}>`
  return out
}

/** The visible text a link segment contributes, used to spot a misleading link
 * whose link text claims a different destination than its href. */
function linkRunText(seg: CellSegment): string {
  return seg.masked ? seg.masked.content : seg.text
}

/** Render a cell's raw inline markdown to safe HTML (shared by the grid, the
 * plain view, and HTML export). ``indexedMasked`` gives each masked pill a
 * `data-edi-masked` index matching `listMaskedTokens(raw)` order.
 * ``markMisleading`` (view-only; export omits it) flags anchors whose link text
 * does not match their destination with the same `.ml-misleading` class the
 * document editor decorates links with. */
export function renderCellHtml(
  raw: string,
  indexedMasked = false,
  markMisleading = false,
): string {
  const segs = mergeRuns(parseCellSegments(raw))
  let maskedIndex = 0
  const nextMasked = (): number => (indexedMasked ? maskedIndex++ : -1)
  let out = ''
  let i = 0
  while (i < segs.length) {
    const seg = segs[i]!
    if (seg.href === null) {
      out += renderSegmentBody(seg, nextMasked)
      i++
      continue
    }
    // Emit one anchor per contiguous link run so a link split by nested marks
    // (e.g. `[**a**b](x)`) stays a single <a> and its full text is known.
    let j = i
    let text = ''
    while (j < segs.length && segs[j]!.href === seg.href) {
      text += linkRunText(segs[j]!)
      j++
    }
    const title = seg.hrefTitle ? ` title="${escapeCellHtml(seg.hrefTitle)}"` : ''
    const cls = markMisleading && isMisleadingLink(seg.href, text) ? ' class="ml-misleading"' : ''
    out += `<a href="${escapeCellHtml(seg.href)}"${title}${cls}>`
    for (let k = i; k < j; k++) out += renderSegmentBody(segs[k]!, nextMasked)
    out += '</a>'
    i = j
  }
  return out
}

// --- Formatting toggles (raw → raw) ---------------------------------------

export type CellToggleKind = 'bold' | 'italic' | 'strike' | 'code' | 'highlight' | 'sub' | 'sup'

const MARK_BY_TOGGLE: Record<CellToggleKind, CellMark> = {
  bold: 'strong',
  italic: 'em',
  strike: 'del',
  code: 'code',
  highlight: 'highlight',
  sub: 'sub',
  sup: 'sup',
}

/** True when every text run of the cell already carries the toggle's mark. */
export function cellCarriesMark(raw: string, toggle: CellToggleKind): boolean {
  const mark = MARK_BY_TOGGLE[toggle]
  const segs = parseCellSegments(raw)
  const relevant = segs.filter((s) => s.text.length > 0 || s.masked)
  if (relevant.length === 0) return false
  return relevant.every((s) => s.marks.includes(mark))
}

/** Wrap a plain display string in marks, producing the cell markdown that
 * renders exactly those marks (`styleCellDisplay("5", ["strong"])` →
 * `**5**`). Used to apply a formula cell's outer marks to its computed
 * result. */
export function styleCellDisplay(display: string, marks: readonly CellMark[]): string {
  return serializeCellSegments([
    { text: display, marks: [...marks], href: null, hrefTitle: null, masked: null },
  ])
}

/** Add or remove the toggle's mark on every run of the cell. */
export function setCellMark(raw: string, toggle: CellToggleKind, on: boolean): string {
  const mark = MARK_BY_TOGGLE[toggle]
  const segs = parseCellSegments(raw)
  const next = segs.map((seg) => ({
    ...seg,
    marks: on
      ? seg.marks.includes(mark)
        ? seg.marks
        : [...seg.marks, mark]
      : seg.marks.filter((m) => m !== mark),
  }))
  return serializeCellSegments(next)
}