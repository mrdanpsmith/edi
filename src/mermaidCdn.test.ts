import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MERMAID_CDN_INTEGRITY, MERMAID_CDN_URL, MERMAID_CDN_VERSION } from './mermaidCdn'
import { buildExportHtml } from './export'

const MERMAID_DIR = resolve(import.meta.dirname, '../node_modules/mermaid')

describe('the Mermaid an export loads', () => {
  it('is the version Edi bundles', () => {
    const pkg = JSON.parse(readFileSync(resolve(MERMAID_DIR, 'package.json'), 'utf8')) as { version: string }
    expect(MERMAID_CDN_VERSION).toBe(pkg.version)
  })

  it('carries the integrity hash of the bundled mermaid.min.js', () => {
    // jsDelivr's /npm/ path serves the package's files byte for byte.
    const bytes = readFileSync(resolve(MERMAID_DIR, 'dist/mermaid.min.js'))
    const hash = `sha384-${createHash('sha384').update(bytes).digest('base64')}`
    expect(MERMAID_CDN_INTEGRITY).toBe(hash)
  })

  it('is loaded pinned and checked', () => {
    const html = buildExportHtml('t', '<div class="mermaid">graph TD</div>')
    expect(html).toContain(
      `<script src="${MERMAID_CDN_URL}" integrity="${MERMAID_CDN_INTEGRITY}" crossorigin="anonymous"></script>`,
    )
  })
})
