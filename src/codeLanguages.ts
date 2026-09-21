import type { Extension } from '@codemirror/state'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { ediFormulaLanguage } from './ediFormulaLanguage'

// A fenced code block's `language` attribute and the interpreter named by a
// runnable block's shebang both select a CodeMirror grammar via this table.
// The grammars are imported statically (never through runtime `import()`) so
// they land in the single bundle. Only languages worth editing get one of
// these; everything else falls back to the plain `<pre><code>` renderer.

export interface CodeLanguageInfo {
  /** Label shown in the code block's language badge. */
  label: string
  /** CodeMirror extension implementing the grammar. */
  extension: Extension
  /** True for `edi-formula` blocks, which also get live error rows. */
  formula: boolean
}

type LanguageFactory = () => Extension

export const CODE_LANGUAGE_ALIASES: Readonly<Record<string, LanguageFactory>> = {
  python: () => python(),
  python3: () => python(),
  py: () => python(),
  javascript: () => javascript({ jsx: true }),
  js: () => javascript({ jsx: true }),
  jsx: () => javascript({ jsx: true }),
  node: () => javascript(),
  nodejs: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  ts: () => javascript({ typescript: true }),
  markdown: () => markdown(),
  md: () => markdown(),
  json,
  css,
  html,
  xml,
  yaml: () => yaml(),
  yml: () => yaml(),
  sql,
  java,
  c: () => cpp(),
  cpp: () => cpp(),
  'c++': () => cpp(),
  cxx: () => cpp(),
  h: () => cpp(),
  hpp: () => cpp(),
  rust: () => rust(),
  rs: () => rust(),
  go,
  php,
  sh: () => StreamLanguage.define(shell),
  bash: () => StreamLanguage.define(shell),
  shell: () => StreamLanguage.define(shell),
  zsh: () => StreamLanguage.define(shell),
  'edi-formula': () => ediFormulaLanguage.extension,
}

/** The interpreter named on a runnable block's shebang line, if any
 * (`#!/usr/bin/env python3` → `python3`, `#!/bin/sh` → `sh`). */
export function shebangLanguage(text: string): string | null {
  const line = (text.split('\n', 1)[0] ?? '').trim()
  if (!line.startsWith('#!')) return null
  const parts = line.slice(2).trim().split(/\s+/)
  let name = (parts.shift() ?? '').split('/').pop() ?? ''
  if (name === 'env') {
    name = parts.find((part) => !part.startsWith('-')) ?? ''
  }
  return (name.split('/').pop() ?? '').replace(/\.exe$/, '').toLowerCase() || null
}

/** Resolve the grammar for a code block from its language tag first, then its
 * shebang. Returns null when the block should render as plain text. */
export function codeLanguageFor(
  language: string | null,
  text: string,
): CodeLanguageInfo | null {
  const tag = (language ?? '').trim().toLowerCase()
  if (tag) {
    const factory = CODE_LANGUAGE_ALIASES[tag]
    if (factory) {
      return { label: tag, extension: factory(), formula: tag === 'edi-formula' }
    }
  }
  const interpreter = shebangLanguage(text)
  if (interpreter) {
    const factory = CODE_LANGUAGE_ALIASES[interpreter]
    if (factory) return { label: interpreter, extension: factory(), formula: false }
  }
  return null
}