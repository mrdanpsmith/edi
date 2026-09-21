import type { EditorView } from 'prosemirror-view'
import type { MarkType } from 'prosemirror-model'
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'
import { TextSelection, Plugin } from 'prosemirror-state'
import { promptForLink } from './urlDialog'
import { insertMaskedFieldCommand } from './node/masked'
import { insertTable } from './node/table'
import { getActiveCellHost, type InlineCellHost, type InlineCellKind } from './inline-format'

const TOOLBAR_VISIBLE_KEY = 'edi.toolbarVisible'

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

/** 24×24 stroke-based icons for the toolbar's file actions. */
export const NEW_ICON = icon(
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/>',
  '0 0 24 24',
)

export const OPEN_ICON = icon(
  '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  '0 0 24 24',
)

export const SAVE_ICON = icon(
  '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
    '<path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  '0 0 24 24',
)

export const SAVE_AS_ICON = icon(
  '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
    '<path d="M17 21v-8H7v8"/><path d="M7 3v5h6"/>' +
    '<path d="M13 12l7 7"/><path d="M12 15l2 2"/>',
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
 * selection. With no selection, insert the URL (or the dialog's optional link
 * text) as the linked text. Bare ``www.`` links are given an ``https://``
 * scheme.
 */
export function applyLink(view: EditorView, url: string, text?: string): boolean {
  const { state, dispatch } = view
  const { from, to } = state.selection
  const linkType = state.schema.marks.link
  const trimmed = url.trim()
  let tr = state.tr
  if (trimmed) {
    const href = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed
    const mark = linkType.create({ href, title: null })
    if (from === to) {
      // No selection: insert the URL itself as the linked text (mirroring how
      // pasting a raw link turns it into a clickable link), unless the dialog
      // supplied an explicit link text.
      const node = state.schema.text(text?.trim() || trimmed, [mark])
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
  const { from, to } = view.state.selection
  const text = view.state.selection.empty ? '' : view.state.doc.textBetween(from, to, '')
  return promptForLink(text, url).then((entered) => {
    if (entered === null) return false
    view.focus()
    return applyLink(view, entered.url, entered.text)
  })
}

export interface ToolbarContext {
  getView(): EditorView
}

/** A toolbar button that runs an app-level action instead of a document command. */
export interface FileActionSpec {
  label: string
  title: string
  className?: string
  markup?: string
  action(): void | Promise<void>
}

interface ButtonSpec {
  label: string
  title: string
  className?: string
  markup?: string
  run(view: EditorView): boolean | Promise<boolean>
  options?: { label: string; run(view: EditorView): boolean | Promise<boolean> }[]
  kind?: 'menu'
  /** When set, the button targets the active spreadsheet cell if one exists. */
  inline?: InlineCellKind
}

const GRID_PICKER_MAX_COLS = 5
const GRID_PICKER_MAX_ROWS = 5

function buildGridPicker(
  host: HTMLElement,
  label: HTMLElement,
  onPick: (cols: number, rows: number) => void,
): void {
  let hoverRow = 0
  let hoverCol = 0
  const paint = (): void => {
    for (let r = 0; r < GRID_PICKER_MAX_ROWS; r++) {
      for (let c = 0; c < GRID_PICKER_MAX_COLS; c++) {
        host
          .querySelector<HTMLElement>(
            `.grid-picker-box[data-r="${r}"][data-c="${c}"]`,
          )
          ?.classList.toggle('grid-picker-hover', r <= hoverRow && c <= hoverCol)
      }
    }
    label.textContent = `${hoverRow + 1} rows × ${hoverCol + 1} columns`
  }
  for (let r = 0; r < GRID_PICKER_MAX_ROWS; r++) {
    for (let c = 0; c < GRID_PICKER_MAX_COLS; c++) {
      const box = document.createElement('div')
      box.className = 'grid-picker-box'
      box.dataset.r = String(r)
      box.dataset.c = String(c)
      box.addEventListener('mouseenter', () => {
        hoverRow = r
        hoverCol = c
        paint()
      })
      box.addEventListener('mousedown', (event) => event.preventDefault())
      box.addEventListener('click', () => onPick(c + 1, r + 1))
      host.appendChild(box)
    }
  }
  paint()
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
          if (target.tagName !== 'INPUT' || !target.matches('[data-task-check]'))
            return false
          const li = target.closest('li[data-checked]')
          if (!li) return false
          event.preventDefault()
          const { state, dispatch } = view
          const liPos = view.posAtDOM(li, 0)
          const $li = state.doc.resolve(liPos)
          const liRes = findListItemAncestor($li)
          if (!liRes) return false
          const liNode = $li.node(liRes.depth)
          if (liNode.attrs.checked === null) return false
          const newChecked = liNode.attrs.checked === false ? true : false
          const itemPos = $li.before(liRes.depth)
          dispatch(state.tr.setNodeMarkup(itemPos, undefined, { checked: newChecked }))
          return true
        },
      },
    },
  })
}

/**
 * The four standard file actions (New/Open/Save/Save As) shown at the front of
 * the toolbar. The actions here are placeholders: `main.ts` wires the real
 * document actions in when it constructs the `Toolbar`.
 */
export function getFileButtons(): FileActionSpec[] {
  return [
    { label: 'New', title: 'New (Ctrl+N)', markup: NEW_ICON, action: () => undefined },
    { label: 'Open', title: 'Open… (Ctrl+O)', markup: OPEN_ICON, action: () => undefined },
    { label: 'Save', title: 'Save (Ctrl+S)', markup: SAVE_ICON, action: () => undefined },
    { label: 'Save As', title: 'Save As… (Ctrl+Shift+S)', markup: SAVE_AS_ICON, action: () => undefined },
  ]
}

export function getFormattingButtons(_ctx: ToolbarContext): ButtonSpec[] {
  return [
    { label: 'B', title: 'Bold (Ctrl+B)', className: 'toolbar-bold', inline: 'bold', run: (view) => toggleMarkCmd(view.state.schema.marks.strong)(view) },
    { label: 'I', title: 'Italic (Ctrl+I)', className: 'toolbar-italic', inline: 'italic', run: (view) => toggleMarkCmd(view.state.schema.marks.em)(view) },
    { label: 'S', title: 'Strikethrough', className: 'toolbar-strike', inline: 'strike', run: (view) => toggleMarkCmd(view.state.schema.marks.strikethrough)(view) },
    { label: 'Link', title: 'Hyperlink', markup: LINK_ICON, inline: 'link', run: hyperlinkRun },
    {
      label: 'Highlight', title: 'Highlight', markup: icon(
        '<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#fde047" stroke="none"/>' +
        '<text x="8" y="12" text-anchor="middle" font-size="11" font-family="var(--font-sans)" stroke="none" fill="currentColor">a</text>',
      ),
      inline: 'highlight',
      run: (view) => toggleMarkCmd(view.state.schema.marks.highlight)(view),
    },
    { label: 'Sub', title: 'Subscript', inline: 'sub', run: (view) => toggleMarkCmd(view.state.schema.marks.sub)(view) },
    { label: 'Sup', title: 'Superscript', inline: 'sup', run: (view) => toggleMarkCmd(view.state.schema.marks.sup)(view) },
    {
      label: 'Normal', title: 'Heading', className: 'toolbar-heading',
      run: (view) => setBlockType(view.state.schema.nodes.paragraph)(view.state, view.dispatch),
      options: [
        { label: 'Normal', run: (view) => setBlockType(view.state.schema.nodes.paragraph)(view.state, view.dispatch) },
        ...Array.from({ length: 6 }, (_, i) => ({
          label: `Heading ${i + 1}`,
          run: (view: EditorView) => setBlockType(view.state.schema.nodes.heading, { level: i + 1 })(view.state, view.dispatch),
        })),
      ],
    },
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
      inline: 'code',
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
    {
      label: 'Encrypted field', title: 'Insert encrypted field', markup: icon(
        '<rect x="3.25" y="7" width="9.5" height="6.5" rx="1.2"/>' +
        '<path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7"/>' +
        '<circle cx="8" cy="10.2" r="0.7" fill="currentColor" stroke="none"/>',
      ),
      inline: 'secret',
      run: (view) => insertMaskedFieldCommand(view),
    },
    {
      kind: 'menu',
      label: 'Table', title: 'Insert table',
      markup: icon(
        '<rect x="2" y="2" width="12" height="12" rx="1"/>' +
        '<path d="M2 6h12M2 10h12M6 2v12M10 2v12"/>',
      ),
      run: () => false,
    },
  ]
}

export class Toolbar {
  private visible: boolean

  constructor(
    private readonly bar: HTMLElement,
    private readonly ctx: ToolbarContext,
    private readonly fileActions: FileActionSpec[] = [],
  ) {
    this.visible = readBool(TOOLBAR_VISIBLE_KEY, true)
    this.build()
    this.applyVisibility()
    updateBlockTypeSelect(this.ctx.getView())
  }

  isVisible(): boolean {
    return this.visible
  }

  toggle(): void {
    this.setVisible(!this.visible)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    localStorage.setItem(TOOLBAR_VISIBLE_KEY, String(visible))
    this.applyVisibility()
  }

  private applyVisibility(): void {
    this.bar.hidden = !this.visible
  }

  private build(): void {
    if (this.fileActions.length > 0) {
      for (const spec of this.fileActions) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = spec.className ? `toolbar-btn ${spec.className}` : 'toolbar-btn'
        button.title = spec.title
        button.ariaLabel = spec.title
        if (spec.markup) {
          button.innerHTML = spec.markup
        } else {
          button.textContent = spec.label
        }
        // File actions run directly; unlike format buttons they must not steal
        // focus from the editor (a menu-driven Open/Save prompt is modal anyway).
        button.addEventListener('click', () => {
          void spec.action()
        })
        this.bar.append(button)
      }
      const separator = document.createElement('span')
      separator.className = 'toolbar-separator'
      separator.setAttribute('aria-hidden', 'true')
      this.bar.append(separator)
    }
    for (const spec of getFormattingButtons(this.ctx)) {
      if (spec.kind === 'menu') {
        const host = document.createElement('span')
        host.className = 'toolbar-menu-host'
        const button = document.createElement('button')
        button.type = 'button'
        button.className = spec.className ? `toolbar-btn ${spec.className}` : 'toolbar-btn'
        button.title = spec.title
        button.ariaLabel = spec.title
        if (spec.markup) button.innerHTML = spec.markup
        else button.textContent = spec.label

        const popover = document.createElement('div')
        popover.className = 'toolbar-popover'
        popover.hidden = true
        const label = document.createElement('div')
        label.className = 'grid-picker-label'
        const gridHost = document.createElement('div')
        gridHost.className = 'grid-picker'
        popover.append(label, gridHost)

        // The popover is `position: fixed` so the horizontal-scrolling toolbar
        // (`overflow-x: auto`) can't clip it; anchor it to the button's viewport
        // rect each time it opens and keep it pinned while it is open.
        const position = (): void => {
          const rect = button.getBoundingClientRect()
          popover.style.left = `${Math.round(rect.left)}px`
          popover.style.top = `${Math.round(rect.bottom + 4)}px`
        }
        const detachReposition = (): void => {
          this.bar.removeEventListener('scroll', position)
          window.removeEventListener('resize', position)
        }
        const close = (): void => {
          popover.hidden = true
          detachReposition()
        }
        const closeOnOutside = (event: MouseEvent): void => {
          if (!host.contains(event.target as Node)) close()
        }
        button.addEventListener('click', () => {
          const view = this.ctx.getView()
          view.focus()
          popover.hidden = !popover.hidden
          if (popover.hidden) {
            detachReposition()
            return
          }
          position()
          this.bar.addEventListener('scroll', position, { passive: true })
          window.addEventListener('resize', position)
          document.addEventListener('mousedown', closeOnOutside, { once: true })
        })
        buildGridPicker(gridHost, label, (cols, rows) => {
          const view = this.ctx.getView()
          view.focus()
          insertTable(view, cols, rows)
          close()
        })

        host.append(button, popover)
        this.bar.append(host)
        continue
      }
      if (spec.options) {
        const select = document.createElement('select')
        select.className = spec.className ? `toolbar-btn ${spec.className} toolbar-select` : 'toolbar-btn toolbar-select'
        select.title = spec.title
        select.ariaLabel = spec.title
        for (const option of spec.options) {
          const el = document.createElement('option')
          el.textContent = option.label
          select.append(el)
        }
        select.addEventListener('change', () => {
          const index = select.selectedIndex
          select.selectedIndex = 0
          const option = spec.options?.[index]
          if (!option) return
          const view = this.ctx.getView()
          view.focus()
          option.run(view)
        })
        this.bar.append(select)
        continue
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = spec.className ? `toolbar-btn ${spec.className}` : 'toolbar-btn'
      button.title = spec.title
      button.ariaLabel = spec.title
      if (spec.markup) {
        button.innerHTML = spec.markup
      } else {
        button.textContent = spec.label
      }
      // The Link button needs the cell's live edit selection, but the dialog
      // (and the button's own focus change) blur and commit the in-cell editor
      // first. Snapshot the host and its link context on mousedown so the cell
      // is still targetable at click time even if focus games clear the live
      // active-host registry in between.
      let cellLinkContext: { host: InlineCellHost; text: string; url: string } | null = null
      button.addEventListener('mousedown', () => {
        if (spec.inline !== 'link') return
        const activeHost = getActiveCellHost()
        if (!activeHost) return
        const { text, url } = activeHost.beginCellLink()
        cellLinkContext = { host: activeHost, text, url }
      })
      button.addEventListener('click', () => {
        const view = this.ctx.getView()
        if (spec.inline === 'link') {
          const captured = cellLinkContext
          cellLinkContext = null
          if (captured) {
            void promptForLink(captured.text, captured.url).then((entered) => {
              if (entered !== null) captured.host.applyCellLink(entered.text, entered.url)
            })
            return
          }
          const host = getActiveCellHost()
          if (host) {
            void promptForLink('', '').then((entered) => {
              if (entered !== null) host.applyInline('link', entered.url)
            })
            return
          }
          view.focus()
          spec.run(view)
          return
        }
        const host = getActiveCellHost()
        if (spec.inline && host) {
          host.applyInline(spec.inline)
          return
        }
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

/**
 * Keep the heading dropdown (`<select class="toolbar-heading toolbar-select">`
 * in the document) showing the block the cursor is actually in: "Normal" for
 * plain paragraphs and any other textblock, else the heading level. Runs on
 * every view update so typing, selecting, undoing, and toolbar clicks all stay
 * in sync. No-ops while the toolbar (and its select) do not exist yet.
 */
export function updateBlockTypeSelect(view: EditorView): void {
  const select = document.querySelector<HTMLSelectElement>('.toolbar-heading.toolbar-select')
  if (!select) return
  const parent = view.state?.selection?.$from?.parent
  if (!parent) return
  let index = 0
  if (parent.type.name === 'heading') {
    index = Math.min(6, Math.max(1, Number(parent.attrs.level) || 1))
  }
  if (select.selectedIndex !== index) select.selectedIndex = index
}

export function blockTypeSelectPlugin(): Plugin {
  return new Plugin({
    view(view) {
      updateBlockTypeSelect(view)
      return { update: updateBlockTypeSelect }
    },
  })
}