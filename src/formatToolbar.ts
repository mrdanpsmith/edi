import type { EditorView } from 'prosemirror-view'
import type { MarkType } from 'prosemirror-model'
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'
import { TextSelection, Plugin } from 'prosemirror-state'
import { promptForUrl } from './urlDialog'

const FORMATTING_VISIBLE_KEY = 'edi.formattingVisible'

function icon(markup: string, viewBox = '0 0 16 16'): string {
  return (
    `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" ` +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${markup}</svg>`
  )
}

const BULLET_LINES = '<path d="M7 4h7M7 8h7M7 12h7"/>'

const LINK_ICON = icon(
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  '0 0 24 24',
)

function findLinkHref(view: EditorView): string {
  const { state } = view
  const linkType = state.schema.marks.link
  if (!state.selection.empty) {
    const mark = linkType.isInSet(state.selection.$from.marks()) ?? null
    if (mark) return mark.attrs.href as string
  }
  const stored = state.storedMarks?.find((m) => m.type.name === 'link') ?? null
  return stored ? (stored.attrs.href as string) : ''
}

/**
 * Apply (or, when ``url`` is empty, remove) a link mark over the current
 * selection. Bare ``www.`` links are given an ``https://`` scheme.
 */
export function applyLink(view: EditorView, url: string): boolean {
  const { state, dispatch } = view
  const { from, to } = state.selection
  const linkType = state.schema.marks.link
  const trimmed = url.trim()
  let tr = state.tr
  if (trimmed) {
    const href = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed
    const mark = linkType.create({ href, title: null })
    if (from === to) {
      // No selection: insert the URL itself as the linked text, mirroring how
      // pasting a raw link turns it into a clickable link.
      const node = state.schema.text(trimmed, [mark])
      tr = tr.insert(from, node)
    } else {
      tr = tr.addMark(from, to, mark)
    }
  } else {
    tr = tr.removeMark(from, to, linkType)
  }
  dispatch(tr)
  return true
}

function hyperlinkRun(view: EditorView): Promise<boolean> {
  const url = findLinkHref(view)
  return promptForUrl(url).then((entered) => {
    if (entered === null) return false
    view.focus()
    return applyLink(view, entered)
  })
}

export interface FormatToolbarContext {
  getView(): EditorView
}

interface ButtonSpec {
  label: string
  title: string
  className?: string
  markup?: string
  run(view: EditorView): boolean | Promise<boolean>
}

function toggleMarkCmd(markType: MarkType): (view: EditorView) => boolean {
  return (view) => toggleMark(markType)(view.state, view.dispatch)
}

function findListAncestor($from: import('prosemirror-model').ResolvedPos): { depth: number; name: string } | null {
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'bullet_list' || name === 'ordered_list') return { depth: d, name }
  }
  return null
}

function mapPosThroughUnwrap(
  pos: number,
  listNode: import('prosemirror-model').Node,
  listStart: number,
  blocks: import('prosemirror-model').Node[],
): number {
  let liOffset = 0
  let blockOffset = 0
  for (let i = 0; i < listNode.childCount; i++) {
    const li = listNode.child(i)
    if (pos < listStart + liOffset + li.nodeSize) {
      const cursorInParagraph = pos - (listStart + liOffset + 2)
      return listStart + blockOffset + Math.max(0, cursorInParagraph)
    }
    liOffset += li.nodeSize
    blockOffset += blocks[i].nodeSize
  }
  return pos
}

function toggleList(nodeType: string): (view: EditorView) => boolean {
  return (view) => {
    const { state, dispatch } = view
    const listType = state.schema.nodes[nodeType]
    if (!listType) return false
    const { selection } = state
    const { $from } = selection

    const current = findListAncestor($from)

    if (current && current.name === nodeType) {
      const listNode = $from.node(current.depth)
      const listStart = $from.before(current.depth)
      const blocks: import('prosemirror-model').Node[] = []
      listNode.forEach((li) => { li.forEach((child) => blocks.push(child)) })
      const tr = state.tr.replaceWith(listStart, listStart + listNode.nodeSize, blocks)

      const anchor = mapPosThroughUnwrap(selection.anchor, listNode, listStart, blocks)
      const head = mapPosThroughUnwrap(selection.head, listNode, listStart, blocks)
      const $anchor = tr.doc.resolve(anchor)
      const $head = tr.doc.resolve(head)
      if ($anchor.parent.inlineContent && $head.parent.inlineContent) {
        tr.setSelection(new TextSelection($anchor, $head))
      }

      dispatch(tr)
      return true
    }

    if (current) {
      const listNode = $from.node(current.depth)
      const pos = $from.before(current.depth)
      dispatch(state.tr.replaceWith(pos, pos + listNode.nodeSize, listType.create(listNode.attrs, listNode.content)))
      return true
    }

    return wrapInList(listType)(state, dispatch)
  }
}

function findListItemAncestor($from: import('prosemirror-model').ResolvedPos): { depth: number } | null {
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'list_item') return { depth: d }
  }
  return null
}

function findTaskListAncestor($from: import('prosemirror-model').ResolvedPos): { depth: number } | null {
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'bullet_list') {
      if (node.childCount > 0 && node.child(0).attrs.checked !== null) return { depth: d }
    }
  }
  return null
}

function toggleTaskList(view: EditorView): boolean {
  const { state, dispatch } = view
  const { $from } = state.selection

  const taskList = findTaskListAncestor($from)
  if (taskList) {
    const listNode = $from.node(taskList.depth)
    const listStart = $from.before(taskList.depth)
    const blocks: import('prosemirror-model').Node[] = []
    listNode.forEach((li) => {
      const item = state.schema.nodes.list_item.create(
        { checked: null },
        li.content,
      )
      blocks.push(item)
    })
    const flat = blocks.length === 1
      ? blocks[0].content
      : undefined
    if (flat) {
      dispatch(state.tr.replaceWith(listStart, listStart + listNode.nodeSize, flat))
    } else {
      const items: import('prosemirror-model').Node[] = []
      listNode.forEach((li) => {
        items.push(state.schema.nodes.list_item.create({ checked: null }, li.content))
      })
      const bullet = state.schema.nodes.bullet_list.create(null, items)
      dispatch(state.tr.replaceWith(listStart, listStart + listNode.nodeSize, bullet))
    }
    return true
  }

  const current = findListAncestor($from)
  if (current) {
    const listNode = $from.node(current.depth)
    const pos = $from.before(current.depth)
    const items: import('prosemirror-model').Node[] = []
    listNode.forEach((li) => {
      const checked = li.attrs.checked !== null ? li.attrs.checked : false
      items.push(state.schema.nodes.list_item.create({ checked }, li.content))
    })
    const bullet = state.schema.nodes.bullet_list.create(null, items)
    dispatch(state.tr.replaceWith(pos, pos + listNode.nodeSize, bullet))
    return true
  }

  const bulletType = state.schema.nodes.bullet_list
  const liType = state.schema.nodes.list_item
  const { selection } = state
  const range = selection.$from.blockRange(selection.$to)
  if (!range) return false
  const items: import('prosemirror-model').Node[] = []
  range.parent.forEach((child, _, i) => {
    if (i >= range.startIndex && i < range.endIndex) {
      items.push(liType.create({ checked: false }, child))
    } else {
      items.push(child)
    }
  })
  const bullet = bulletType.create(null, items)
  dispatch(state.tr.replaceWith(range.start, range.end, bullet))
  return true
}

function insertCodeBlock(view: EditorView): boolean {
  const { state } = view
  const { selection, schema } = state
  const codeBlockType = schema.nodes.code_block

  // Selection spanning content → turn the selected lines into a code block
  if (!selection.empty) {
    const text = state.doc.textBetween(selection.from, selection.to, '\n')
    const node = codeBlockType.create(null, schema.text(text))
    view.dispatch(state.tr.replaceSelectionWith(node))
    return true
  }

  const { $from } = selection
  const depth = $from.depth
  const parent = $from.parent

  // Cursor on an empty block line → insert the code block right there
  if (parent.isTextblock && parent.content.size === 0) {
    const start = $from.before(depth)
    const end = $from.after(depth)
    view.dispatch(state.tr.replaceWith(start, end, codeBlockType.create()))
    return true
  }

  // Otherwise → insert a fresh code block after the block the cursor is on
  view.dispatch(state.tr.insert($from.after(depth), codeBlockType.create()))
  return true
}

export function toggleTaskItems(view: EditorView): boolean {
  const { state, dispatch } = view
  const { $from } = state.selection
  const li = findListItemAncestor($from)
  if (!li) return false
  const liNode = $from.node(li.depth)
  const newChecked = liNode.attrs.checked === false ? true : false
  const pos = $from.before(li.depth)
  dispatch(state.tr.setNodeMarkup(pos, undefined, { checked: newChecked }))
  return true
}

export function taskClickPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click(view, event) {
          const target = event.target as HTMLElement
          const li = target.closest('li[data-checked]')
          if (!li) return false
          const { state, dispatch } = view
          const posAtCoords = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          })
          if (!posAtCoords) return false
          const $pos = state.doc.resolve(posAtCoords.pos)
          for (let d = $pos.depth; d > 0; d--) {
            if ($pos.node(d).type.name === 'list_item') {
              const liNode = $pos.node(d)
              if (liNode.attrs.checked === null) return false
              const newChecked = liNode.attrs.checked === false ? true : false
              const itemPos = $pos.before(d)
              dispatch(state.tr.setNodeMarkup(itemPos, undefined, { checked: newChecked }))
              return true
            }
          }
          return false
        },
      },
    },
  })
}

export function getButtons(_ctx: FormatToolbarContext): ButtonSpec[] {
  return [
    { label: 'B', title: 'Bold (Ctrl+B)', className: 'fmt-bold', run: (view) => toggleMarkCmd(view.state.schema.marks.strong)(view) },
    { label: 'I', title: 'Italic (Ctrl+I)', className: 'fmt-italic', run: (view) => toggleMarkCmd(view.state.schema.marks.em)(view) },
    { label: 'S', title: 'Strikethrough', className: 'fmt-strike', run: (view) => toggleMarkCmd(view.state.schema.marks.strikethrough)(view) },
    { label: 'Link', title: 'Hyperlink', markup: LINK_ICON, run: hyperlinkRun },
    {
      label: 'Highlight', title: 'Highlight', markup: icon(
        '<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#fde047" stroke="none"/>' +
        '<text x="8" y="12" text-anchor="middle" font-size="11" font-family="var(--font-sans)" stroke="none" fill="currentColor">a</text>',
      ),
      run: (view) => toggleMarkCmd(view.state.schema.marks.highlight)(view),
    },
    { label: 'Sub', title: 'Subscript', run: (view) => toggleMarkCmd(view.state.schema.marks.sub)(view) },
    { label: 'Sup', title: 'Superscript', run: (view) => toggleMarkCmd(view.state.schema.marks.sup)(view) },
    { label: 'H1', title: 'Heading 1', className: 'fmt-heading', run: (view) => setBlockType(view.state.schema.nodes.heading, { level: 1 })(view.state, view.dispatch) },
    { label: 'H2', title: 'Heading 2', className: 'fmt-heading', run: (view) => setBlockType(view.state.schema.nodes.heading, { level: 2 })(view.state, view.dispatch) },
    { label: 'H3', title: 'Heading 3', className: 'fmt-heading', run: (view) => setBlockType(view.state.schema.nodes.heading, { level: 3 })(view.state, view.dispatch) },
    {
      label: 'Horizontal rule', title: 'Horizontal rule', markup: icon('<path d="M2.5 8h11"/>'),
      run: (view) => {
        const { state } = view
        const node = state.schema.nodes.horizontal_rule.create()
        const { $from } = state.selection
        if ($from.depth > 0) {
          view.dispatch(state.tr.insert($from.after(1), node))
        } else {
          view.dispatch(state.tr.insert($from.pos, node))
        }
        return true
      },
    },
    { label: 'Quote', title: 'Blockquote', markup: icon(
      '<text x="8" y="15" text-anchor="middle" font-size="17" font-family="var(--font-sans)" stroke="none" fill="currentColor">"</text>',
    ), run: (view) => wrapIn(view.state.schema.nodes.blockquote)(view.state, view.dispatch) },
    {
      label: 'Code', title: 'Inline code', markup: icon('<path d="M5 4 2 8l3 4"/><path d="M11 4l3 4-3 4"/><path d="M9.5 3l-3 10"/>'),
      run: (view) => toggleMarkCmd(view.state.schema.marks.code)(view),
    },
    {
      label: 'Code block', title: 'Code block', markup: icon(
        '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>' +
        '<path d="M4.5 6l2.5 2.5L4.5 11"/><path d="M9 10.5h2.5"/>',
      ),
      run: insertCodeBlock,
    },
    {
      label: 'Bullet list', title: 'Bullet list', markup: icon(
        '<circle cx="3" cy="4" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="3" cy="12" r="1"/>' + BULLET_LINES,
      ),
      run: toggleList('bullet_list'),
    },
    {
      label: 'Numbered list', title: 'Numbered list', markup: icon(
        '<text x="8" y="12" text-anchor="middle" font-size="11" font-family="var(--font-sans)" stroke="none" fill="currentColor">1.</text>',
      ),
      run: toggleList('ordered_list'),
    },
    {
      label: 'Task list', title: 'Task list', markup: icon(
        '<rect x="1.5" y="2.5" width="13" height="13" fill="#3b82f6" stroke="none"/>' +
        '<path d="M4.5 8l2.5 2.5 4.5-4.5" stroke="white" stroke-width="2"/>',
      ),
      run: toggleTaskList,
    },
  ]
}

export class FormatToolbar {
  private visible: boolean

  constructor(
    private readonly bar: HTMLElement,
    private readonly ctx: FormatToolbarContext,
  ) {
    this.visible = readBool(FORMATTING_VISIBLE_KEY, true)
    this.build()
    this.applyVisibility()
  }

  isVisible(): boolean {
    return this.visible
  }

  toggle(): void {
    this.setVisible(!this.visible)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    localStorage.setItem(FORMATTING_VISIBLE_KEY, String(visible))
    this.applyVisibility()
  }

  private applyVisibility(): void {
    this.bar.hidden = !this.visible
  }

  private build(): void {
    for (const spec of getButtons(this.ctx)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = spec.className ? `fmt-btn ${spec.className}` : 'fmt-btn'
      button.title = spec.title
      button.ariaLabel = spec.title
      if (spec.markup) {
        button.innerHTML = spec.markup
      } else {
        button.textContent = spec.label
      }
      button.addEventListener('click', () => {
        const view = this.ctx.getView()
        view.focus()
        spec.run(view)
      })
      this.bar.append(button)
    }
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key)
  return value === null ? fallback : value === 'true'
}
