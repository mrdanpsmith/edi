import type { EditorView } from '@codemirror/view'

import {
  applyFormatEdit,
  insertHorizontalRule,
  insertLink,
  toggleBlockquote,
  toggleBold,
  toggleCode,
  toggleCodeBlock,
  toggleDefinition,
  toggleHeading,
  toggleHighlight,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleTaskList,
  toggleUnorderedList,
  type FormatFn,
} from './format'

const FORMATTING_VISIBLE_KEY = 'edi.formattingVisible'

function icon(markup: string, viewBox = '0 0 16 16'): string {
  return (
    `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" ` +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${markup}</svg>`
  )
}

const BULLET_LINES = '<path d="M7 4h7M7 8h7M7 12h7"/>'

interface ButtonSpec {
  label: string
  title: string
  className?: string
  markup?: string
  run: FormatFn
}

const BUTTONS: ButtonSpec[] = [
  { label: 'B', title: 'Bold (Ctrl+B)', className: 'fmt-bold', run: toggleBold },
  { label: 'I', title: 'Italic (Ctrl+I)', className: 'fmt-italic', run: toggleItalic },
  {
    label: 'S',
    title: 'Strikethrough (Ctrl+Shift+X)',
    className: 'fmt-strike',
    run: toggleStrikethrough,
  },
  {
    label: 'Highlight',
    title: 'Highlight',
    markup: icon(
      '<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#fde047" stroke="none"/>' +
        '<text x="8" y="12" text-anchor="middle" font-size="11" font-family="var(--font-sans)" ' +
        'stroke="none" fill="currentColor">a</text>',
    ),
    run: toggleHighlight,
  },
  { label: 'H1', title: 'Heading 1', className: 'fmt-heading', run: (doc, from, to) => toggleHeading(doc, from, to, 1) },
  { label: 'H2', title: 'Heading 2', className: 'fmt-heading', run: (doc, from, to) => toggleHeading(doc, from, to, 2) },
  { label: 'H3', title: 'Heading 3', className: 'fmt-heading', run: (doc, from, to) => toggleHeading(doc, from, to, 3) },
  {
    label: 'Horizontal rule',
    title: 'Horizontal rule',
    markup: icon('<path d="M2.5 8h11"/>'),
    run: insertHorizontalRule,
  },
  {
    label: 'Quote',
    title: 'Blockquote',
    markup: icon(
      '<text x="8" y="15" text-anchor="middle" font-size="17" font-family="var(--font-sans)" ' +
        'stroke="none" fill="currentColor">"</text>',
    ),
    run: toggleBlockquote,
  },
  {
    label: 'Code',
    title: 'Inline code',
    markup: icon('<path d="M5 4 2 8l3 4"/><path d="M11 4l3 4-3 4"/><path d="M9.5 3l-3 10"/>'),
    run: toggleCode,
  },
  {
    label: 'Code block',
    title: 'Code block',
    markup: icon(
      '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>' +
        '<path d="M4.5 6l2.5 2.5L4.5 11"/><path d="M9 10.5h2.5"/>',
    ),
    run: toggleCodeBlock,
  },
  {
    label: 'Task list',
    title: 'Task list',
    markup: icon(
      '<rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" stroke="none"/>' +
        '<path d="M4.3 8.2l2.4 2.4 5-5" stroke="#fff"/>',
    ),
    run: toggleTaskList,
  },
  {
    label: 'Bullet list',
    title: 'Bullet list',
    markup: icon(
      '<circle cx="3" cy="4" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="3" cy="12" r="1"/>' + BULLET_LINES,
    ),
    run: toggleUnorderedList,
  },
  {
    label: 'Numbered list',
    title: 'Numbered list',
    markup: icon(
      '<text x="3" y="4.5" text-anchor="middle" font-size="5.5" font-family="var(--font-sans)" ' +
        'stroke="none" fill="currentColor">1</text>' +
        '<text x="3" y="9" text-anchor="middle" font-size="5.5" font-family="var(--font-sans)" ' +
        'stroke="none" fill="currentColor">2</text>' +
        '<text x="3" y="13.5" text-anchor="middle" font-size="5.5" font-family="var(--font-sans)" ' +
        'stroke="none" fill="currentColor">3</text>' +
        BULLET_LINES,
    ),
    run: toggleOrderedList,
  },
  {
    label: 'Definition list',
    title: 'Definition list',
    markup: icon(
      '<path d="M2.5 4h11"/>' +
        '<circle cx="3" cy="8.5" r="0.8"/><path d="M4.5 8.5h8"/>' +
        '<circle cx="3" cy="12.5" r="0.8"/><path d="M4.5 12.5h8"/>',
    ),
    run: toggleDefinition,
  },
  {
    label: 'Link',
    title: 'Insert link',
    markup: icon(
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
        '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
      '0 0 24 24',
    ),
    run: insertLink,
  },
]

export class FormatToolbar {
  private visible: boolean

  constructor(
    private readonly bar: HTMLElement,
    private readonly view: EditorView,
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
    for (const spec of BUTTONS) {
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
      button.addEventListener('click', () => this.run(spec.run))
      this.bar.append(button)
    }
  }

  private run(fn: FormatFn): void {
    const { from, to } = this.view.state.selection.main
    applyFormatEdit(this.view, fn(this.view.state.doc.toString(), from, to))
    this.view.focus()
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key)
  return value === null ? fallback : value === 'true'
}
