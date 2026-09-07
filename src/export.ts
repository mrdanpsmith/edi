import type { Node as ProseNode } from 'prosemirror-model'
import { DOMSerializer } from 'prosemirror-model'
import { schema } from './schema'
import { computeSpreadsheet } from './spreadsheet'
import { escapeHtml } from './utils'

const EXPORT_CSS = `
:root {
  --bg: #ffffff;
  --surface: #f6f8fa;
  --border: #d0d7de;
  --text-primary: #1f2328;
  --text-secondary: #59636e;
  --text-muted: #818b98;
  --accent: #0969da;
  --danger: #d1242f;
  --md-heading: #1f2328;
  --md-link: #0969da;
  --md-quote: #59636e;
  --md-code: #7a3e9d;
  --md-code-keyword: #cf222e;
  --md-code-string: #0a3069;
  --exec-bg: #0d1117;
  --exec-fg: #e6edf3;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #3d444d;
    --text-primary: #e6edf3;
    --text-secondary: #b1bac4;
    --text-muted: #8b949e;
    --accent: #4493f8;
    --danger: #f85149;
    --md-heading: #e6edf3;
    --md-link: #4493f8;
    --md-quote: #8b949e;
    --md-code: #d2a8ff;
    --md-code-keyword: #ff7b72;
    --md-code-string: #a5d6ff;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg);
  overflow-wrap: break-word;
}

.md-preview {
  padding: 16px 24px 48px;
}

.md-preview h1,
.md-preview h2,
.md-preview h3,
.md-preview h4,
.md-preview h5,
.md-preview h6 {
  color: var(--md-heading);
  line-height: 1.25;
  margin: 1.5em 0 0.5em;
}

.md-preview h1:first-child {
  margin-top: 0.4em;
}

.md-preview h1 {
  font-size: 1.9em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3em;
}

.md-preview h2 {
  font-size: 1.5em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.3em;
}

.md-preview h3 {
  font-size: 1.25em;
}

.md-preview a {
  color: var(--md-link);
  text-decoration: none;
}

.md-preview a:hover {
  text-decoration: underline;
}

.md-preview blockquote {
  margin: 0.5em 0;
  padding: 0 1em;
  border-left: 4px solid var(--border);
  color: var(--md-quote);
}

.md-preview code {
  font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: var(--surface);
  border-radius: 4px;
  padding: 0.15em 0.35em;
}

.md-preview pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
}

.md-preview pre code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: 0.88em;
}

.md-preview table {
  border-collapse: collapse;
  margin: 1em 0;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}

.md-preview th,
.md-preview td {
  border: 1px solid var(--border);
  padding: 6px 13px;
}

.md-preview th {
  background: var(--surface);
  font-weight: 600;
}

.md-preview td.spreadsheet-formula {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.md-preview td.spreadsheet-formula.spreadsheet-error {
  color: var(--danger);
  font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace;
  font-size: 0.85em;
}

.md-preview ul,
.md-preview ol {
  padding-left: 2em;
}

.md-preview li + li {
  margin-top: 0.25em;
}

.md-preview li[data-checked] {
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 0;
}

.md-preview li[data-checked] > input[type='checkbox'] {
  margin: 0 0.4em 0 0;
  margin-top: 0.35em;
  flex-shrink: 0;
  cursor: pointer;
  accent-color: var(--accent);
}

.md-preview li[data-checked] p {
  margin: 0;
}

.md-preview hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1.5em 0;
}

.md-preview .mermaid {
  margin: 1em 0;
  overflow-x: auto;
}

.md-preview .masked-field {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 4px;
  padding: 0 4px;
  font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace;
  font-size: 0.9em;
  color: var(--text-secondary);
  white-space: nowrap;
}

.md-preview .mermaid svg {
  display: block;
  margin: 0 auto;
}

.md-preview .mermaid-error {
  border: 1px solid var(--danger);
  border-radius: 6px;
  color: var(--danger);
  background: var(--surface);
  padding: 10px 14px;
  margin: 1em 0;
  font-family: ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace;
  font-size: 0.85em;
}
`

export function serializeDocToHtml(doc: ProseNode): string {
  const base = DOMSerializer.fromSchema(schema)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes: Record<string, (node: ProseNode) => any> = { ...base.nodes }

  nodes.mermaid_block = (node) => {
    const value = String(node.attrs.value ?? '')
    return ['div', { class: 'mermaid' }, value]
  }

  nodes.masked_field = (node) => {
    const label = String(node.attrs.label ?? '')
    return ['span', { class: 'masked-field' }, label ? `•••••••••••• (${label})` : '••••••••••••']
  }

  nodes.source_block = (node) => {
    const markdown = String(node.attrs.markdown ?? '')
    return ['pre', ['code', markdown]]
  }

  nodes.list_item = (node) => {
    const checked = node.attrs.checked as boolean | null
    if (checked === null) return ['li', 0]
    return [
      'li', { 'data-checked': String(checked) },
      ['input', { type: 'checkbox', 'data-task-check': '', disabled: true, ...(checked ? { checked: true } : {}) }],
      ['div', 0],
    ]
  }

  const serializer = new DOMSerializer(nodes, base.marks)
  const fragment = serializer.serializeFragment(doc.content)
  const div = document.createElement('div')
  div.className = 'md-preview'
  div.appendChild(fragment)
  computeSpreadsheet(div)
  return div.outerHTML
}

export function buildExportHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>${EXPORT_CSS}</style>
  </head>
  <body>
${bodyHtml}
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    <script>
      mermaid.initialize({startOnLoad:false,theme:'default'})
      mermaid.run({ querySelector: '.mermaid' })
        .catch(() => {})
        .finally(() => {
          for (const svg of document.querySelectorAll('.mermaid svg')) {
            const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/\\s+/).map(Number)
            svg.style.height = 'auto'
            svg.style.maxWidth = 'none'
            if (parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0) {
              svg.style.width = parts[2] + 'px'
            }
          }
        })
    </script>
  </body>
</html>
`
}
