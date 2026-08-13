import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'

import { execLanguage, renderExecBlock } from './exec'

export const MERMAID_LANG = 'mermaid'
export const MERMAID_CLASS = 'mermaid'

export function escapeHtml(value: string): string {
  return value.replace(/[<>&]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      default:
        return '&amp;'
    }
  })
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})

md.use(taskLists, { enabled: true, label: true, labelAfter: true })

const defaultFenceRule = md.renderer.rules.fence?.bind(md.renderer.rules)

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const info = token.info.trim()
  if (info === MERMAID_LANG) {
    const source = escapeHtml(token.content)
    return `<div class="${MERMAID_CLASS}" data-state="pending"><noscript></noscript>${source}</div>`
  }
  const language = execLanguage(info)
  if (language) {
    return renderExecBlock(language, token.content)
  }
  return defaultFenceRule!(tokens, idx, options, env, self)
}

export function renderMarkdown(source: string): string {
  return md.render(source)
}

export function renderPreview(source: string): string {
  return `<article class="md-preview">${renderMarkdown(source)}</article>`
}

export function collectPendingMermaid(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}[data-state="pending"]`))
}
