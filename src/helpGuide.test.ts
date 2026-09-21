import { describe, expect, it } from 'vitest'

import { buildHelpGuideMarkdown } from './helpGuide'

describe('buildHelpGuideMarkdown', () => {
  const guide = buildHelpGuideMarkdown()

  it('has a title and the expected sections', () => {
    expect(guide).toContain('# Edi Guide')
    for (const section of [
      '## Tabs, menus, and shortcuts',
      '## Spreadsheet tables',
      '## Defining your own functions',
      '## Masked fields',
      '## Mermaid diagrams',
      '## Runnable code blocks',
      '## Export',
    ]) {
      expect(guide).toContain(section)
    }
  })

  it('leads with the file-action shortcuts and toolbar', () => {
    expect(guide).toContain('`Ctrl+N` new, `Ctrl+W` close, `Ctrl+O` open,')
    expect(guide).toContain('`Ctrl+S` save, `Ctrl+Shift+S` save as, `Ctrl+Q` quit.')
    expect(guide).toContain('`View → Toolbar`')
  })

  it('covers the spreadsheet essentials', () => {
    expect(guide).toContain('`Insert → Table…`')
    expect(guide).toContain('`Insert → Spreadsheet…`')
    expect(guide).toContain('imports a CSV/TSV/ODS/XLSX')
    expect(guide).toContain('`$B$2`')
    expect(guide).toContain('`B2:C4`')
    expect(guide).toContain('the `fx` bar')
    expect(guide).toContain('**Use values**')
    expect(guide).toContain('**Resolve formulas?**')
    expect(guide).toContain('`Help → Formula Reference…` lists every function')
  })

  it('documents the edi-formula DSL', () => {
    expect(guide).toContain('```edi-formula')
    expect(guide).toContain('TAX(amount) = ROUND(amount * 0.2, 2)')
    expect(guide).toContain('`=TAX(B2)`')
  })

  it('documents masked fields without leaking specifics', () => {
    expect(guide).toContain('**Insert encrypted field**')
    expect(guide).toContain('`!masked[…]{label="…"}`')
    expect(guide).toContain('plaintext never appears in the document source')
  })

  it('documents mermaid and runnable blocks', () => {
    expect(guide).toContain('tagged `mermaid` renders as a diagram')
    expect(guide).toContain('Copy as image / Save as image')
    expect(guide).toContain('#!/usr/bin/env python3')
    expect(guide).toContain('**Run** button')
  })

  it('documents the export shortcut', () => {
    expect(guide).toContain('`Ctrl+Shift+E` exports the rendered preview')
  })
})