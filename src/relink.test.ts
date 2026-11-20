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

  describe('with an existence check', () => {
    const to = '/home/reader/docs/draft.md'
    const onDisk = new Set(['/home/reader/notes/img/a.png'])
    const exists = (target: string) => onDisk.has(target)

    it('rebases a reference whose target exists at the old location', () => {
      expect(rebaseReference('img/a.png', FROM, to, exists)).toBe('../notes/img/a.png')
    })

    it('leaves as written a reference that names nothing at the old location', () => {
      // The draft links the file it will sit beside once moved.
      expect(rebaseReference('block-modes.md', FROM, to, exists)).toBe('block-modes.md')
      expect(rebaseReference('missing/a.png#x', FROM, to, exists)).toBe('missing/a.png#x')
    })

    it('still follows a link to the document itself, which is never asked about', () => {
      const asked: string[] = []
      const record = (target: string) => { asked.push(target); return false }
      expect(rebaseReference('draft.md#top', FROM, '/home/reader/docs/ideas.md', record)).toBe('ideas.md#top')
      expect(asked).toEqual([])
    })
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

  // A definition is a raw code block whose text grows when rebased, which moves every
  // position after it: a link further down must still be found and rewritten.
  it('rebases a link that follows a definition the rebase made longer', () => {
    const md = '[r]: ref.md\n\nSee [a link](other.md) and ![img](img/a.png).\n'
    const editor = createBlockEditor(document.body, md)
    const rebased = editor.rebaseLinks(FROM, '/home/reader/archive/deeper/draft.md')!
    expect(rebased.markdown).toBe(
      '[r]: ../../notes/ref.md\n\nSee [a link](../../notes/other.md) and ![img](../../notes/img/a.png).\n',
    )
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

  it('lists every target the move needs answered, once each, and not the document itself', () => {
    const md = `${DOC}\nAgain ![image](img/a.png), and [me](draft.md).\n`
    const editor = createBlockEditor(document.body, md)
    expect(editor.rebaseTargets(FROM, '/home/reader/archive/draft.md').sort()).toEqual([
      '/home/reader/notes/img/a.png',
      '/home/reader/notes/other.md',
      '/home/reader/notes/ref.md',
    ])
    editor.destroy()
  })

  it('rebases only the references whose targets exist', () => {
    const editor = createBlockEditor(document.body, DOC)
    const onDisk = new Set(['/home/reader/notes/img/a.png'])
    const rebased = editor.rebaseLinks(FROM, '/home/reader/archive/draft.md', (t) => onDisk.has(t))!
    expect(rebased.markdown).toContain('![image](../notes/img/a.png)')
    // Named nothing at the old location: kept as the author wrote them.
    expect(rebased.markdown).toContain('[a link](other.md)')
    expect(rebased.markdown).toContain('[r]: ref.md')
    editor.destroy()
  })

  it('is null when no target exists', () => {
    const editor = createBlockEditor(document.body, DOC)
    expect(editor.rebaseLinks(FROM, '/home/reader/archive/draft.md', () => false)).toBeNull()
    editor.destroy()
  })
})
