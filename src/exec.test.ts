import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

import { execLanguage, initExecBlocks, renderExecBlock } from './exec'

describe('execLanguage', () => {
  it('extracts the kernel from a #! info string', () => {
    expect(execLanguage('#!python')).toBe('python')
    expect(execLanguage('#!sh ')).toBe('sh')
    expect(execLanguage('#!bash with a title')).toBe('bash')
  })

  it('returns null for non-exec fences', () => {
    expect(execLanguage('js')).toBeNull()
    expect(execLanguage('')).toBeNull()
    expect(execLanguage('mermaid')).toBeNull()
  })
})

describe('renderExecBlock', () => {
  it('renders source, a run button, and an output slot', () => {
    const html = renderExecBlock('sh', 'echo hi')
    expect(html).toContain('data-language="sh"')
    expect(html).toContain('>echo hi<')
    expect(html).toContain('class="exec-run"')
    expect(html).toContain('class="exec-output"')
  })

  it('escapes source and language', () => {
    const html = renderExecBlock('sh', 'echo "<x>&y"')
    expect(html).toContain('&lt;x&gt;&amp;y')
  })
})

describe('initExecBlocks', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('runs a block and shows stdout', async () => {
    mockInvoke.mockResolvedValue({ exitCode: 0, stdout: 'hello\n', stderr: '', timedOut: false })
    const container = document.createElement('div')
    container.innerHTML = renderExecBlock('sh', 'echo hello')
    initExecBlocks(container)

    const button = container.querySelector<HTMLButtonElement>('.exec-run')!
    button.click()
    await vi.waitFor(() => expect(button.textContent).toBe('Run'))

    const output = container.querySelector<HTMLElement>('.exec-output')!
    expect(output.textContent).toBe('hello')
    expect(output.hidden).toBe(false)
    expect(mockInvoke).toHaveBeenCalledWith('run_code_block', {
      language: 'sh',
      source: 'echo hello',
    })
  })

  it('shows stderr and non-zero exit codes as errors', async () => {
    mockInvoke.mockResolvedValue({ exitCode: 3, stdout: '', stderr: 'boom', timedOut: false })
    const container = document.createElement('div')
    container.innerHTML = renderExecBlock('sh', 'exit 3')
    initExecBlocks(container)

    const button = container.querySelector<HTMLButtonElement>('.exec-run')!
    button.click()
    await vi.waitFor(() => expect(button.textContent).toBe('Run'))

    const output = container.querySelector<HTMLElement>('.exec-output')!
    expect(output.textContent).toContain('boom')
    expect(output.textContent).toContain('code 3')
    expect(output.classList.contains('exec-error')).toBe(true)
  })

  it('reports invocation errors', async () => {
    mockInvoke.mockRejectedValue(new Error('Unsupported language: brainfuck'))
    const container = document.createElement('div')
    container.innerHTML = renderExecBlock('brainfuck', '+++')
    initExecBlocks(container)

    const button = container.querySelector<HTMLButtonElement>('.exec-run')!
    button.click()
    await vi.waitFor(() => expect(button.textContent).toBe('Run'))

    const output = container.querySelector<HTMLElement>('.exec-output')!
    expect(output.textContent).toContain('Unsupported language: brainfuck')
    expect(output.classList.contains('exec-error')).toBe(true)
  })

  it('restores cached output without re-invoking', async () => {
    mockInvoke.mockResolvedValue({ exitCode: 0, stdout: 'cached value', stderr: '', timedOut: false })
    const source = 'echo cached unique'

    const first = document.createElement('div')
    first.innerHTML = renderExecBlock('sh', source)
    initExecBlocks(first)
    const firstButton = first.querySelector<HTMLButtonElement>('.exec-run')!
    firstButton.click()
    await vi.waitFor(() => expect(firstButton.textContent).toBe('Run'))
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    const second = document.createElement('div')
    second.innerHTML = renderExecBlock('sh', source)
    initExecBlocks(second)
    const output = second.querySelector<HTMLElement>('.exec-output')!
    expect(output.textContent).toBe('cached value')
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('re-enables the button after completion', async () => {
    mockInvoke.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
    const container = document.createElement('div')
    container.innerHTML = renderExecBlock('sh', 'true')
    initExecBlocks(container)
    const button = container.querySelector<HTMLButtonElement>('.exec-run')!
    expect(button.disabled).toBe(false)
  })
})
