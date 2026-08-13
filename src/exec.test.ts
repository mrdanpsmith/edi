import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

import { execLanguage, initExecBlocks, renderExecBlock } from './exec'

describe('execLanguage', () => {
  it('accepts a shebang in the fence info', () => {
    expect(execLanguage('#!python', 'print(1)')).toBe('#!python')
    expect(execLanguage('#!/usr/bin/env python3 ', 'print(1)')).toBe('#!/usr/bin/env python3')
    expect(execLanguage('#!sh', 'echo hi')).toBe('#!sh')
  })

  it('accepts a shebang on the first line of the block', () => {
    expect(execLanguage('', '#!/usr/bin/env python3\nprint(1)')).toBe('#!/usr/bin/env python3')
    expect(execLanguage('', '#!/bin/bash\necho hi')).toBe('#!/bin/bash')
  })

  it('returns null for non-exec fences', () => {
    expect(execLanguage('js', 'console.log(1)')).toBeNull()
    expect(execLanguage('', 'console.log(1)')).toBeNull()
    expect(execLanguage('mermaid', 'graph TD')).toBeNull()
    expect(execLanguage('', '')).toBeNull()
  })
})

describe('renderExecBlock', () => {
  it('renders source, a run button, and an output slot', () => {
    const html = renderExecBlock('#!/usr/bin/env python3', 'print(1)')
    expect(html).toContain('data-shebang="#!/usr/bin/env python3"')
    expect(html).toContain('>print(1)<')
    expect(html).toContain('class="exec-run"')
    expect(html).toContain('class="exec-output"')
  })

  it('escapes source and shebang', () => {
    const html = renderExecBlock('#!sh', 'echo "<x>&y"')
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
    container.innerHTML = renderExecBlock('#!sh', 'echo hello')
    initExecBlocks(container)

    const button = container.querySelector<HTMLButtonElement>('.exec-run')!
    button.click()
    await vi.waitFor(() => expect(button.textContent).toBe('Run'))

    const output = container.querySelector<HTMLElement>('.exec-output')!
    expect(output.textContent).toBe('hello')
    expect(output.hidden).toBe(false)
    expect(mockInvoke).toHaveBeenCalledWith('run_code_block', {
      shebang: '#!sh',
      source: 'echo hello',
    })
  })

  it('shows stderr and non-zero exit codes as errors', async () => {
    mockInvoke.mockResolvedValue({ exitCode: 3, stdout: '', stderr: 'boom', timedOut: false })
    const container = document.createElement('div')
    container.innerHTML = renderExecBlock('#!sh', 'exit 3')
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
    mockInvoke.mockRejectedValue(new Error('Unsupported interpreter: brainfuck'))
    const container = document.createElement('div')
    container.innerHTML = renderExecBlock('#!brainfuck', '+++')
    initExecBlocks(container)

    const button = container.querySelector<HTMLButtonElement>('.exec-run')!
    button.click()
    await vi.waitFor(() => expect(button.textContent).toBe('Run'))

    const output = container.querySelector<HTMLElement>('.exec-output')!
    expect(output.textContent).toContain('Unsupported interpreter: brainfuck')
    expect(output.classList.contains('exec-error')).toBe(true)
  })

  it('restores cached output without re-invoking', async () => {
    mockInvoke.mockResolvedValue({ exitCode: 0, stdout: 'cached value', stderr: '', timedOut: false })
    const source = 'echo cached unique'

    const first = document.createElement('div')
    first.innerHTML = renderExecBlock('#!sh', source)
    initExecBlocks(first)
    const firstButton = first.querySelector<HTMLButtonElement>('.exec-run')!
    firstButton.click()
    await vi.waitFor(() => expect(firstButton.textContent).toBe('Run'))
    expect(mockInvoke).toHaveBeenCalledTimes(1)

    const second = document.createElement('div')
    second.innerHTML = renderExecBlock('#!sh', source)
    initExecBlocks(second)
    const output = second.querySelector<HTMLElement>('.exec-output')!
    expect(output.textContent).toBe('cached value')
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('re-enables the button after completion', async () => {
    mockInvoke.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false })
    const container = document.createElement('div')
    container.innerHTML = renderExecBlock('#!sh', 'true')
    initExecBlocks(container)
    const button = container.querySelector<HTMLButtonElement>('.exec-run')!
    expect(button.disabled).toBe(false)
  })
})
