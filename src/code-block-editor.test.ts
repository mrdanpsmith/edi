import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'

vi.mock('./bridge', () => ({
  invoke: vi.fn(),
  invokeStream: vi.fn(),
  hasBridge: () => true,
  confirmAction: vi.fn(),
}))

import { schema } from './schema'
import { markdownToProse, proseToMarkdown } from './markdown'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Plugin } from 'prosemirror-state'
import { blockNodeView, BLOCK_NODE_TYPES } from './blockview'
import { codeBlockNodeViewPlugin } from './node/execblock'
import { blockPlugin } from './blockplugin'
import { formulaDefsPlugin } from './formulaDefs'
import { EditorView as CMEditorView } from '@codemirror/view'

function makeView(md: string) {
  const doc = markdownToProse(md, schema)
  const generic = new Plugin({
    props: {
      nodeViews: Object.fromEntries(
        [...BLOCK_NODE_TYPES, 'source_block'].map((name) => [name, blockNodeView]),
      ),
    },
  })
  return new EditorView(document.body, {
    state: EditorState.create({
      doc,
      plugins: [blockPlugin, codeBlockNodeViewPlugin, formulaDefsPlugin, generic],
    }),
  })
}

function cmOf(view: EditorView): CMEditorView {
  const el = view.dom.querySelector('.cm-editor')
  expect(el).toBeTruthy()
  return CMEditorView.findFromDOM(el as HTMLElement)!
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('embedded code editor in code blocks', () => {
  it('uses the CodeMirror editor for a tagged block', () => {
    const view = makeView('```js\nconst x = 1\n```')
    expect(view.dom.querySelector('.code-editor-host')).toBeTruthy()
    expect(view.dom.querySelector('.cm-editor')).toBeTruthy()
    expect(view.dom.querySelector('.runnable-source')).toBeNull()
    view.destroy()
  })

  it('keeps the plain pre for a bare block without a language or shebang', () => {
    const view = makeView('```\nplain text\n```')
    expect(view.dom.querySelector('.code-editor-host')).toBeNull()
    expect(view.dom.querySelector('.cm-editor')).toBeNull()
    expect(view.dom.querySelector('.runnable-source')).toBeTruthy()
    expect(view.dom.querySelector('.runnable-source code')).toBeTruthy()
    view.destroy()
  })

  it('uses the CodeMirror editor for a runnable shebang block', () => {
    const view = makeView('```\n#!/usr/bin/env python3\nprint(1)\n```')
    expect(view.dom.querySelector('.cm-editor')).toBeTruthy()
    expect(view.dom.querySelector('.cm-content')?.textContent).toContain('#!')
    expect(view.dom.querySelector('.exec-run')).toBeTruthy()
    view.destroy()
  })

  it('shows line numbers in the code editor', () => {
    const view = makeView('```js\nconst x = 1\nconst y = 2\n```')
    expect(view.dom.querySelector('.cm-gutter')).toBeTruthy()
    view.destroy()
  })

  it('displays a language badge for tagged, shebang, and formula blocks', () => {
    const tagged = makeView('```python\nx = 1\n```')
    expect(tagged.dom.querySelector('.code-lang-bar')?.getAttribute('data-language')).toBe('python')
    tagged.destroy()

    const shebang = makeView('```\n#!/bin/sh\necho hi\n```')
    expect(shebang.dom.querySelector('.code-lang-bar')?.getAttribute('data-language')).toBe('sh')
    shebang.destroy()

    const formula = makeView('```edi-formula\nF(x) = x\n```')
    expect(formula.dom.querySelector('.code-lang-bar')?.getAttribute('data-language')).toBe(
      'edi-formula',
    )
    formula.destroy()
  })

  it('does not show a badge for a bare block', () => {
    const view = makeView('```\nno badge\n```')
    expect(view.dom.querySelector('.code-lang-bar')).toBeNull()
    view.destroy()
  })

  it('commits editor changes back into the ProseMirror document', () => {
    const view = makeView('```js\nconst x = 1\n```')
    const cm = cmOf(view)
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: 'const y = 2;\n' } })
    expect(proseToMarkdown(view.state.doc)).toContain('const y = 2;')
    view.destroy()
  })

  it('mirrors a PM-side change into the editor without echoing it back', () => {
    const view = makeView('```js\nconst x = 1\n```')
    const pos = (() => {
      let p = -1
      view.state.doc.forEach((_n, offset) => {
        if (p < 0) p = offset
      })
      return p
    })()
    view.dispatch(view.state.tr.insertText('// note\n', pos + 1))
    const content = view.dom.querySelector('.cm-content')
    expect(content?.textContent).toContain('// note')
    expect(proseToMarkdown(view.state.doc)).toContain('// note')
    view.destroy()
  })

  it('editing inside a shebang editor calls the backend with the new source', () => {
    const view = makeView('```\n#!/usr/bin/env python3\nprint(1)\n```')
    const cm = cmOf(view)
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: '#!/usr/bin/env python3\nprint(2)\n' } })
    const md = proseToMarkdown(view.state.doc)
    expect(md).toContain('print(2)')
    expect(md).not.toContain('print(1)')
    view.destroy()
  })
})

describe('edi-formula live errors', () => {
  it('shows no error rows for a valid formula block', () => {
    const view = makeView('```edi-formula\nGREET(name) = CONCAT("Hi ", name)\n```')
    expect(view.dom.querySelector('.formula-error-row')).toBeNull()
    expect(view.dom.querySelector('.code-lang-badge')?.textContent).toContain('edi-formula')
    view.destroy()
  })

  it('lists per-line issues from the body validator', () => {
    const view = makeView('```edi-formula\nOK(x) = x\nF(x) = ROUNDU(x, 2)\n```')
    const rows = Array.from(view.dom.querySelectorAll('.formula-error-row'))
    expect(rows.length).toBe(1)
    expect(rows[0]!.textContent).toContain('line 2')
    expect(rows[0]!.textContent).toContain('Unknown function "ROUNDU"')
    expect(view.dom.querySelector('.code-lang-badge')?.textContent).toContain('1 error')
    view.destroy()
  })

  it('counts functions and errors in the badge', () => {
    const view = makeView('```edi-formula\nA(x) = x\nB(x) = x + 1\n```')
    expect(view.dom.querySelector('.code-lang-badge')?.textContent).toContain('2 functions')
    view.destroy()
  })

  it('updates the error rows while typing', () => {
    const view = makeView('```edi-formula\nA(x) = x + 1\n```')
    expect(view.dom.querySelector('.formula-error-row')).toBeNull()
    const cm = cmOf(view)
    cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: 'A(x) = x + 1\nBAD(x) = CONCAT(x,\n' } })
    const rows = Array.from(view.dom.querySelectorAll('.formula-error-row'))
    expect(rows.length).toBe(1)
    expect(rows[0]!.textContent).toContain('line 2')
    view.destroy()
  })
})