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

export interface PreviewEnv {
  docDir?: string
}

type MarkdownEnv = Parameters<typeof md.render>[1]

export function resolveImageSrc(src: string, docDir: string | undefined): string {
  if (!docDir || src.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('#')) {
    return src
  }
  return `${docDir}/${src}`
}

const defaultImageRule = md.renderer.rules.image?.bind(md.renderer.rules)

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const src = String(token.attrGet('src') ?? '')
  const docDir = (env as PreviewEnv).docDir
  token.attrSet('src', resolveImageSrc(src, docDir))
  return defaultImageRule!(tokens, idx, options, env, self)
}

const defaultFenceRule = md.renderer.rules.fence?.bind(md.renderer.rules)

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const info = token.info.trim()
  if (info === MERMAID_LANG) {
    const source = escapeHtml(token.content)
    return `<div class="${MERMAID_CLASS}" data-state="pending"><noscript></noscript>${source}</div>`
  }
  const shebang = execLanguage(info, token.content)
  if (shebang) {
    return renderExecBlock(shebang, token.content)
  }
  return defaultFenceRule!(tokens, idx, options, env, self)
}

export function renderMarkdown(source: string, env: PreviewEnv = {}): string {
  return md.render(source, env as MarkdownEnv)
}

export function renderPreview(source: string, env: PreviewEnv = {}): string {
  return `<article class="md-preview">${renderMarkdown(source, env)}</article>`
}

export function collectPendingMermaid(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}[data-state="pending"]`))
}
