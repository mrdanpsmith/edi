import MarkdownIt, { type Token } from 'markdown-it'
import deflist from 'markdown-it-deflist'
import footnote from 'markdown-it-footnote'
import markPlugin from 'markdown-it-mark'
import subPlugin from 'markdown-it-sub'
import supPlugin from 'markdown-it-sup'
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
md.use(footnote)
md.use(deflist)
md.use(markPlugin)
md.use(supPlugin)
md.use(subPlugin)

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

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'local'; path: string }
  | { kind: 'fragment'; id: string }

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

export function resolveLinkHref(href: string, docDir: string | undefined): LinkTarget {
  if (href.startsWith('#')) {
    return { kind: 'fragment', id: href.slice(1) }
  }
  if (SCHEME_RE.test(href)) {
    return { kind: 'external', url: href }
  }
  const path = href.split('#')[0] ?? href
  if (!docDir || path.startsWith('/')) {
    return { kind: 'local', path }
  }
  return { kind: 'local', path: `${docDir}/${path}` }
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

const EXPLICIT_ID_RE = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/
const usedSlugs = new Map<string, number>()

function headingPlainText(children: Token[] | null): string {
  if (!children) {
    return ''
  }
  let out = ''
  for (const child of children) {
    if (child.type === 'text' || child.type === 'code_inline') {
      out += child.content
    } else if (child.children) {
      out += headingPlainText(child.children)
    }
  }
  return out
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function uniqueSlug(slug: string): string {
  const count = (usedSlugs.get(slug) ?? 0) + 1
  usedSlugs.set(slug, count)
  return count === 1 ? slug : `${slug}-${count}`
}

const defaultHeadingOpenRule = md.renderer.rules.heading_open?.bind(md.renderer.rules)

md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const inline = tokens[idx + 1]
  const raw = inline?.content ?? ''
  const explicit = EXPLICIT_ID_RE.exec(raw)
  let id: string
  if (explicit) {
    id = explicit[1]
    inline!.content = raw.replace(EXPLICIT_ID_RE, '')
    const children = inline!.children
    const last = children && children[children.length - 1]
    if (last && last.type === 'text') {
      last.content = last.content.replace(EXPLICIT_ID_RE, '')
    }
  } else {
    id = uniqueSlug(slugify(headingPlainText(inline?.children ?? null)))
  }
  if (id) {
    token.attrSet('id', id)
  }
  return defaultHeadingOpenRule
    ? defaultHeadingOpenRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

export function renderMarkdown(source: string, env: PreviewEnv = {}): string {
  usedSlugs.clear()
  return md.render(source, env as MarkdownEnv)
}

export function renderPreview(source: string, env: PreviewEnv = {}): string {
  return `<article class="md-preview">${renderMarkdown(source, env)}</article>`
}

export function collectPendingMermaid(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}[data-state="pending"]`))
}
