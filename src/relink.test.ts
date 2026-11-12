import { beforeEach, describe, expect, it } from 'vitest'
import { undo } from 'prosemirror-history'
import { createBlockEditor } from './editor'
import { rebaseDefinitions, rebaseReference } from './relink'

const FROM = '/home/reader/notes/draft.md'

describe('rebaseReference', () => {
  it('rebases a relative path into a sibling, a parent and a child folder', () => {
    expect(rebaseReference('img/a.png', FROM, '/home/reader/archive/draft.md')).toBe('../notes/img/a.png')
    expect(rebaseReference('img/a.png', FROM, '/home/reader/draft.md')).toBe('notes/img/a.png')
    expect(rebaseReference('../shared/a.png', FROM, '/home/reader/notes/old/draft.md')).toBe('../../shared/a.png')
    expect(rebaseReference('old/a.png', FROM, '/home/reader/notes/old/draft.md')).toBe('a.png')
  })

  it('keeps a fragment, a query and a trailing slash', () => {
    const to = '/home/reader/archive/draft.md'
    expect(rebaseReference('other.md#intro', FROM, to)).toBe('../notes/other.md#intro')
    expect(rebaseReference('a.png?v=2', FROM, to)).toBe('../notes/a.png?v=2')
    expect(rebaseReference('docs/', FROM, to)).toBe('../notes/docs/')
  })

  it('keeps a leading ./ while the target is still below the new folder', () => {
    expect(rebaseReference('./sub/a.png', FROM, '/home/reader/draft.md')).toBe('./notes/sub/a.png')
    expect(rebaseReference('./a.png', FROM, '/home/reader/archive/draft.md')).toBe('../notes/a.png')
  })

  it('leaves alone what is not a relative path', () => {
    const to = '/home/reader/archive/draft.md'
    for (const ref of ['', 'https://example.com/a.png', 'mailto:me@example.com', 'data:image/png;base64,AA', '/abs/a.png', '#section', '?q=1']) {
      expect(rebaseReference(ref, FROM, to)).toBe(ref)
    }
  })

  it('leaves a reference alone when the folder does not change', () => {
    expect(rebaseReference('./img/a.png', FROM, '/home/reader/notes/ideas.md')).toBe('./img/a.png')
    expect(rebaseReference('img/../a.png', FROM, '/home/reader/notes/ideas.md')).toBe('img/../a.png')
  })

  it('follows a link to the document itself to its new name', () => {
    expect(rebaseReference('draft.md#top', FROM, '/home/reader/notes/ideas.md')).toBe('ideas.md#top')
    expect(rebaseReference('draft.md', FROM, '/home/reader/archive/ideas.md')).toBe('ideas.md')
  })

  it('leaves alone a path that climbs above the root', () => {
    expect(rebaseReference('../../../../../a.png', FROM, '/home/draft.md')).toBe('../../../../../a.png')
  })
})

describe('rebaseDefinitions', () => {
  const to = '/home/reader/archive/draft.md'

  it('rebases a definition and keeps its title', () => {
    expect(rebaseDefinitions('[logo]: img/logo.png "The logo"', FROM, to)).toBe('[logo]: ../notes/img/logo.png "The logo"')
  })

  it('keeps an angle-bracketed destination bracketed', () => {
    expect(rebaseDefinitions('[a]: <my pics/a.png>', FROM, to)).toBe('[a]: <../notes/my pics/a.png>')
  })

  it('leaves URLs and footnotes alone', () => {
    expect(rebaseDefinitions('[site]: https://example.com', FROM, to)).toBe('[site]: https://example.com')
    expect(rebaseDefinitions('[^1]: see img/a.png', FROM, to)).toBe('[^1]: see img/a.png')
  })
})

describe('BlockEditor.rebaseLinks', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  const DOC = [
    '# Notes',
    '',
    'An ![image](img/a.png) and [a link](other.md), [the web](https://example.com) and [a ref][r].',
    '',
    'Untouched paragraph.',
    '',
    '```',
    '![code](img/a.png)',
    '```',
    '',
    '[r]: ref.md',
    '',
  ].join('\n')

  it('computes the moved document without changing the editor', () => {
    const editor = createBlockEditor(document.body, DOC)
    const before = editor.getView().state
    const rebased = editor.rebaseLinks(FROM, '/home/reader/archive/draft.md')!
    expect(editor.getView().state).toBe(before)
    expect(rebased.markdown).toContain('![image](../notes/img/a.png)')
    expect(rebased.markdown).toContain('[a link](../notes/other.md)')
    expect(rebased.markdown).toContain('[the web](https://example.com)')
    // A reference link stays a reference; its definition is what moves.
    expect(rebased.markdown).toContain('[a ref][r]')
    expect(rebased.markdown).toContain('[r]: ../notes/ref.md')
    // Code is text, not a reference.
    expect(rebased.markdown).toContain('```\n![code](img/a.png)\n```')
    expect(rebased.markdown).toContain('Untouched paragraph.')
    editor.destroy()
  })

  it('changes only the destinations: reference images and definition layout are kept', () => {
    const md = [
      'Images: ![full][logo], ![logo][], ![logo] and ![inline](img/a.png).',
      '',
      '[logo]: img/logo.png "The logo"',
      '[site]: https://example.com',
      '[r]: <my pics/r.png>',
      '',
    ].join('\n')
    const editor = createBlockEditor(document.body, md)
    const rebased = editor.rebaseLinks(FROM, '/home/reader/notes/drafts/draft.md')!
    expect(rebased.markdown).toBe([
      'Images: ![full][logo], ![logo][], ![logo] and ![inline](../img/a.png).',
      '',
      '[logo]: ../img/logo.png "The logo"',
      '[site]: https://example.com',
      '[r]: <../my pics/r.png>',
      '',
    ].join('\n'))
    editor.destroy()
  })

  it('applies outside the undo history', () => {
    const editor = createBlockEditor(document.body, DOC)
    const rebased = editor.rebaseLinks(FROM, '/home/reader/archive/draft.md')!
    expect(rebased.apply()).toBe(true)
    expect(editor.getMarkdown()).toBe(rebased.markdown)
    expect(undo(editor.getView().state)).toBe(false)
    editor.destroy()
  })

  it('rebases the current document when it changed before apply', () => {
    const editor = createBlockEditor(document.body, DOC)
    const rebased = editor.rebaseLinks(FROM, '/home/reader/archive/draft.md')!
    const view = editor.getView()
    view.dispatch(view.state.tr.insertText('New. ', 1))
    expect(rebased.apply()).toBe(false)
    expect(editor.getMarkdown()).toContain('New. ')
    expect(editor.getMarkdown()).toContain('![image](../notes/img/a.png)')
    editor.destroy()
  })

  it('is null when nothing moves', () => {
    const editor = createBlockEditor(document.body, 'Plain [web](https://example.com) text.')
    expect(editor.rebaseLinks(FROM, '/home/reader/archive/draft.md')).toBeNull()
    expect(editor.rebaseLinks(FROM, FROM)).toBeNull()
    editor.destroy()
  })
})
