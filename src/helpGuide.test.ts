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
    expect(guide).toContain('`View → Hover Band`')
  })

  it('says how a link is opened and edited', () => {
    expect(guide).toContain('Click a link to open it; right-click one to edit')
    expect(guide).toContain('removes the link and keeps the text')
  })

  it('documents the formatting shortcuts and the arrow keys that leave a mark', () => {
    expect(guide).toContain('`Ctrl+B`, italic `Ctrl+I`, inline code `Ctrl+Alt+C`')
    expect(guide).toContain('`→` at the end of one and')
    expect(guide).toContain('The text')
    expect(guide).toContain('already written keeps its formatting.')
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
    expect(guide).toContain('Copy image / Save image…')
    expect(guide).toContain('#!/usr/bin/env python3')
    expect(guide).toContain('**Run** button')
  })

  it('says which mermaid labels are clickable', () => {
    expect(guide).toContain('Only labels that can be rewritten are clickable.')
    expect(guide).toContain('computed')
    expect(guide).toContain('renames the references with it')
  })

  it('documents the export action, and says it has no shortcut', () => {
    // It used to claim Ctrl+Shift+E, which the Export QAction's label made Qt
    // swallow — so the page's own block-source toggle never fired and block
    // source mode had no working keyboard entry. The Export label carries none
    // now; the guide says so, so the shortcut table and the app agree.
    expect(guide).toContain('`File → Export HTML…` exports the rendered document')
    expect(guide).not.toContain('`Ctrl+Shift+E` exports')
  })

  it('documents the block controls, and never the removed dot grid', () => {
    expect(guide).toContain('**Source** shows that')
    expect(guide).toContain('**Visual** brings the rendering back')
    expect(guide).toContain('`Ctrl+Shift+E`')
    expect(guide).toContain('`Alt+click`')
    // The handle on the left edge is gone — one cluster at the right edge
    // replaced it — and a guide that still teaches it is worse than none.
    expect(guide).not.toContain('handle on a block')
    expect(guide).not.toContain("block's left edge")
  })
})