import type { EditorView } from 'prosemirror-view'
import type { MarkType } from 'prosemirror-model'
import { wrapIn, setBlockType, toggleMark } from 'prosemirror-commands'

const FORMATTING_VISIBLE_KEY = 'edi.formattingVisible'

function icon(markup: string, viewBox = '0 0 16 16'): string {
  return (
    `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" ` +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${markup}</svg>`
  )
}

const BULLET_LINES = '<path d="M7 4h7M7 8h7M7 12h7"/>'

export interface FormatToolbarContext {
  getView(): EditorView
}

interface ButtonSpec {
  label: string
  title: string
  className?: string
  markup?: string
  run(view: EditorView): boolean
}

function toggleMarkCmd(markType: MarkType): (view: EditorView) => boolean {
  return (view) => toggleMark(markType)(view.state, view.dispatch)
}

function wrapInList(nodeType: string): (view: EditorView) => boolean {
  return (view) => {
    const { state, dispatch } = view
    const outerType = state.schema.nodes[nodeType]
    const liType = state.schema.nodes.list_item
    if (!outerType || !liType) return false
    const $from = state.selection.$from
    const $to = state.selection.$to
    const range = $from.blockRange($to)
    if (!range) return false
    dispatch(state.tr.wrap(range, [
      { type: liType },
      { type: outerType },
    ]))
    return true
  }
}

export function getButtons(_ctx: FormatToolbarContext): ButtonSpec[] {
  return [
    { label: 'B', title: 'Bold (Ctrl+B)', className: 'fmt-bold', run: (view) => toggleMarkCmd(view.state.schema.marks.strong)(view) },
    { label: 'I', title: 'Italic (Ctrl+I)', className: 'fmt-italic', run: (view) => toggleMarkCmd(view.state.schema.marks.em)(view) },
    { label: 'S', title: 'Strikethrough', className: 'fmt-strike', run: (view) => toggleMarkCmd(view.state.schema.marks.strikethrough)(view) },
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
        view.dispatch(state.tr.replaceSelectionWith(node))
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
      run: (view) => {
        const { state } = view
        const node = state.schema.nodes.code_block.create()
        view.dispatch(state.tr.replaceSelectionWith(node))
        return true
      },
    },
    {
      label: 'Bullet list', title: 'Bullet list', markup: icon(
        '<circle cx="3" cy="4" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="3" cy="12" r="1"/>' + BULLET_LINES,
      ),
      run: wrapInList('bullet_list'),
    },
    {
      label: 'Numbered list', title: 'Numbered list', markup: icon(
        '<text x="3" y="4.5" text-anchor="middle" font-size="5.5" font-family="var(--font-sans)" stroke="none" fill="currentColor">1</text>' +
        '<text x="3" y="9" text-anchor="middle" font-size="5.5" font-family="var(--font-sans)" stroke="none" fill="currentColor">2</text>' +
        '<text x="3" y="13.5" text-anchor="middle" font-size="5.5" font-family="var(--font-sans)" stroke="none" fill="currentColor">3</text>' +
        BULLET_LINES,
      ),
      run: wrapInList('ordered_list'),
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
