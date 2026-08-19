export const MERMAID_LANG = 'mermaid'
export const MERMAID_CLASS = 'mermaid'

export function collectPendingMermaid(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS}[data-state="pending"]`))
}

let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null

async function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      mod.default.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          fontFamily: 'var(--font-sans)',
          primaryColor: dark ? '#1d3a5f' : '#d6e4ff',
          primaryTextColor: dark ? '#e6edf3' : '#1f2328',
          primaryBorderColor: dark ? '#4d7bb5' : '#79b8ff',
          lineColor: dark ? '#8b949e' : '#57606a',
          secondaryColor: dark ? '#2f3a45' : '#f6f8fa',
          tertiaryColor: dark ? '#232a31' : '#eaeef2',
        },
      })
      return mod.default
    })
  }
  return mermaidPromise
}

function errorBlock(message: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `${MERMAID_CLASS}-error`
  const title = document.createElement('strong')
  title.textContent = 'Mermaid render error'
  const pre = document.createElement('pre')
  pre.textContent = message
  el.append(title, pre)
  return el
}

export async function renderPendingMermaid(container: HTMLElement): Promise<void> {
  const pending = collectPendingMermaid(container)
  if (pending.length === 0) {
    return
  }

  const mermaid = await loadMermaid()
  let seed = 0
  const now = Date.now()

  for (const el of pending) {
    const code = el.textContent ?? ''
    const id = `mermaid-${now}-${seed++}`

    try {
      const { svg } = await mermaid.render(id, code)
      const holder = document.createElement('div')
      holder.className = MERMAID_CLASS
      holder.dataset.state = 'done'
      holder.innerHTML = svg
      el.replaceWith(holder)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      el.replaceWith(errorBlock(message))
    }
  }
}

export function mermaidFenceTokens(source: string): string[] {
  const blocks: string[] = []
  const lines = source.split('\n')
  let index = 0
  while (index < lines.length) {
    const match = /^\s*```\s*(mermaid)\s*$/.exec(lines[index])
    if (match) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push(body.join('\n'))
    } else {
      index += 1
    }
  }
  return blocks
}
