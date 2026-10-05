import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete'
import { createBlockCodeMirror } from './codemirror-block'

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

function makeSourceEditor(onExit: (value: string) => void = () => {}) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return createBlockCodeMirror(parent, '', onExit)
}

function type(cm: ReturnType<typeof makeSourceEditor>, text: string): void {
  cm.view.dispatch({
    changes: { from: 0, insert: text },
    selection: { anchor: text.length },
  })
}

async function openCompletion(cm: ReturnType<typeof makeSourceEditor>): Promise<void> {
  cm.view.focus()
  startCompletion(cm.view)
  // The query runs on a microtask; give the plugin a couple of frames.
  for (let i = 0; i < 5 && completionStatus(cm.view.state) === 'pending'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('emoji completion in the block source editor', () => {
  it('offers the matched emoji with the glyph as its apply value', async () => {
    const cm = makeSourceEditor()
    type(cm, ':rocket')
    await openCompletion(cm)

    expect(completionStatus(cm.view.state)).toBe('active')
    // CodeMirror applies `apply` on accept, so this is what lands in the doc.
    expect(currentCompletions(cm.view.state)[0]).toMatchObject({ label: 'rocket', apply: '🚀' })
    cm.destroy()
  })

  it('does not open after a word character', async () => {
    const cm = makeSourceEditor()
    type(cm, '12:30')
    await openCompletion(cm)
    expect(completionStatus(cm.view.state)).not.toBe('active')
    cm.destroy()
  })

  it('Escape closes the list without exiting source mode', async () => {
    let exited = false
    const cm = makeSourceEditor(() => {
      exited = true
    })
    type(cm, ':ro')
    await openCompletion(cm)
    expect(completionStatus(cm.view.state)).toBe('active')

    cm.view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(completionStatus(cm.view.state)).not.toBe('active')
    expect(exited).toBe(false)
    cm.destroy()
  })
})
