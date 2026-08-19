import { invoke } from './bridge'

import { escapeHtml } from './utils'

const EXEC_TIMEOUT_SECONDS = 30

export interface CodeResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface CachedOutput {
  result?: CodeResult
  error?: string
}

const outputCache = new Map<string, CachedOutput>()

export function execLanguage(info: string, source: string): string | null {
  const infoLine = info.trim()
  if (infoLine.startsWith('#!')) {
    return infoLine
  }
  const firstLine = source.split('\n', 1)[0]!
  return firstLine.startsWith('#!') ? firstLine : null
}

export function renderExecBlock(shebang: string, source: string): string {
  return `<div class="exec-block" data-shebang="${escapeHtml(shebang)}">
    <pre class="exec-source"><code>${escapeHtml(source)}</code></pre>
    <div class="exec-toolbar"><button type="button" class="exec-run">Run</button></div>
    <pre class="exec-output" hidden></pre>
  </div>`
}

export function initExecBlocks(container: HTMLElement): void {
  for (const block of Array.from(container.querySelectorAll<HTMLElement>('.exec-block'))) {
    const shebang = block.dataset['shebang'] ?? ''
    const source = block.querySelector<HTMLElement>('.exec-source code')?.textContent ?? ''
    const button = block.querySelector<HTMLButtonElement>('.exec-run')
    const output = block.querySelector<HTMLElement>('.exec-output')
    if (!button || !output) {
      continue
    }
    const key = `${shebang}\u0000${source}`
    const cached = outputCache.get(key)
    if (cached) {
      showOutput(output, cached)
    }
    button.addEventListener('click', () => {
      void runBlock(shebang, source, key, button, output)
    })
  }
}

async function runBlock(
  shebang: string,
  source: string,
  key: string,
  button: HTMLButtonElement,
  output: HTMLElement,
): Promise<void> {
  button.disabled = true
  button.textContent = 'Running…'
  output.hidden = false
  output.textContent = ''
  output.classList.remove('exec-error')
  try {
    const result = await invoke<CodeResult>('runCodeBlock', { shebang, source })
    const cached: CachedOutput = { result }
    outputCache.set(key, cached)
    showOutput(output, cached)
  } catch (error) {
    const cached: CachedOutput = { error: error instanceof Error ? error.message : String(error) }
    outputCache.set(key, cached)
    showOutput(output, cached)
  } finally {
    button.disabled = false
    button.textContent = 'Run'
  }
}

function showOutput(output: HTMLElement, cached: CachedOutput): void {
  const lines: string[] = []
  if (cached.error) {
    lines.push(`Error: ${cached.error}`)
  } else if (cached.result) {
    const { result } = cached
    if (result.stdout) {
      lines.push(result.stdout.replace(/\s+$/, ''))
    }
    if (result.stderr) {
      lines.push(result.stderr.replace(/\s+$/, ''))
    }
    if (result.timedOut) {
      lines.push(`Execution timed out after ${EXEC_TIMEOUT_SECONDS} seconds`)
    }
    if (result.exitCode && result.exitCode !== 0) {
      lines.push(`Process exited with code ${result.exitCode}`)
    }
  }
  output.textContent = lines.join('\n')
  output.classList.toggle(
    'exec-error',
    Boolean(cached.error) || (cached.result?.exitCode ?? 0) !== 0,
  )
}
